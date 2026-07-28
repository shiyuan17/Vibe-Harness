import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { resolveModuleSelection } from '../scripts/lib/module-selection.js';
import {
  createToolProvisioningPlan,
  inspectProfileTools,
  provisionProfileTools,
} from '../scripts/lib/tool-provisioning.js';
import {
  resolveRtkAsset,
  verifyRtkChecksum,
} from '../runtime/tools/rtk/run.mjs';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '..');
const cliPath = path.join(rootDir, 'scripts/cognis.js');

async function runCli(args) {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], { cwd: rootDir });
  return JSON.parse(stdout);
}

test('rtk and ast-grep are independent optional modules', () => {
  const rtk = resolveModuleSelection({ requestedModules: ['rtk'] });
  const astGrep = resolveModuleSelection({ requestedModules: ['ast-grep'] });

  assert.deepEqual(rtk.resolvedModules, ['agents', 'rules', 'rtk']);
  assert.deepEqual(astGrep.resolvedModules, ['agents', 'rules', 'ast-grep']);
  assert.equal(rtk.allowedGroups.has('rules-rtk'), true);
  assert.equal(rtk.allowedGroups.has('tools-rtk'), true);
  assert.equal(astGrep.allowedGroups.has('rules-ast-grep'), true);
  assert.equal(astGrep.allowedGroups.has('tools-ast-grep'), true);
});

test('tool plugins appear in install dry-run without changing default profile modules', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-tool-modules-'));
  try {
    await runCli(['init', '--project', target]);
    const core = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core', '--dry-run',
    ]);
    assert.equal(core.plannedToolActions.some((item) => item.id === 'rtk'), false);
    assert.equal(core.plannedToolActions.some((item) => item.id === 'astGrep'), false);

    const selected = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', '-rtk', 'ast-grep', '--dry-run', '--verbose',
    ]);
    assert.deepEqual(selected.plannedToolActions.map((item) => item.id), ['rtk', 'astGrep']);
    assert.equal(selected.actions.some((item) => item.relativeTarget === 'docs/rules/rtk.md'), true);
    assert.equal(selected.actions.some((item) => item.relativeTarget === 'docs/rules/ast-grep.md'), true);
    assert.equal(selected.actions.some((item) => item.relativeTarget.endsWith('/rtk/run.mjs')), true);
    assert.equal(selected.actions.some((item) => item.relativeTarget.endsWith('/ast-grep/run.mjs')), true);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('tool inspection reports both optional tools as pending before provisioning', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-tool-inspection-'));
  try {
    const tools = await inspectProfileTools('core', target, ['agents', 'rules', 'rtk', 'ast-grep']);
    assert.equal(tools.rtk.status, 'pending');
    assert.equal(tools.rtk.version, '0.43.0');
    assert.equal(tools.astGrep.status, 'pending');
    assert.equal(tools.astGrep.version, '0.44.1');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('tool inspection synthesizes a pending state for a newly selected module', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-tool-new-module-'));
  try {
    const stateDir = path.join(target, '.cognis/tool-state');
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, 'tools.json'), `${JSON.stringify({
      fingerprints: {},
      tools: {
        rtk: { phase: 'install', status: 'degraded', version: '0.43.0' },
      },
    })}\n`, 'utf8');

    const tools = await inspectProfileTools('core', target, ['agents', 'rules', 'rtk', 'ast-grep']);
    assert.equal(tools.rtk.status, 'degraded');
    assert.equal(tools.astGrep.status, 'pending');
    assert.equal(tools.astGrep.version, '0.44.1');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('tool inspection degrades persisted ready tools when project-local binaries are missing', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-tool-missing-runtime-'));
  try {
    const stateDir = path.join(target, '.cognis/tool-state');
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, 'tools.json'), `${JSON.stringify({
      fingerprints: {},
      tools: {
        astGrep: { phase: 'ready', status: 'ready', version: '0.44.1' },
        rtk: { phase: 'ready', status: 'ready', version: '0.43.0' },
      },
    })}\n`, 'utf8');

    const tools = await inspectProfileTools('core', target, ['agents', 'rules', 'rtk', 'ast-grep']);
    assert.equal(tools.rtk.status, 'degraded');
    assert.equal(tools.rtk.code, 'RTK_RUNTIME_MISSING');
    assert.match(tools.rtk.diagnostic.message, /project-local RTK binary is missing/u);
    assert.equal(tools.astGrep.status, 'degraded');
    assert.equal(tools.astGrep.code, 'AST_GREP_RUNTIME_MISSING');
    assert.match(tools.astGrep.diagnostic.message, /project-local ast-grep binary is missing/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('tool inspection hashes runtimes without executing project binaries', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-tool-hash-mismatch-'));
  let inspectExecutions = 0;
  try {
    await runCli(['init', '--project', target]);
    await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', '-rtk', 'ast-grep', '--write',
    ]);
    const rtkBinary = path.join(target, '.agents/cognis/tools/rtk/bin', process.platform === 'win32' ? 'rtk.exe' : 'rtk');
    const astGrepBinary = path.join(target, '.agents/cognis/tools/ast-grep/node_modules/@ast-grep/cli', process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep');
    await provisionProfileTools({
      commandRunner: async (request) => {
        if (request.phase === 'binary-install' && request.component === 'rtk') {
          await mkdir(path.dirname(rtkBinary), { recursive: true });
          await writeFile(rtkBinary, 'verified rtk fixture', 'utf8');
        }
        if (request.phase === 'binary-install' && request.component === 'astGrep') {
          await mkdir(path.dirname(astGrepBinary), { recursive: true });
          await writeFile(astGrepBinary, 'verified ast-grep fixture', 'utf8');
        }
        return { stderr: '', stdout: '' };
      },
      profile: 'core',
      resolvedModules: ['agents', 'rules', 'rtk', 'ast-grep'],
      runtimeVersionRunner: async ({ command }) => ({
        stderr: '',
        stdout: command === rtkBinary ? 'rtk 0.43.0' : 'ast-grep 0.44.1',
      }),
      targetDir: target,
    });
    const validated = await runCli(['validate', '--project', target]);
    const doctor = await runCli(['doctor', '--project', target]);
    const baseline = await runCli(['baseline', '--project', target]);
    assert.equal(validated.tools.rtk.status, 'ready');
    assert.equal(validated.tools.astGrep.status, 'ready');
    assert.equal(doctor.tools.rtk.status, 'ready');
    assert.equal(doctor.tools.astGrep.status, 'ready');
    assert.equal(baseline.baseline.installation.tools.rtk.status, 'ready');
    assert.equal(baseline.baseline.installation.tools.astGrep.status, 'ready');
    assert.deepEqual(baseline.baseline.installation.requestedPlugins, ['rtk', 'ast-grep']);
    await writeFile(rtkBinary, 'tampered rtk fixture', 'utf8');
    await writeFile(astGrepBinary, 'tampered ast-grep fixture', 'utf8');

    const tools = await inspectProfileTools(
      'core',
      target,
      ['agents', 'rules', 'rtk', 'ast-grep'],
      undefined,
      {
        runtimeVersionRunner: async () => {
          inspectExecutions += 1;
          throw new Error('read-only inspection must not execute project binaries');
        },
      },
    );
    assert.equal(inspectExecutions, 0);
    assert.equal(tools.rtk.status, 'degraded');
    assert.equal(tools.rtk.code, 'RTK_BINARY_HASH_MISMATCH');
    assert.equal(tools.astGrep.status, 'degraded');
    assert.equal(tools.astGrep.code, 'AST_GREP_BINARY_HASH_MISMATCH');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('tool inspection reports RTK as unsupported on an unrecognized current platform', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-tool-unsupported-'));
  try {
    const tools = await inspectProfileTools(
      'core',
      target,
      ['agents', 'rules', 'rtk'],
      undefined,
      { platform: 'freebsd', arch: 'riscv64' },
    );
    assert.equal(tools.rtk.status, 'unsupported');
    assert.equal(tools.rtk.code, 'RTK_UNSUPPORTED_PLATFORM');
    assert.match(tools.rtk.diagnostic.message, /freebsd-riscv64/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('optional tool generated directories are owned by install state', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-tool-ownership-'));
  try {
    await runCli(['init', '--project', target]);
    await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', '-rtk', 'ast-grep', '--write',
    ]);
    const state = JSON.parse(await readFile(path.join(target, '.cognis/install-state.json'), 'utf8'));
    const generated = state.generatedDirectories.map((item) => item.target).sort();
    assert.ok(generated.includes('.agents/cognis/tools/rtk/bin'));
    assert.ok(generated.includes('.agents/cognis/tools/ast-grep/node_modules'));
    assert.ok(generated.includes('.cognis/tool-state/npm-cache/astGrep'));
    const summary = (await execFileAsync(process.execPath, [
      cliPath, 'doctor', '--project', target, '--output', 'summary',
    ], { cwd: rootDir })).stdout;
    assert.match(summary, /plugins: rtk,ast-grep/u);
    assert.match(summary, /tool: rtk[\s\S]*original command/u);
    assert.match(summary, /tool: astGrep[\s\S]*rg/u);
    assert.match(summary, /version: 0\.43\.0/u);
    assert.match(summary, new RegExp(`platform: ${process.platform}-${process.arch}`, 'u'));
    assert.match(summary, /source: github:rtk-ai\/rtk@v0\.43\.0/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('optional tool uninstall removes managed runtimes and preserves user files', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-tool-uninstall-'));
  const userFile = path.join(target, 'user-owned.txt');
  const generatedFiles = [
    path.join(target, '.agents/cognis/tools/rtk/bin/runtime.fixture'),
    path.join(target, '.agents/cognis/tools/ast-grep/node_modules/runtime.fixture'),
    path.join(target, '.cognis/tool-state/npm-cache/astGrep/cache.fixture'),
  ];
  try {
    await writeFile(userFile, 'keep me\n', 'utf8');
    await runCli(['init', '--project', target]);
    await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', '-rtk', 'ast-grep', '--write',
    ]);
    for (const file of generatedFiles) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, 'managed runtime fixture\n', 'utf8');
    }

    await runCli(['uninstall', '--project', target, '--write']);

    assert.equal(await readFile(userFile, 'utf8'), 'keep me\n');
    for (const file of generatedFiles) {
      await assert.rejects(readFile(file, 'utf8'), /ENOENT/u);
    }
    await assert.rejects(readFile(path.join(target, '.agents/cognis/tools/rtk/run.mjs'), 'utf8'), /ENOENT/u);
    await assert.rejects(readFile(path.join(target, '.agents/cognis/tools/ast-grep/run.mjs'), 'utf8'), /ENOENT/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('plugin none retires deselected wrappers, generated directories, and managed MCP servers', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-tool-clear-selection-'));
  const configPath = path.join(target, '.codex/config.toml');
  const rtkRuntime = path.join(target, '.agents/cognis/tools/rtk/bin/runtime.fixture');
  const chromeRuntime = path.join(target, '.agents/cognis/tools/chrome-devtools-mcp/node_modules/runtime.fixture');
  try {
    await runCli(['init', '--project', target]);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, 'model = "gpt-5"\n', 'utf8');
    await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', '-rtk', 'chrome-devtools-mcp', '--write', '--confirm-red-zone',
    ]);
    for (const file of [rtkRuntime, chromeRuntime]) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, 'managed runtime fixture\n', 'utf8');
    }

    const cleared = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', 'none', '--write', '--confirm-red-zone',
    ]);
    const config = await readFile(configPath, 'utf8');
    const state = JSON.parse(await readFile(path.join(target, '.cognis/install-state.json'), 'utf8'));

    assert.deepEqual(cleared.requestedPlugins, []);
    assert.deepEqual(state.requestedPlugins, []);
    assert.equal(config, 'model = "gpt-5"\n');
    assert.equal(state.files.some((file) => file.group === 'mcp-config' || file.group.startsWith('tools-')), false);
    assert.equal(state.generatedDirectories.length, 0);
    assert.doesNotMatch(await readFile(path.join(target, 'AGENTS.md'), 'utf8'), /RTK|Chrome DevTools|项目内工具位于/u);
    await assert.rejects(readFile(path.join(target, '.agents/cognis/tools/rtk/run.mjs'), 'utf8'), /ENOENT/u);
    await assert.rejects(readFile(path.join(target, '.agents/cognis/tools/chrome-devtools-mcp/run.mjs'), 'utf8'), /ENOENT/u);
    await assert.rejects(readFile(rtkRuntime, 'utf8'), /ENOENT/u);
    await assert.rejects(readFile(chromeRuntime, 'utf8'), /ENOENT/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('RTK asset resolution is pinned and rejects unsupported platforms', () => {
  const asset = resolveRtkAsset({ platform: 'win32', arch: 'x64' });
  assert.equal(asset.name, 'rtk-x86_64-pc-windows-msvc.zip');
  assert.match(asset.url, /releases\/download\/v0\.43\.0\//u);
  assert.throws(
    () => resolveRtkAsset({ platform: 'win32', arch: 'arm64' }),
    /unsupported RTK platform/u,
  );
});

test('RTK checksum verification detects tampered archives', async () => {
  assert.equal(await verifyRtkChecksum(Buffer.from('rtk'), '4b5a4f7f8f3c0e6e0f5e2c0e2e3f5e3b5b4f3cb9b8c6e3e7e4a4e6d0f6e2f6c2'), false);
});

test('tool provisioning plans expose the expected phases and versions', () => {
  const plan = createToolProvisioningPlan({
    profile: 'core',
    resolvedModules: ['agents', 'rules', 'rtk', 'ast-grep'],
    targetDir: path.resolve('tmp-target'),
  });
  assert.deepEqual(plan.map((item) => item.id), ['rtk', 'astGrep']);
  assert.deepEqual(plan.map((item) => item.version), ['0.43.0', '0.44.1']);
  assert.ok(plan.find((item) => item.id === 'rtk').phases.includes('binary-install'));
  assert.ok(plan.find((item) => item.id === 'astGrep').phases.includes('dependency-install'));
});

test('explicit tool provisioning uses project-local RTK and ast-grep phases', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-tool-provision-'));
  const calls = [];
  const rtkBinary = path.join(target, '.agents/cognis/tools/rtk/bin', process.platform === 'win32' ? 'rtk.exe' : 'rtk');
  const astGrepBinary = path.join(target, '.agents/cognis/tools/ast-grep/node_modules/@ast-grep/cli', process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep');
  const runtimeVersionRunner = async ({ command }) => ({
    stderr: '',
    stdout: command === rtkBinary ? 'rtk 0.43.0' : 'ast-grep 0.44.1',
  });
  try {
    const tools = await provisionProfileTools({
      commandRunner: async (request) => {
        calls.push({ args: request.args, component: request.component, phase: request.phase });
        if (request.phase === 'binary-install' && request.component === 'rtk') {
          await mkdir(path.dirname(rtkBinary), { recursive: true });
          await writeFile(rtkBinary, 'verified rtk fixture', 'utf8');
        }
        if (request.phase === 'binary-install' && request.component === 'astGrep') {
          await mkdir(path.dirname(astGrepBinary), { recursive: true });
          await writeFile(astGrepBinary, 'verified ast-grep fixture', 'utf8');
        }
        return { stderr: '', stdout: '' };
      },
      profile: 'core',
      resolvedModules: ['agents', 'rules', 'rtk', 'ast-grep'],
      runtimeVersionRunner,
      targetDir: target,
    });
    assert.equal(tools.rtk.status, 'ready');
    assert.equal(tools.rtk.source, 'github:rtk-ai/rtk@v0.43.0');
    assert.equal(tools.astGrep.status, 'ready');
    assert.deepEqual(calls.map((call) => [call.component, call.phase]), [
      ['rtk', 'binary-install'],
      ['astGrep', 'dependency-install'],
      ['astGrep', 'binary-install'],
    ]);
    assert.match(calls[0].args[0], /rtk[\\/]run\.mjs$/u);
    assert.match(calls[2].args[0], /ast-grep[\\/]node_modules[\\/]@ast-grep[\\/]cli[\\/]postinstall\.js$/u);
    const state = JSON.parse(await readFile(path.join(target, '.cognis/tool-state/tools.json'), 'utf8'));
    assert.equal(state.tools.rtk.status, 'ready');
    assert.equal(state.tools.astGrep.status, 'ready');
    assert.match(state.tools.rtk.binarySha256, /^[a-f0-9]{64}$/u);
    assert.match(state.tools.astGrep.binarySha256, /^[a-f0-9]{64}$/u);

    await provisionProfileTools({
      commandRunner: async () => ({ stderr: '', stdout: '' }),
      profile: 'core',
      resolvedModules: ['agents', 'rules', 'rtk', 'ast-grep'],
      runtimeVersionRunner,
      targetDir: target,
      toolIds: ['rtk'],
    });
    const retained = JSON.parse(await readFile(path.join(target, '.cognis/tool-state/tools.json'), 'utf8'));
    assert.deepEqual(Object.keys(retained.tools).sort(), ['astGrep', 'rtk']);
    assert.equal(retained.tools.astGrep.status, 'ready');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('optional tool provisioning rejects binaries with unexpected versions', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-tool-provision-version-'));
  const rtkBinary = path.join(target, '.agents/cognis/tools/rtk/bin', process.platform === 'win32' ? 'rtk.exe' : 'rtk');
  const astGrepBinary = path.join(target, '.agents/cognis/tools/ast-grep/node_modules/@ast-grep/cli', process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep');
  try {
    const tools = await provisionProfileTools({
      commandRunner: async (request) => {
        const binary = request.component === 'rtk' ? rtkBinary : astGrepBinary;
        if (request.phase === 'binary-install') {
          await mkdir(path.dirname(binary), { recursive: true });
          await writeFile(binary, 'unexpected version fixture', 'utf8');
        }
        return { stderr: '', stdout: '' };
      },
      profile: 'core',
      resolvedModules: ['agents', 'rules', 'rtk', 'ast-grep'],
      runtimeVersionRunner: async ({ command }) => ({
        stderr: '',
        stdout: command === rtkBinary ? 'rtk 0.42.0' : 'ast-grep 0.43.0',
      }),
      targetDir: target,
    });
    assert.equal(tools.rtk.status, 'degraded');
    assert.equal(tools.rtk.code, 'RTK_VERSION_MISMATCH');
    assert.equal(tools.astGrep.status, 'degraded');
    assert.equal(tools.astGrep.code, 'AST_GREP_VERSION_MISMATCH');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('RTK provisioning persists unsupported without invoking the installer', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-tool-provision-unsupported-'));
  const calls = [];
  try {
    const tools = await provisionProfileTools({
      arch: 'riscv64',
      commandRunner: async (request) => {
        calls.push(request);
        return { stderr: '', stdout: '' };
      },
      platform: 'freebsd',
      profile: 'core',
      resolvedModules: ['agents', 'rules', 'rtk'],
      targetDir: target,
    });

    assert.equal(calls.length, 0);
    assert.equal(tools.rtk.status, 'unsupported');
    assert.equal(tools.rtk.code, 'RTK_UNSUPPORTED_PLATFORM');
    assert.equal(tools.rtk.platform, 'freebsd-riscv64');
    assert.equal(tools.rtk.source, 'github:rtk-ai/rtk@v0.43.0');
    const state = JSON.parse(await readFile(path.join(target, '.cognis/tool-state/tools.json'), 'utf8'));
    assert.equal(state.tools.rtk.status, 'unsupported');
    assert.equal(state.tools.rtk.code, 'RTK_UNSUPPORTED_PLATFORM');
    assert.equal(state.tools.rtk.platform, 'freebsd-riscv64');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('failed optional-tool provisioning degrades health and allow-degraded preserves status', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-tool-degraded-'));
  const env = { ...process.env, COGNIS_TEST_OFFLINE: '1' };
  try {
    await runCli(['init', '--project', target]);
    await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', '-rtk', 'ast-grep', '--write',
    ]);
    let failure;
    try {
      await execFileAsync(process.execPath, [
        cliPath, 'provision', '--project', target, '--target', 'codex', '--profile', 'core', '--write',
      ], { cwd: rootDir, env });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    assert.equal(failure.code, 2);
    const degraded = JSON.parse(failure.stdout);
    assert.equal(degraded.status, 'degraded');
    assert.equal(degraded.tools.rtk.status, 'degraded');
    assert.equal(degraded.tools.astGrep.status, 'degraded');

    const allowed = JSON.parse((await execFileAsync(process.execPath, [
      cliPath, 'provision', '--project', target, '--target', 'codex', '--profile', 'core',
      '--write', '--force', '--allow-degraded',
    ], { cwd: rootDir, env })).stdout);
    assert.equal(allowed.ok, false);
    assert.equal(allowed.status, 'degraded');

    const doctor = JSON.parse((await execFileAsync(process.execPath, [
      cliPath, 'doctor', '--project', target, '--allow-degraded',
    ], { cwd: rootDir, env })).stdout);
    assert.equal(doctor.status, 'degraded');
    assert.equal(doctor.tools.rtk.status, 'degraded');
    assert.equal(doctor.tools.astGrep.status, 'degraded');
    assert.match(doctor.recommendations.find((item) => item.tool === 'rtk').message, /original command/u);
    assert.match(doctor.recommendations.find((item) => item.tool === 'astGrep').message, /rg/u);

    const baseline = await runCli(['baseline', '--project', target]);
    assert.equal(baseline.baseline.installation.tools.rtk.status, 'degraded');
    assert.equal(baseline.baseline.installation.tools.rtk.platform, `${process.platform}-${process.arch}`);
    assert.equal(baseline.baseline.installation.tools.rtk.source, 'github:rtk-ai/rtk@v0.43.0');
    assert.equal(baseline.baseline.installation.tools.astGrep.status, 'degraded');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
