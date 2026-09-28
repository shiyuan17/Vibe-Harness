import '../helpers/offline-tools.js';

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  applyInstallPlan,
  createMultiTargetInstallPlan,
  strictEnforcementWarnings,
} from '../../scripts/lib/install-planner.js';
import { resolveEnforcementPolicy, validateProjectConfig } from '../../scripts/lib/project-config.js';
import { blockingHookWarning, inspectRuntimeHooks, runtimeHookWarnings } from '../../scripts/lib/runtime-diagnostics.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '../..');
const cliPath = path.join(rootDir, 'scripts/vibe-harness.js');

async function adapterEntry(id) {
  const manifest = JSON.parse(await readFile(path.join(rootDir, 'manifests', 'adapters.json'), 'utf8'));
  const adapter = manifest.items.find((item) => item.id === id);
  assert.ok(adapter, 'adapter manifest entry: ' + id);
  return adapter;
}

/**
 * Fresh temp project with `init` applied and the enforcement policy (and
 * optional multi-target list) written into the config before any install, so
 * the projected AGENTS.md stays consistent with the config for verify runs.
 */
async function enforcementProject(adapterId, policy, { targets, withChecks = false } = {}) {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-enforcement-'));
  await execFileAsync(process.execPath, [
    cliPath, 'init', '--project', target, '--target', adapterId, '--profile', 'full',
  ]);
  const configPath = path.join(target, 'vibe-harness.config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.hooks = { ...config.hooks, enforcement: policy };
  if (targets) config.targets = [...targets];
  if (withChecks) {
    config.validationCommands = {
      ...config.validationCommands,
      lint: 'node -e 0',
      typecheck: 'node -e 0',
      test: 'node -e 0',
    };
  }
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return target;
}

test('envelopeSupport 显式报告宿主执行包络的降级状态', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-envelope-'));
  try {
    const codex = await adapterEntry('codex');
    const gemini = await adapterEntry('gemini');

    const codexReport = await inspectRuntimeHooks(codex, target);
    assert.deepEqual(codexReport.envelopeSupport, {
      degraded: false,
      highRiskEnforcement: 'host-required',
      versions: ['v1', 'v2'],
    });
    assert.equal(runtimeHookWarnings(codexReport).some((warning) => warning.code === 'ENVELOPE_UNSUPPORTED'), false);

    // A host with no declared execution envelope gets an explicit advisory
    // warning in every report; it never carries the blocking flag because the
    // decision to fail closed belongs to hooks.enforcement, not to the report.
    const geminiReport = await inspectRuntimeHooks(gemini, target);
    assert.deepEqual(geminiReport.envelopeSupport, {
      degraded: true,
      highRiskEnforcement: 'unsupported',
      versions: [],
    });
    for (const policy of ['advisory', 'strict']) {
      const warnings = runtimeHookWarnings(geminiReport, { enforcementPolicy: policy });
      const envelope = warnings.find((warning) => warning.code === 'ENVELOPE_UNSUPPORTED');
      assert.ok(envelope, 'ENVELOPE_UNSUPPORTED under ' + policy);
      assert.equal(envelope.blocking, undefined);
    }
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('HOOK_ACTIVATION_UNSUPPORTED 按宿主归因已落盘的 Hook 文件', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-hook-files-'));
  try {
    // Without hook files on disk the activation gap already shows through
    // runtimeHooks.activation; the extra warning has nothing to add.
    const gemini = await adapterEntry('gemini');
    const opencode = await adapterEntry('opencode');
    for (const adapter of [gemini, opencode]) {
      const bare = await inspectRuntimeHooks(adapter, target);
      assert.equal(bare.supported, false);
      assert.equal(bare.filesInstalled, false);
      assert.equal(runtimeHookWarnings(bare).some((warning) => warning.code === 'HOOK_ACTIVATION_UNSUPPORTED'), false);
    }

    // The hooks group on disk (a preview install, or a multi-target project
    // where another host owns the files) must not read as an active policy:
    // the warning names the host and stays advisory.
    const entryPath = path.join(target, '.agents', 'runtime', 'hooks', 'codex-hook.mjs');
    await mkdir(path.dirname(entryPath), { recursive: true });
    await writeFile(entryPath, '// hooks-group sentinel\n', 'utf8');
    for (const adapter of [gemini, opencode]) {
      const installed = await inspectRuntimeHooks(adapter, target);
      assert.equal(installed.filesInstalled, true);
      assert.equal(installed.host, adapter.id);
      const warning = runtimeHookWarnings(installed).find((item) => item.code === 'HOOK_ACTIVATION_UNSUPPORTED');
      assert.ok(warning, 'HOOK_ACTIVATION_UNSUPPORTED for ' + adapter.id);
      assert.match(warning.message, new RegExp(adapter.id, 'u'));
      assert.equal(warning.blocking, undefined);
    }

    // A supported host with the same files on disk never trips the warning.
    const codex = await adapterEntry('codex');
    const codexReport = await inspectRuntimeHooks(codex, target);
    assert.equal(codexReport.supported, true);
    assert.equal(codexReport.filesInstalled, true);
    assert.equal(runtimeHookWarnings(codexReport).some((item) => item.code === 'HOOK_ACTIVATION_UNSUPPORTED'), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('strict 策略把未证明的 Hook 执行从提示升级为阻断', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-strict-warning-'));
  try {
    const codex = await adapterEntry('codex');
    await mkdir(path.join(target, '.codex'), { recursive: true });
    await writeFile(path.join(target, '.codex', 'hooks.json'), '{}\n', 'utf8');

    const unverified = await inspectRuntimeHooks(codex, target);
    assert.equal(unverified.enforced, false);
    const advisory = runtimeHookWarnings(unverified).find((warning) => warning.code === 'HOOK_ENFORCEMENT_UNVERIFIED');
    assert.ok(advisory);
    assert.equal(advisory.blocking, undefined);
    assert.equal(blockingHookWarning(runtimeHookWarnings(unverified)), null);

    const strict = runtimeHookWarnings(unverified, { enforcementPolicy: 'strict' })
      .find((warning) => warning.code === 'HOOK_ENFORCEMENT_UNVERIFIED');
    assert.ok(strict);
    assert.equal(strict.blocking, true);
    assert.match(strict.message, /--allow-degraded/u);
    assert.equal(blockingHookWarning(runtimeHookWarnings(unverified, { enforcementPolicy: 'strict' })).code, 'HOOK_ENFORCEMENT_UNVERIFIED');

    // Proven enforcement silences the warning even under strict.
    const enforced = await inspectRuntimeHooks(codex, target, {
      hostEvidence: {
        activated: true,
        approval: true,
        envelopeRequired: true,
        network: true,
        process: true,
        sandbox: true,
      },
    });
    assert.equal(enforced.enforced, true);
    const enforcedWarnings = runtimeHookWarnings(enforced, { enforcementPolicy: 'strict' });
    assert.equal(enforcedWarnings.some((warning) => warning.code === 'HOOK_ENFORCEMENT_UNVERIFIED'), false);
    assert.equal(blockingHookWarning(enforcedWarnings), null);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('hooks.enforcement 只接受显式 advisory/strict', () => {
  assert.equal(resolveEnforcementPolicy(undefined), 'advisory');
  assert.equal(resolveEnforcementPolicy({}), 'advisory');
  assert.equal(resolveEnforcementPolicy({ hooks: {} }), 'advisory');
  assert.equal(resolveEnforcementPolicy({ hooks: { enforcement: 'advisory' } }), 'advisory');
  assert.equal(resolveEnforcementPolicy({ hooks: { enforcement: 'strict' } }), 'strict');
  const valid = {
    packageManager: 'pnpm@10.33.0',
    projectName: 'enforcement-fixture',
    profile: 'core',
    targets: ['codex'],
    validationCommands: {},
  };
  validateProjectConfig({ ...valid, hooks: { enforcement: 'strict' } });
  assert.throws(
    () => validateProjectConfig({ ...valid, hooks: { enforcement: 'hard' } }),
    /hooks\.enforcement/u,
  );
});

test('strict 红区拒绝按 owner-union 计算，advisory 从不拒绝', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-strict-plan-'));
  try {
    // Warnings derived from the refusal list are the blocking report surface.
    assert.deepEqual(strictEnforcementWarnings([]), []);
    const [denied] = strictEnforcementWarnings(['gemini']);
    assert.equal(denied.code, 'HIGH_RISK_WRITES_DENIED');
    assert.equal(denied.blocking, true);

    const base = {
      allowPreview: true,
      dryRun: true,
      profile: 'full',
      rootDir,
      targetDir: target,
    };

    const geminiStrict = await createMultiTargetInstallPlan({
      ...base,
      enforcementPolicy: 'strict',
      selectedTargets: ['gemini'],
      targets: ['gemini'],
    });
    assert.equal(geminiStrict.enforcementPolicy, 'strict');
    assert.deepEqual(geminiStrict.strictEnforcementRefusals, ['gemini']);

    // Regression: the aggregate refusal list is gated on the policy, so the
    // advisory default never refuses unsupported-envelope red-zone writes.
    const geminiAdvisory = await createMultiTargetInstallPlan({
      ...base,
      enforcementPolicy: 'advisory',
      selectedTargets: ['gemini'],
      targets: ['gemini'],
    });
    assert.deepEqual(geminiAdvisory.strictEnforcementRefusals, []);

    // A host with a declared envelope is never refused.
    const codexStrict = await createMultiTargetInstallPlan({
      ...base,
      enforcementPolicy: 'strict',
      selectedTargets: ['codex'],
      targets: ['codex'],
    });
    assert.deepEqual(codexStrict.strictEnforcementRefusals, []);

    // Owner-union: when an enforcing host co-owns the red-zone projections,
    // the unsupported host alone does not deny the writes.
    const mixedStrict = await createMultiTargetInstallPlan({
      ...base,
      enforcementPolicy: 'strict',
      selectedTargets: ['codex', 'gemini'],
      targets: ['codex', 'gemini'],
    });
    assert.deepEqual(mixedStrict.strictEnforcementRefusals, []);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('applyInstallPlan 在 strict 拒绝下中止真实写入且不落盘', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-strict-refusal-'));
  try {
    const plan = await createMultiTargetInstallPlan({
      allowPreview: true,
      dryRun: false,
      enforcementPolicy: 'strict',
      profile: 'full',
      rootDir,
      selectedTargets: ['gemini'],
      targetDir: target,
      targets: ['gemini'],
    });
    plan.redZoneConfirmed = true;
    await assert.rejects(
      applyInstallPlan(plan),
      /Refusing red-zone writes for gemini: hooks\.enforcement is "strict"/u,
    );
    await assert.rejects(readFile(path.join(target, '.githooks', 'pre-commit'), 'utf8'), /ENOENT/u);
    await assert.rejects(readFile(path.join(target, '.vibe-harness', 'install-state.json'), 'utf8'), /ENOENT/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('CLI gemini strict 预演报告拒绝清单并以 degraded 退出', async () => {
  const target = await enforcementProject('gemini', 'strict');
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [
        cliPath, 'install', '--project', target, '--target', 'gemini', '--profile', 'full',
        '--allow-preview', '--dry-run', '--output', 'json',
      ]),
      (error) => {
        assert.equal(error.code, 2);
        const report = JSON.parse(error.stdout);
        assert.equal(report.ok, false);
        assert.equal(report.status, 'degraded');
        assert.equal(report.enforcementPolicy, 'strict');
        assert.deepEqual(report.strictEnforcementRefusals, ['gemini']);
        const denied = report.warnings.find((warning) => warning.code === 'HIGH_RISK_WRITES_DENIED');
        assert.equal(denied.blocking, true);
        const envelope = report.warnings.find((warning) => warning.code === 'ENVELOPE_UNSUPPORTED');
        assert.equal(envelope.blocking, undefined);
        return true;
      },
    );
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('CLI gemini strict 真实写入被拒绝且不落盘', async () => {
  const target = await enforcementProject('gemini', 'strict');
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [
        cliPath, 'install', '--project', target, '--target', 'gemini', '--profile', 'full',
        '--allow-preview', '--write', '--confirm-red-zone', '--output', 'json',
      ]),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(String(error.stderr), /Refusing red-zone writes for gemini: hooks\.enforcement is/u);
        return true;
      },
    );
    await assert.rejects(readFile(path.join(target, '.githooks', 'pre-commit'), 'utf8'), /ENOENT/u);
    await assert.rejects(readFile(path.join(target, '.vibe-harness', 'install-state.json'), 'utf8'), /ENOENT/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('CLI gemini 默认 advisory 全量安装保持可用（回归）', async () => {
  const target = await enforcementProject('gemini', 'advisory');
  try {
    const result = await execFileAsync(process.execPath, [
      cliPath, 'install', '--project', target, '--target', 'gemini', '--profile', 'full',
      '--allow-preview', '--write', '--confirm-red-zone', '--output', 'json',
    ]);
    assert.equal(result.exitCode ?? 0, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.status, 'ready');
    assert.equal(report.enforcementPolicy, 'advisory');
    assert.deepEqual(report.strictEnforcementRefusals, []);
    assert.equal(report.warnings.some((warning) => warning.code === 'HIGH_RISK_WRITES_DENIED'), false);
    // The hooks group landed on disk under --allow-preview, but gemini's hook
    // mechanism is unsupported: every reporting command must attribute that
    // to the host instead of letting the files read as an active policy.
    const unsupported = report.warnings.find((warning) => warning.code === 'HOOK_ACTIVATION_UNSUPPORTED');
    assert.ok(unsupported, 'HOOK_ACTIVATION_UNSUPPORTED surfaces on gemini install');
    assert.match(unsupported.message, /gemini/u);
    assert.equal(unsupported.blocking, undefined);
    assert.equal(report.runtimeHooks.host, 'gemini');
    assert.equal(report.runtimeHooks.filesInstalled, true);
    const hook = await readFile(path.join(target, '.githooks', 'pre-commit'), 'utf8');
    assert.equal(hook.length > 0, true);

    const validation = await execFileAsync(process.execPath, [
      cliPath, 'validate', '--project', target, '--output', 'json',
    ]);
    const validated = JSON.parse(validation.stdout);
    assert.equal(validated.ok, true);
    assert.equal(validated.warnings.some((warning) => warning.code === 'HOOK_ACTIVATION_UNSUPPORTED'), true);

    const doctorRun = await execFileAsync(process.execPath, [
      cliPath, 'doctor', '--project', target, '--output', 'json',
    ]);
    const doctored = JSON.parse(doctorRun.stdout);
    assert.equal(doctored.warnings.some((warning) => warning.code === 'HOOK_ACTIVATION_UNSUPPORTED'), true);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('CLI codex strict 写入成功但以 degraded 退出，--allow-degraded 越过', async () => {
  const target = await enforcementProject('codex', 'strict');
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [
        cliPath, 'install', '--project', target, '--target', 'codex', '--profile', 'full',
        '--write', '--confirm-red-zone', '--output', 'json',
      ]),
      (error) => {
        assert.equal(error.code, 2);
        const report = JSON.parse(error.stdout);
        assert.equal(report.status, 'degraded');
        assert.deepEqual(report.strictEnforcementRefusals, []);
        const blocking = report.warnings.find((warning) => warning.code === 'HOOK_ENFORCEMENT_UNVERIFIED');
        assert.equal(blocking.blocking, true);
        assert.equal(report.runtimeHooks.envelopeSupport.degraded, false);
        return true;
      },
    );
    // The degraded exit is a status statement, not a write refusal.
    const hooks = await readFile(path.join(target, '.codex', 'hooks.json'), 'utf8');
    assert.equal(hooks.length > 0, true);

    const escape = await execFileAsync(process.execPath, [
      cliPath, 'install', '--project', target, '--target', 'codex', '--profile', 'full',
      '--write', '--confirm-red-zone', '--allow-degraded', '--output', 'json',
    ]);
    assert.equal(escape.exitCode ?? 0, 0);
    assert.equal(JSON.parse(escape.stdout).status, 'degraded');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('CLI 混合目标 strict 不拒绝共享红区写入（owner-union 负控）', async () => {
  const target = await enforcementProject('codex', 'strict', { targets: ['codex', 'gemini'] });
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [
        cliPath, 'install', '--project', target, '--allow-preview',
        '--write', '--confirm-red-zone', '--output', 'json',
      ]),
      (error) => {
        assert.equal(error.code, 2);
        const report = JSON.parse(error.stdout);
        assert.deepEqual(report.strictEnforcementRefusals, []);
        assert.equal(report.warnings.some((warning) => warning.code === 'HIGH_RISK_WRITES_DENIED'), false);
        return true;
      },
    );
    // Gemini's hook surface was written because codex co-owns it with an
    // enforcing envelope; the degraded exit comes from the unproven codex
    // enforcement, not from a refusal.
    const hook = await readFile(path.join(target, '.githooks', 'pre-commit'), 'utf8');
    assert.equal(hook.length > 0, true);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('CLI verify 在 strict 阻断下即使检查全绿也判 invalid', async () => {
  const target = await enforcementProject('codex', 'strict', { withChecks: true });
  try {
    await execFileAsync(process.execPath, [
      cliPath, 'install', '--project', target, '--target', 'codex', '--profile', 'full',
      '--write', '--confirm-red-zone', '--allow-degraded', '--output', 'json',
    ]);
    await assert.rejects(
      execFileAsync(process.execPath, [
        cliPath, 'verify', '--project', target, '--allow-manual', '--output', 'json',
      ]),
      (error) => {
        assert.equal(error.code, 1);
        const report = JSON.parse(error.stderr);
        assert.equal(report.ok, false);
        assert.equal(report.status, 'invalid');
        assert.equal(report.enforcementPolicy, 'strict');
        const blocking = report.warnings.find((warning) => warning.code === 'HOOK_ENFORCEMENT_UNVERIFIED');
        assert.equal(blocking.blocking, true);
        // The configured checks themselves passed; only the gate fails the run.
        assert.equal(report.results.lint.status, 'passed');
        return true;
      },
    );
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
