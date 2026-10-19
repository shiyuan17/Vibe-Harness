import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { FRESH_CONTEXT_MODES, hookDefinitionDrift, inspectFreshContext, inspectMemory, inspectRuntimeHookSelfCheck, inspectRuntimeHooks, runtimeHookWarnings } from '../../scripts/lib/runtime-diagnostics.js';
import { readHostHookState } from '../../scripts/lib/host-hook-state.js';

const execFileAsync = promisify(execFile);
const runtimeTarget = '.agents/memory/CURRENT.md';
const durableTarget = 'docs/memory/PROJECT_STATE.md';

function config(enabled = true) {
  return { memory: { enabled, path: '.agents/memory' } };
}

function state(...targets) {
  return { files: targets.map((target) => ({ target })) };
}

/**
 * A `.codex/hooks.json` that reproduces the pack's guarded-event surface. Codex
 * registers one catch-all `PreToolUse` entry only; registering a second
 * approval-time event would launch a redundant Hook process per tool call.
 */
function codexHookConfig(command = (event) => `node .agents/runtime/hooks/codex-hook.mjs --host codex --expected-event ${event}`) {
  return {
    hooks: {
      PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: command('PreToolUse'), timeout: 10 }] }],
    },
  };
}

function dateOffset(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function runtimeContent(date) {
  return '# Current\n\n- 目标: verify memory\n- 当前状态: active\n- 已验证证据: tests\n- 未完成事项: none\n- 下一步最小动作: finish\n- 最后更新: ' + date + '\n- 最后验证: ' + date + '\n';
}

function durableContent(date) {
  return '# Project state\n\n- 最后更新: ' + date + '\n- 当前阶段: implementation\n- 当前重点: diagnostics\n- 下一步动作: verify\n- 恢复提示: rerun tests\n';
}

async function writeMemories(target, runtime, durable) {
  await mkdir(path.join(target, '.agents/memory'), { recursive: true });
  await mkdir(path.join(target, 'docs/memory'), { recursive: true });
  await writeFile(path.join(target, runtimeTarget), runtime, 'utf8');
  await writeFile(path.join(target, durableTarget), durable, 'utf8');
}

test('memory diagnostics distinguish disabled, not-installed, missing, and empty', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-memory-basic-'));
  try {
    assert.deepEqual(await inspectMemory(config(false), null, target), {
      runtime: { path: runtimeTarget, status: 'disabled' },
      durable: { path: durableTarget, status: 'disabled' },
    });
    const absent = await inspectMemory(config(), null, target);
    assert.equal(absent.runtime.status, 'not-installed');
    assert.equal(absent.durable.status, 'not-installed');
    const missing = await inspectMemory(config(), state(runtimeTarget, durableTarget), target);
    assert.equal(missing.runtime.status, 'missing');
    assert.equal(missing.durable.status, 'missing');
    await writeMemories(target, '# Current\n- 最后验证: (YYYY-MM-DD)\n', '# State\n- 最后更新: (YYYY-MM-DD)\n');
    const empty = await inspectMemory(config(), state(runtimeTarget, durableTarget), target);
    assert.equal(empty.runtime.status, 'empty');
    assert.equal(empty.durable.status, 'empty');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('memory diagnostics distinguish invalid, stale, and current without writing files', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-memory-freshness-'));
  try {
    await writeMemories(target, runtimeContent('2026-99-99'), durableContent('not-a-date'));
    const invalid = await inspectMemory(config(), state(runtimeTarget, durableTarget), target);
    assert.equal(invalid.runtime.status, 'invalid');
    assert.equal(invalid.durable.status, 'invalid');

    await writeMemories(target, runtimeContent(dateOffset(-2)), durableContent(dateOffset(-31)));
    const stale = await inspectMemory(config(), state(runtimeTarget, durableTarget), target);
    assert.equal(stale.runtime.status, 'stale');
    assert.equal(stale.durable.status, 'stale');

    const today = dateOffset(0);
    await writeMemories(target, runtimeContent(today), durableContent(today));
    const before = createHash('sha256').update(await readFile(path.join(target, runtimeTarget))).digest('hex');
    const current = await inspectMemory(config(), state(runtimeTarget, durableTarget), target);
    const after = createHash('sha256').update(await readFile(path.join(target, runtimeTarget))).digest('hex');
    assert.equal(current.runtime.status, 'current');
    assert.equal(current.durable.status, 'current');
    assert.equal(after, before);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('runtime memory becomes stale when its verification date predates HEAD', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-memory-head-'));
  try {
    const today = dateOffset(0);
    const tomorrow = dateOffset(1) + 'T12:00:00Z';
    await writeMemories(target, runtimeContent(today), durableContent(today));
    await writeFile(path.join(target, 'tracked.txt'), 'tracked\n', 'utf8');
    await execFileAsync('git', ['init'], { cwd: target });
    await execFileAsync('git', ['config', 'user.email', 'memory-test@example.invalid'], { cwd: target });
    await execFileAsync('git', ['config', 'user.name', 'Memory Test'], { cwd: target });
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: target });
    await execFileAsync('git', ['commit', '-m', 'test: future head'], {
      cwd: target,
      env: { ...process.env, GIT_AUTHOR_DATE: tomorrow, GIT_COMMITTER_DATE: tomorrow },
    });
    const report = await inspectMemory(config(), state(runtimeTarget, durableTarget), target);
    assert.equal(report.runtime.status, 'stale');
    assert.equal(report.durable.status, 'current');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('runtime Hook enforcement requires independent host evidence', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-hook-evidence-'));
  try {
    const adapters = JSON.parse(await readFile(path.resolve('manifests/adapters.json'), 'utf8'));
    const adapter = adapters.items.find((item) => item.id === 'codex');
    // Enforcement is only provable for an installed handler that matches the
    // pack and is referenced by the host configuration.
    await mkdir(path.join(target, '.codex'), { recursive: true });
    await mkdir(path.join(target, '.agents', 'runtime', 'hooks'), { recursive: true });
    await cp(path.resolve('runtime/hooks'), path.join(target, '.agents', 'runtime', 'hooks'), { recursive: true });
    await writeFile(path.join(target, '.codex', 'hooks.json'), JSON.stringify(codexHookConfig(), null, 2) + '\n', 'utf8');

    const unverified = await inspectRuntimeHooks(adapter, target);
    assert.equal(unverified.enforced, false);
    assert.equal(unverified.executionAuthority.envelopeRequired, false);
    assert.equal(unverified.executionAuthority.hostContextVerified, false);
    assert.equal(runtimeHookWarnings(unverified).some((warning) => warning.code === 'HOOK_ENFORCEMENT_UNVERIFIED'), true);

    const enforced = await inspectRuntimeHooks(adapter, target, {
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
    assert.equal(enforced.status, 'enforced');
    assert.equal(enforced.activation.status, 'verified');
    assert.deepEqual(runtimeHookWarnings(enforced), []);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('Hook 自检拒绝缺失、漂移或未接线的已安装 handler', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-hook-wiring-'));
  try {
    const adapters = JSON.parse(await readFile(path.resolve('manifests/adapters.json'), 'utf8'));
    const adapter = adapters.items.find((item) => item.id === 'codex');
    await mkdir(path.join(target, '.codex'), { recursive: true });
    await mkdir(path.join(target, '.agents', 'runtime', 'hooks'), { recursive: true });
    const handler = path.join(target, '.agents/runtime/hooks/codex-hook.mjs');
    const wired = JSON.stringify(codexHookConfig(), null, 2) + '\n';
    const unwired = (event) => ({ status: 'degraded', code: 'HOOK_SELF_CHECK_CONFIG_UNWIRED', event });

    await writeFile(path.join(target, '.codex', 'hooks.json'), wired, 'utf8');
    assert.deepEqual(
      await inspectRuntimeHookSelfCheck(adapter, target, { configured: true }),
      { status: 'degraded', code: 'HOOK_SELF_CHECK_HANDLER_MISSING' },
    );

    await writeFile(handler, '// tampered handler\n', 'utf8');
    assert.deepEqual(
      await inspectRuntimeHookSelfCheck(adapter, target, { configured: true }),
      { status: 'degraded', code: 'HOOK_SELF_CHECK_HANDLER_DRIFT' },
    );

    // The self-check compares the whole installed Hook directory: the handler
    // imports the policy/context/envelope modules beside it, so the fixture
    // installs the pack's full surface.
    await cp(path.resolve('runtime/hooks'), path.join(target, '.agents', 'runtime', 'hooks'), { recursive: true });
    await writeFile(path.join(target, '.codex', 'hooks.json'), '{}\n', 'utf8');
    assert.deepEqual(
      await inspectRuntimeHookSelfCheck(adapter, target, { configured: true }),
      // An empty definition has no managed block at all, so no single event can
      // be named as the one that is unwired.
      { status: 'degraded', code: 'HOOK_SELF_CHECK_CONFIG_UNWIRED' },
    );

    // The entry module alone is not the handler: a missing dependency beside it
    // changes behavior, so the whole directory is compared.
    const dependency = path.join(target, '.agents/runtime/hooks/lib/policy.mjs');
    const dependencySource = await readFile(dependency, 'utf8');
    await rm(dependency, { force: true });
    assert.deepEqual(
      await inspectRuntimeHookSelfCheck(adapter, target, { configured: true }),
      { status: 'degraded', code: 'HOOK_SELF_CHECK_HANDLER_MISSING' },
    );
    await writeFile(dependency, `${dependencySource}\n`, 'utf8');
    assert.deepEqual(
      await inspectRuntimeHookSelfCheck(adapter, target, { configured: true }),
      { status: 'degraded', code: 'HOOK_SELF_CHECK_HANDLER_DRIFT' },
    );
    await cp(path.resolve('runtime/hooks'), path.join(target, '.agents', 'runtime', 'hooks'), { recursive: true });

    // A configuration the host cannot parse, and a command that only mentions
    // the path words without invoking the entry, are both unwired.
    await writeFile(path.join(target, '.codex', 'hooks.json'), '{ not json\n', 'utf8');
    assert.deepEqual(
      await inspectRuntimeHookSelfCheck(adapter, target, { configured: true }),
      { status: 'degraded', code: 'HOOK_SELF_CHECK_CONFIG_UNWIRED' },
    );
    await writeFile(path.join(target, '.codex', 'hooks.json'), JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo .agents runtime hooks codex-hook.mjs' }] }] },
    }, null, 2) + '\n', 'utf8');
    assert.deepEqual(
      await inspectRuntimeHookSelfCheck(adapter, target, { configured: true }),
      unwired('PreToolUse'),
    );

    // A managed command registered under the wrong event — or under an event
    // the host does not guard at all — is not wiring for the event that runs.
    await writeFile(path.join(target, '.codex', 'hooks.json'), JSON.stringify(codexHookConfig(
      () => 'node .agents/runtime/hooks/codex-hook.mjs --host codex --expected-event PermissionRequest',
    ), null, 2) + '\n', 'utf8');
    assert.deepEqual(
      await inspectRuntimeHookSelfCheck(adapter, target, { configured: true }),
      unwired('PreToolUse'),
    );
    await writeFile(path.join(target, '.codex', 'hooks.json'), JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'node .agents/runtime/hooks/codex-hook.mjs --host codex --expected-event PreToolUse', timeout: 10 }] }],
        PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'echo guard', timeout: 10 }] }],
      },
    }, null, 2) + '\n', 'utf8');
    assert.deepEqual(
      await inspectRuntimeHookSelfCheck(adapter, target, { configured: true }),
      unwired('PreToolUse'),
    );

    // The template's catch-all matcher is part of the guarded surface: a
    // `PreToolUse` entry narrowed to one tool leaves every other tool unguarded.
    await writeFile(path.join(target, '.codex', 'hooks.json'), JSON.stringify({
      hooks: {
        ...codexHookConfig().hooks,
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node .agents/runtime/hooks/codex-hook.mjs --host codex --expected-event PreToolUse', timeout: 10 }] }],
      },
    }, null, 2) + '\n', 'utf8');
    assert.deepEqual(
      await inspectRuntimeHookSelfCheck(adapter, target, { configured: true }),
      unwired('PreToolUse'),
    );

    // `timeout` is execution-critical: a handler the host kills before it
    // decides leaves the tool call unguarded.
    await writeFile(path.join(target, '.codex', 'hooks.json'), JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'node .agents/runtime/hooks/codex-hook.mjs --host codex --expected-event PreToolUse', timeout: 0 }] }],
      },
    }, null, 2) + '\n', 'utf8');
    assert.deepEqual(
      await inspectRuntimeHookSelfCheck(adapter, target, { configured: true }),
      unwired('PreToolUse'),
    );

    // A command that names the managed entry path by suffix only is not the
    // installed handler this project hashed, so it cannot count as wiring.
    await writeFile(path.join(target, '.codex', 'hooks.json'), JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'node /tmp/.agents/runtime/hooks/codex-hook.mjs --host codex --expected-event PreToolUse', timeout: 10 }] }],
      },
    }, null, 2) + '\n', 'utf8');
    assert.deepEqual(
      await inspectRuntimeHookSelfCheck(adapter, target, { configured: true }),
      unwired('PreToolUse'),
    );

    // Trailing shell syntax means the host runs something other than the
    // managed invocation this check parsed.
    await writeFile(path.join(target, '.codex', 'hooks.json'), JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'node .agents/runtime/hooks/codex-hook.mjs --host codex --expected-event PreToolUse > /tmp/out.txt', timeout: 10 }] }],
      },
    }, null, 2) + '\n', 'utf8');
    assert.deepEqual(
      await inspectRuntimeHookSelfCheck(adapter, target, { configured: true }),
      unwired('PreToolUse'),
    );

    await writeFile(path.join(target, '.codex', 'hooks.json'), wired, 'utf8');
    assert.equal((await inspectRuntimeHookSelfCheck(adapter, target, { configured: true })).status, 'pass');

    // The installer single-sources an inline bootstrap that assembles the entry
    // path from separately quoted segments, so that shipped shape has to count
    // as wiring as well.
    const bootstrap = await readFile(path.resolve('scripts/lib/hook-bootstrap.cjs'), 'utf8');
    await writeFile(path.join(target, '.codex', 'hooks.json'), JSON.stringify(codexHookConfig(
      (event) => `node -e "${bootstrap.replace(/\r?\n$/u, '')}" -- --expected-event ${event}`,
    ), null, 2) + '\n', 'utf8');
    assert.equal((await inspectRuntimeHookSelfCheck(adapter, target, { configured: true })).status, 'pass');
    // The prefix ends in `--`, so the payload has to be a separate token: a
    // concatenated `--expected-event` parses here while the shell hands Node a
    // longer token it never accepts, and the hook would not run at all.
    await writeFile(path.join(target, '.codex', 'hooks.json'), JSON.stringify(codexHookConfig(
      (event) => `node -e "${bootstrap.replace(/\r?\n$/u, '')}" ----expected-event ${event}`,
    ), null, 2) + '\n', 'utf8');
    const concatenated = await inspectRuntimeHookSelfCheck(adapter, target, { configured: true });
    assert.equal(concatenated.status, 'degraded');
    assert.equal(concatenated.code, 'HOOK_SELF_CHECK_CONFIG_UNWIRED');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('Hook 自检不把嵌套在别的仓库里的项目当作已接线', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vibe-harness-hook-nested-'));
  const target = path.join(root, 'project');
  try {
    await execFileAsync('git', ['init'], { cwd: root });
    const adapters = JSON.parse(await readFile(path.resolve('manifests/adapters.json'), 'utf8'));
    const adapter = adapters.items.find((item) => item.id === 'codex');
    await mkdir(path.join(target, '.codex'), { recursive: true });
    await mkdir(path.join(target, '.agents', 'runtime', 'hooks'), { recursive: true });
    await cp(path.resolve('runtime/hooks'), path.join(target, '.agents', 'runtime', 'hooks'), { recursive: true });
    const bootstrap = await readFile(path.resolve('scripts/lib/hook-bootstrap.cjs'), 'utf8');
    await writeFile(path.join(target, '.codex', 'hooks.json'), JSON.stringify(codexHookConfig(
      (event) => `node -e "${bootstrap.replace(/\r?\n$/u, '')}" -- --expected-event ${event}`,
    ), null, 2) + '\n', 'utf8');
    // The bootstrap walks up to the first `.git`, so a target nested inside an
    // outer repository would run that repository's handler while this check only
    // ever hashed the one under the target.
    const report = await inspectRuntimeHookSelfCheck(adapter, target, { configured: true });
    assert.equal(report.status, 'degraded', JSON.stringify(report));
    assert.equal(report.code, 'HOOK_SELF_CHECK_CONFIG_UNWIRED');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Hook 自检按规范事件名与模板 host 参数判定接线', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-hook-cursor-'));
  try {
    const adapters = JSON.parse(await readFile(path.resolve('manifests/adapters.json'), 'utf8'));
    const adapter = adapters.items.find((item) => item.id === 'cursor');
    await mkdir(path.join(target, '.cursor'), { recursive: true });
    await mkdir(path.join(target, '.agents', 'runtime', 'hooks'), { recursive: true });
    await cp(path.resolve('runtime/hooks'), path.join(target, '.agents', 'runtime', 'hooks'), { recursive: true });
    const write = async (command) => writeFile(path.join(target, '.cursor', 'hooks.json'),
      JSON.stringify({ preToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command, timeout: 10 }] }] }, null, 2) + '\n', 'utf8');
    // Cursor's configuration key is the camelCase alias; the runtime compares
    // its canonicalized payload against `--expected-event`, so the alias there
    // makes the installed hook fail open with HOOK_EVENT_MISMATCH.
    await write('node .agents/runtime/hooks/codex-hook.mjs --host cursor --expected-event preToolUse');
    assert.deepEqual(
      await inspectRuntimeHookSelfCheck(adapter, target, { configured: true }),
      { status: 'degraded', code: 'HOOK_SELF_CHECK_CONFIG_UNWIRED', event: 'preToolUse' },
    );
    // The templates that declare a host need it: an omitted `--host` changes
    // input normalization and the denial shape for every adapter but Codex.
    await write('node .agents/runtime/hooks/codex-hook.mjs --expected-event PreToolUse');
    assert.deepEqual(
      await inspectRuntimeHookSelfCheck(adapter, target, { configured: true }),
      { status: 'degraded', code: 'HOOK_SELF_CHECK_CONFIG_UNWIRED', event: 'preToolUse' },
    );
    await write('node .agents/runtime/hooks/codex-hook.mjs --host cursor --expected-event PreToolUse');
    const wired = await inspectRuntimeHookSelfCheck(adapter, target, { configured: true });
    assert.equal(wired.status, 'pass', JSON.stringify(wired));
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

function hostStateFixture(projectDir, { disabled = 0, enabled = 0 } = {}) {
  const prefix = path.join(projectDir, '.codex', 'hooks.json');
  const sections = [];
  for (let index = 0; index < disabled; index += 1) {
    sections.push(
      `[hooks.state.'${prefix}:pre_tool_use:${index}:0']`,
      `trusted_hash = "sha256:${String(index).repeat(64)}"`,
      'enabled = false',
      '',
    );
  }
  for (let index = 0; index < enabled; index += 1) {
    sections.push(
      `[hooks.state.'${prefix}:permission_request:${index}:0']`,
      `trusted_hash = "sha256:${String(index + 5).repeat(64)}"`,
      '',
    );
  }
  return sections.join('\n');
}

test('host Hook trust state is read from the host config without echoing its hash', async () => {
  const codexHome = await mkdtemp(path.join(tmpdir(), 'vibe-harness-codex-home-states-'));
  const projectDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-codex-project-'));
  const configPath = path.join(codexHome, 'config.toml');
  try {
    const missing = await readHostHookState({ adapterId: 'codex', env: { CODEX_HOME: codexHome }, projectDir });
    assert.equal(missing.status, 'unknown');
    assert.equal(missing.reason, 'config-missing');

    await writeFile(configPath, hostStateFixture(projectDir, { disabled: 2 }), 'utf8');
    const disabled = await readHostHookState({ adapterId: 'codex', env: { CODEX_HOME: codexHome }, projectDir });
    assert.equal(disabled.status, 'trusted-disabled');
    assert.equal(disabled.reason, 'entries-disabled');
    assert.deepEqual(disabled.entries, { disabled: 2, enabled: 0, total: 2, trusted: 2 });
    assert.equal(JSON.stringify(disabled).includes('trusted_hash'), false);
    assert.equal(JSON.stringify(disabled).includes('sha256:'), false);

    await writeFile(configPath, hostStateFixture(projectDir, { enabled: 2 }), 'utf8');
    const trusted = await readHostHookState({ adapterId: 'codex', env: { CODEX_HOME: codexHome }, projectDir });
    assert.equal(trusted.status, 'trusted-enabled');
    assert.equal(trusted.reason, 'entries-enabled');

    await writeFile(configPath, hostStateFixture(projectDir, { disabled: 1, enabled: 1 }), 'utf8');
    const mixed = await readHostHookState({ adapterId: 'codex', env: { CODEX_HOME: codexHome }, projectDir });
    assert.equal(mixed.status, 'trusted-disabled', '一个停用条目足以让策略不生效');
    assert.equal(mixed.reason, 'entries-partially-disabled');

    await writeFile(configPath, "[hooks.state.'C:\\Other\\project\\.codex\\hooks.json:pre_tool_use:0:0']\ntrusted_hash = \"sha256:aa\"\n", 'utf8');
    const other = await readHostHookState({ adapterId: 'codex', env: { CODEX_HOME: codexHome }, projectDir });
    assert.equal(other.status, 'untrusted');
    assert.equal(other.reason, 'no-entries');
  } finally {
    await rm(codexHome, { force: true, recursive: true });
    await rm(projectDir, { force: true, recursive: true });
  }
});

test('Hook trust re-review is reported only for a trusted host whose installed definition changed', async () => {
  const adapters = JSON.parse(await readFile(path.resolve('manifests/adapters.json'), 'utf8'));
  const adapter = adapters.items.find((item) => item.id === 'codex');
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-hook-rereview-'));
  try {
    const definition = path.join(target, '.codex', 'hooks.json');
    await mkdir(path.dirname(definition), { recursive: true });
    const written = '{"hooks":{}}\n';
    await writeFile(definition, written, 'utf8');
    const record = {
      files: [{
        target: '.codex/hooks.json',
        targetHash: createHash('sha256').update(Buffer.from(written, 'utf8')).digest('hex'),
      }],
    };

    // Silence is the default: a matching record, no record at all, a record for
    // another target, and a definition that is not installed are all not drift.
    assert.equal(await hookDefinitionDrift(adapter, target, record), false);
    assert.equal(await hookDefinitionDrift(adapter, target, null), false);
    assert.equal(await hookDefinitionDrift(adapter, target, { files: [{ target: 'docs/hooks.md' }] }), false);
    assert.equal(await hookDefinitionDrift(adapter, target, { files: [{ target: '.codex/hooks.json' }] }), false);

    // A definition rewritten after the recorded install no longer matches it.
    await writeFile(definition, '{"hooks":{"PreToolUse":[]}}\n', 'utf8');
    assert.equal(await hookDefinitionDrift(adapter, target, record), true);

    const trusted = await inspectRuntimeHooks(adapter, target, { hostHookState: { status: 'trusted-enabled' } });
    const warned = runtimeHookWarnings(trusted, { definitionChanged: true }).map((warning) => warning.code);
    assert.equal(warned.includes('HOOK_TRUST_REREVIEW_REQUIRED'), true);
    const unreported = runtimeHookWarnings(trusted).map((warning) => warning.code);
    assert.equal(unreported.includes('HOOK_TRUST_REREVIEW_REQUIRED'), false);

    // A switched-off, untrusted, or unreadable host already has a sharper
    // warning, and the re-review hint never claims the host will ask for trust.
    for (const status of ['trusted-disabled', 'untrusted', 'unknown']) {
      const report = await inspectRuntimeHooks(adapter, target, { hostHookState: { status } });
      const codes = runtimeHookWarnings(report, { definitionChanged: true }).map((warning) => warning.code);
      assert.equal(codes.includes('HOOK_TRUST_REREVIEW_REQUIRED'), false, status);
    }
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('fresh-context diagnostics never promote an inherited or unverified host to independent review', () => {
  const adapter = (freshContext, subagents = 'stable') => ({ capabilities: { subagents }, freshContext, id: 'fixture' });

  // An undeclared capability stays fail-closed instead of defaulting to a fresh
  // context: only a host that really starts a non-inheriting context may host an
  // independent review.
  const undeclared = inspectFreshContext({ capabilities: { subagents: 'stable' }, id: 'fixture' });
  assert.equal(undeclared.mode, 'unavailable');
  assert.equal(undeclared.independentReviewSupported, false);
  assert.deepEqual(undeclared.messages.map((item) => item.code), ['FRESH_CONTEXT_UNDECLARED']);

  const inherited = inspectFreshContext(adapter({ evidence: 'configured-unverified', mode: 'inherited' }));
  assert.equal(inherited.independentReviewSupported, false);
  assert.deepEqual(inherited.messages.map((item) => item.code), ['FRESH_CONTEXT_INHERITED_ONLY']);

  // A host that can start an isolated context still cannot back
  // `contextIndependence=verified` until the declaration carries host evidence.
  const unverified = inspectFreshContext(adapter({ evidence: 'configured-unverified', mode: 'isolated' }));
  assert.equal(unverified.independentReviewSupported, false);
  assert.deepEqual(unverified.messages.map((item) => item.code), ['FRESH_CONTEXT_UNVERIFIED']);

  const verified = inspectFreshContext(adapter({ evidence: 'verified', mode: 'isolated' }));
  assert.equal(verified.independentReviewSupported, true);
  assert.deepEqual(verified.messages, []);

  const unavailable = inspectFreshContext(adapter({ evidence: 'configured-unverified', mode: 'unavailable' }, 'unsupported'));
  assert.deepEqual(unavailable.messages.map((item) => item.code), ['FRESH_CONTEXT_UNAVAILABLE']);
});

test('fresh-context diagnostics reject a declaration that contradicts the subagents level', () => {
  const contradictory = [
    { capabilities: { subagents: 'unsupported' }, freshContext: { evidence: 'configured-unverified', mode: 'isolated' } },
    { capabilities: { subagents: 'stable' }, freshContext: { evidence: 'configured-unverified', mode: 'unavailable' } },
    { capabilities: { subagents: 'stable' }, freshContext: { evidence: 'verified', mode: 'forked' } },
  ];
  for (const adapter of contradictory) {
    const report = inspectFreshContext(adapter);
    assert.equal(report.independentReviewSupported, false);
    assert.equal(report.messages.length, 1, JSON.stringify(adapter));
    assert.ok(
      ['FRESH_CONTEXT_CONTRADICTS_SUBAGENTS', 'FRESH_CONTEXT_UNDECLARED'].includes(report.messages[0].code),
      report.messages[0].code,
    );
  }
});

test('every adapter declares a fresh-context mode consistent with its declared subagents level', async () => {
  const adapters = JSON.parse(await readFile(path.resolve('manifests/adapters.json'), 'utf8'));
  assert.ok(adapters.items.length > 0);
  for (const adapter of adapters.items) {
    const report = inspectFreshContext(adapter);
    assert.equal(report.host, adapter.id);
    assert.ok(FRESH_CONTEXT_MODES.includes(report.mode), `${adapter.id}: ${report.mode}`);
    // A contradictory or undeclared capability has to surface as a finding; the
    // remaining codes only describe an honest, still-unverified declaration.
    const findings = report.messages
      .map((item) => item.code)
      .filter((code) => code === 'FRESH_CONTEXT_CONTRADICTS_SUBAGENTS' || code === 'FRESH_CONTEXT_UNDECLARED');
    assert.deepEqual(findings, [], adapter.id);
    assert.equal(
      report.independentReviewSupported,
      report.mode === 'isolated' && report.evidence === 'verified',
      adapter.id,
    );
  }
});

test('the runtime diagnostics entry surfaces the declared fresh-context capability', async () => {
  const adapters = JSON.parse(await readFile(path.resolve('manifests/adapters.json'), 'utf8'));
  const adapter = adapters.items.find((item) => item.id === 'codex');
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-fresh-context-'));
  try {
    const report = await inspectRuntimeHooks(adapter, target);
    assert.deepEqual(report.freshContext, inspectFreshContext(adapter));
    assert.equal(report.freshContext.host, 'codex');
    assert.equal(report.freshContext.mode, 'isolated');
    assert.equal(report.freshContext.independentReviewSupported, false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('activation status reports host trust and warns when the Hook is switched off', async () => {
  const adapters = JSON.parse(await readFile(path.resolve('manifests/adapters.json'), 'utf8'));
  const adapter = adapters.items.find((item) => item.id === 'codex');
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-hook-trust-'));
  try {
    await mkdir(path.join(target, '.codex'), { recursive: true });
    await writeFile(path.join(target, '.codex', 'hooks.json'), '{}\n', 'utf8');
    const states = [
      { expected: 'trusted-enabled', hostHookState: { status: 'trusted-enabled' }, code: 'HOOK_ACTIVATION_UNVERIFIED' },
      { expected: 'trusted-disabled', hostHookState: { status: 'trusted-disabled' }, code: 'HOOK_DISABLED' },
      { expected: 'untrusted', hostHookState: { status: 'untrusted' }, code: 'HOOK_ACTIVATION_UNVERIFIED' },
      { expected: 'unknown', hostHookState: { status: 'stale-value' }, code: 'HOOK_ACTIVATION_UNVERIFIED' },
    ];
    for (const state of states) {
      const report = await inspectRuntimeHooks(adapter, target, { hostHookState: state.hostHookState });
      assert.equal(report.activation.status, state.expected, state.expected);
      assert.equal(report.activation.verification.length > 0, true, state.expected);
      if (state.code === 'HOOK_DISABLED') {
        assert.match(report.activation.verification, /\/hooks/u);
      }
      const codes = runtimeHookWarnings(report).map((warning) => warning.code);
      assert.equal(codes.includes(state.code), true, state.expected + ' -> ' + state.code);
      assert.equal(codes.includes('HOOK_ACTIVATION_UNVERIFIED'), state.code === 'HOOK_ACTIVATION_UNVERIFIED', state.expected);
      assert.equal(JSON.stringify(report.hostHookState).includes('trusted_hash'), false);
    }
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
