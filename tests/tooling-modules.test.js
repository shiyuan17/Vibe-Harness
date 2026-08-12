import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
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
  acquireRtkInstallLock,
  createRtkDispatcher,
  downloadRtkResponse,
  fetchRtkAsset,
  parseRetryAfter,
  resolveRtkAsset,
  verifyRtkChecksum,
} from '../runtime/tools/rtk/run.mjs';
import { buildRtkRuntimeEnvironment, prepareRtkRuntimeEnvironment } from '../runtime/lib/rtk-environment.mjs';
import { normalizeAstGrepArgs } from '../runtime/tools/ast-grep/args.mjs';
import { componentEnvironment, phaseRequest, resolveAstGrepPlatformPackage } from '../scripts/lib/tool-provisioning/environment.js';
import { publicFailure } from '../scripts/lib/tool-provisioning/runtime-probe.js';
import { writeToolState } from '../scripts/lib/tool-provisioning/tool-state.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '..');
const cliPath = path.join(rootDir, 'scripts/vibe-harness.js');

async function seedAstGrepNativePackage(toolDir, { arch = process.arch, platform = process.platform, libc } = {}) {
  const nativePackage = resolveAstGrepPlatformPackage({ arch, libc, platform });
  if (!nativePackage) return;
  const packageDir = path.join(toolDir, 'node_modules', nativePackage);
  await mkdir(packageDir, { recursive: true });
  await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: nativePackage, version: '0.45.1' }) + '\n', 'utf8');
}

test('ast-grep wrapper normalizes documented and native command forms', () => {
  assert.deepEqual(normalizeAstGrepArgs(['sg', '--pattern', 'call($A)']), ['--pattern', 'call($A)']);
  assert.deepEqual(normalizeAstGrepArgs(['ast-grep', '--pattern', 'call($A)']), ['--pattern', 'call($A)']);
  assert.deepEqual(normalizeAstGrepArgs(['run', '--pattern', 'call($A)']), ['run', '--pattern', 'call($A)']);
  assert.deepEqual(normalizeAstGrepArgs(['--help']), ['--help']);
  assert.deepEqual(normalizeAstGrepArgs([]), []);
  assert.deepEqual(normalizeAstGrepArgs(['scan', '--config', 'sgconfig.yml']), ['scan', '--config', 'sgconfig.yml']);
  assert.deepEqual(normalizeAstGrepArgs(['outline', 'src']), ['outline', 'src']);
  assert.deepEqual(normalizeAstGrepArgs(['test']), ['test']);
  assert.deepEqual(normalizeAstGrepArgs(['run', '--debug-query=ast']), ['run', '--debug-query=ast']);
  assert.deepEqual(normalizeAstGrepArgs(['--', 'future-command']), ['--', 'future-command']);
  assert.deepEqual(normalizeAstGrepArgs(['future-command']), ['future-command']);
});

async function runCli(args) {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], { cwd: rootDir });
  return JSON.parse(stdout);
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function closeServer(server) {
  server.closeAllConnections?.();
  server.close();
  await once(server, 'close');
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
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tool-modules-'));
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
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tool-inspection-'));
  try {
    const tools = await inspectProfileTools('core', target, ['agents', 'rules', 'rtk', 'ast-grep']);
    assert.equal(tools.rtk.status, 'pending');
    assert.equal(tools.rtk.version, '0.45.0');
    assert.equal(tools.astGrep.status, 'pending');
    assert.equal(tools.astGrep.version, '0.45.1');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('tool inspection synthesizes a pending state for a newly selected module', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tool-new-module-'));
  try {
    const stateDir = path.join(target, '.vibe-harness/tool-state');
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, 'tools.json'), `${JSON.stringify({
      fingerprints: {},
      tools: {
        rtk: { phase: 'install', status: 'degraded', version: '0.45.0' },
      },
    })}\n`, 'utf8');

    const tools = await inspectProfileTools('core', target, ['agents', 'rules', 'rtk', 'ast-grep']);
    assert.equal(tools.rtk.status, 'degraded');
    assert.equal(tools.astGrep.status, 'pending');
    assert.equal(tools.astGrep.version, '0.45.1');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('tool inspection degrades persisted ready tools when project-local binaries are missing', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tool-missing-runtime-'));
  try {
    const stateDir = path.join(target, '.vibe-harness/tool-state');
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, 'tools.json'), `${JSON.stringify({
      fingerprints: {},
      tools: {
        astGrep: { phase: 'ready', status: 'ready', version: '0.45.1' },
        rtk: { phase: 'ready', status: 'ready', version: '0.45.0' },
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
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tool-hash-mismatch-'));
  let inspectExecutions = 0;
  try {
    await runCli(['init', '--project', target]);
    await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', '-rtk', 'ast-grep', '--rtk-hooks', 'off', '--write',
    ]);
    const rtkBinary = path.join(target, '.agents/runtime/tools/rtk/bin', process.platform === 'win32' ? 'rtk.exe' : 'rtk');
    const astGrepBinary = path.join(target, '.agents/runtime/tools/ast-grep/node_modules/@ast-grep/cli', process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep');
    await provisionProfileTools({
      commandRunner: async (request) => {
        if (request.component === 'astGrep') await seedAstGrepNativePackage(path.join(target, '.agents/runtime/tools/ast-grep'));
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
        stdout: command === rtkBinary ? 'rtk 0.45.0' : 'ast-grep 0.45.1',
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
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tool-unsupported-'));
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
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tool-ownership-'));
  try {
    await runCli(['init', '--project', target]);
    await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', '-rtk', 'ast-grep', '--rtk-hooks', 'off', '--write',
    ]);
    const state = JSON.parse(await readFile(path.join(target, '.vibe-harness/install-state.json'), 'utf8'));
    const generated = state.generatedDirectories.map((item) => item.target).sort();
    assert.ok(generated.includes('.agents/runtime/tools/rtk/bin'));
    assert.ok(generated.includes('.agents/runtime/tools/rtk/node_modules'));
    assert.ok(generated.includes('.agents/runtime/tools/ast-grep/node_modules'));
    assert.ok(generated.includes('.vibe-harness/tool-state/rtk'));
    assert.ok(generated.includes('.vibe-harness/tool-state/npm-cache/rtk'));
    assert.ok(generated.includes('.vibe-harness/tool-state/npm-cache/astGrep'));
    const summary = (await execFileAsync(process.execPath, [
      cliPath, 'doctor', '--project', target, '--output', 'summary',
    ], { cwd: rootDir })).stdout;
    assert.match(summary, /plugins: rtk,ast-grep/u);
    assert.match(summary, /tool: rtk[\s\S]*original command/u);
    assert.match(summary, /tool: astGrep[\s\S]*rg/u);
    assert.match(summary, /version: 0\.45\.0/u);
    assert.match(summary, new RegExp(`platform: ${process.platform}-${process.arch}`, 'u'));
    assert.match(summary, /source: github:rtk-ai\/rtk@v0\.45\.0/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('optional tool uninstall removes managed runtimes and preserves user files', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tool-uninstall-'));
  const userFile = path.join(target, 'user-owned.txt');
  const generatedFiles = [
    path.join(target, '.agents/runtime/tools/rtk/bin/runtime.fixture'),
    path.join(target, '.agents/runtime/tools/ast-grep/node_modules/runtime.fixture'),
    path.join(target, '.vibe-harness/tool-state/npm-cache/astGrep/cache.fixture'),
  ];
  try {
    await writeFile(userFile, 'keep me\n', 'utf8');
    await runCli(['init', '--project', target]);
    await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', '-rtk', 'ast-grep', '--rtk-hooks', 'off', '--write',
    ]);
    for (const file of generatedFiles) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, 'managed runtime fixture\n', 'utf8');
    }

    await runCli(['uninstall', '--project', target, '--all-targets', '--write']);

    assert.equal(await readFile(userFile, 'utf8'), 'keep me\n');
    for (const file of generatedFiles) {
      await assert.rejects(readFile(file, 'utf8'), /ENOENT/u);
    }
    await assert.rejects(readFile(path.join(target, '.agents/runtime/tools/rtk/run.mjs'), 'utf8'), /ENOENT/u);
    await assert.rejects(readFile(path.join(target, '.agents/runtime/tools/ast-grep/run.mjs'), 'utf8'), /ENOENT/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('plugin none retires deselected wrappers, generated directories, and managed MCP servers', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tool-clear-selection-'));
  const configPath = path.join(target, '.codex/config.toml');
  const rtkRuntime = path.join(target, '.agents/runtime/tools/rtk/bin/runtime.fixture');
  const chromeRuntime = path.join(target, '.agents/runtime/tools/chrome-devtools-mcp/node_modules/runtime.fixture');
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
    const state = JSON.parse(await readFile(path.join(target, '.vibe-harness/install-state.json'), 'utf8'));

    assert.deepEqual(cleared.requestedPlugins, []);
    assert.deepEqual(state.requestedPlugins, []);
    assert.equal(config, 'model = "gpt-5"\n');
    assert.equal(state.files.some((file) => file.group === 'mcp-config' || file.group.startsWith('tools-')), false);
    assert.equal(state.generatedDirectories.length, 0);
    assert.doesNotMatch(await readFile(path.join(target, 'AGENTS.md'), 'utf8'), /RTK|Chrome DevTools|项目内工具位于/u);
    await assert.rejects(readFile(path.join(target, '.agents/runtime/tools/rtk/run.mjs'), 'utf8'), /ENOENT/u);
    await assert.rejects(readFile(path.join(target, '.agents/runtime/tools/chrome-devtools-mcp/run.mjs'), 'utf8'), /ENOENT/u);
    await assert.rejects(readFile(rtkRuntime, 'utf8'), /ENOENT/u);
    await assert.rejects(readFile(chromeRuntime, 'utf8'), /ENOENT/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('RTK asset resolution is pinned and rejects unsupported platforms', () => {
  const asset = resolveRtkAsset({ platform: 'win32', arch: 'x64' });
  assert.equal(asset.name, 'rtk-x86_64-pc-windows-msvc.zip');
  assert.match(asset.url, /releases\/download\/v0\.45\.0\//u);
  assert.throws(
    () => resolveRtkAsset({ platform: 'win32', arch: 'arm64' }),
    /unsupported RTK platform/u,
  );
});

test('RTK checksum verification detects tampered archives', async () => {
  assert.equal(await verifyRtkChecksum(Buffer.from('rtk'), '4b5a4f7f8f3c0e6e0f5e2c0e2e3f5e3b5b4f3cb9b8c6e3e7e4a4e6d0f6e2f6c2'), false);
});

test('ast-grep public failures retain supported diagnostic codes and statuses', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-ast-grep-public-failure-'));
  const [spec] = createToolProvisioningPlan({
    profile: 'core',
    resolvedModules: ['agents', 'rules', 'ast-grep'],
    targetDir: target,
  });
  try {
    const unsupported = publicFailure(
      spec,
      'dependency-install',
      Object.assign(new Error('unsupported fixture'), { code: 'AST_GREP_UNSUPPORTED_PLATFORM' }),
      target,
      { arch: 'riscv64', platform: 'freebsd' },
    );
    const missingOptionalPackage = publicFailure(
      spec,
      'dependency-install',
      Object.assign(new Error('optional package fixture'), { code: 'AST_GREP_OPTIONAL_PACKAGE_MISSING' }),
      target,
      {
        env: {
          npm_config_registry: 'https://alice%40corp:pass%3Aword@registry.example.test/private?signature=registry-secret#fragment',
        },
      },
    );

    assert.equal(unsupported.code, 'AST_GREP_UNSUPPORTED_PLATFORM');
    assert.equal(unsupported.status, 'unsupported');
    assert.equal(missingOptionalPackage.code, 'AST_GREP_OPTIONAL_PACKAGE_MISSING');
    assert.equal(missingOptionalPackage.status, 'degraded');
    assert.equal(missingOptionalPackage.diagnostic.provisioning.registry, 'https://registry.example.test');
    assert.doesNotMatch(JSON.stringify(missingOptionalPackage), /alice|pass%3Aword|registry-secret|signature|fragment/u);
    const invalidRegistry = publicFailure(
      spec,
      'dependency-install',
      Object.assign(new Error('invalid registry fixture'), { code: 'AST_GREP_OPTIONAL_PACKAGE_MISSING' }),
      target,
      { env: { npm_config_registry: 'file:///private/registry?token=registry-secret' } },
    );
    assert.equal(invalidRegistry.diagnostic.provisioning.registry, '<invalid-registry>');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('tool state and doctor outputs sanitize structured registry diagnostics', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-registry-diagnostic-'));
  const secretRegistry = 'https://alice%40corp:pass%3Aword@registry.example.test/private?signature=registry-secret#fragment';
  try {
    await runCli(['init', '--project', target]);
    await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', '-rtk', 'ast-grep', '--rtk-hooks', 'off', '--write',
    ]);
    await writeToolState(target, {
      astGrep: {
        code: 'AST_GREP_OPTIONAL_PACKAGE_MISSING',
        diagnostic: {
          code: 'AST_GREP_OPTIONAL_PACKAGE_MISSING',
          message: 'Bearer registry-secret client_secret=registry-secret failed at ' + secretRegistry,
          phase: 'dependency-install',
          provisioning: { registry: secretRegistry },
          truncated: false,
        },
        phase: 'dependency-install',
        status: 'degraded',
        version: '0.45.1',
      },
    }, {});

    const stateText = await readFile(path.join(target, '.vibe-harness/tool-state/tools.json'), 'utf8');
    assert.match(stateText, /https:\/\/registry\.example\.test/u);
    assert.match(stateText, /Bearer \[REDACTED\]/u);
    assert.doesNotMatch(stateText, /alice|pass%3Aword|registry-secret|signature|fragment/u);

    const doctor = await runCli(['doctor', '--project', target, '--allow-degraded']);
    const doctorText = JSON.stringify(doctor);
    assert.equal(doctor.tools.astGrep.diagnostic.provisioning.registry, 'https://registry.example.test');
    assert.doesNotMatch(doctorText, /alice|pass%3Aword|registry-secret|signature|fragment/u);
    assert.doesNotMatch(JSON.stringify(doctor.warnings), /alice|pass%3Aword|registry-secret|signature|fragment/u);
    assert.doesNotMatch(JSON.stringify(doctor.recommendations), /alice|pass%3Aword|registry-secret|signature|fragment/u);
    const summary = (await execFileAsync(process.execPath, [
      cliPath, 'doctor', '--project', target, '--allow-degraded', '--output', 'summary',
    ], { cwd: rootDir })).stdout;
    assert.match(summary, /https:\/\/registry\.example\.test/u);
    assert.doesNotMatch(summary, /alice|pass%3Aword|registry-secret|signature|fragment/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('RTK runtime environment confines state without replacing the user home', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-rtk-state-'));
  try {
    const input = {
      HOME: 'C:\\Users\\fixture',
      RTK_DB_PATH: 'C:\\outside\\history.db',
      RTK_TEE: '1',
      RTK_TELEMETRY_DISABLED: '0',
      USERPROFILE: 'C:\\Users\\fixture',
    };
    const env = buildRtkRuntimeEnvironment(target, input);
    assert.equal(env.HOME, input.HOME);
    assert.equal(env.USERPROFILE, input.USERPROFILE);
    assert.equal(env.RTK_TEE, '0');
    assert.equal(env.RTK_TELEMETRY_DISABLED, '1');
    assert.equal(env.RTK_DB_PATH, path.join(target, '.vibe-harness/tool-state/rtk/history.db'));
    assert.equal(env.RTK_TEE_DIR, path.join(target, '.vibe-harness/tool-state/rtk/tee'));
    await prepareRtkRuntimeEnvironment(target, input);
    assert.equal((await stat(path.join(target, '.vibe-harness/tool-state/rtk/tee'))).isDirectory(), true);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('RTK download retries transient failures and preserves diagnostics', async () => {
  let calls = 0;
  const response = { body: {}, ok: true, status: 200 };
  const result = await fetchRtkAsset('https://example.test/rtk.zip', {
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } });
      return response;
    },
    waitImpl: async () => {},
  });
  assert.equal(result, response);
  assert.equal(calls, 2);

  await assert.rejects(
    fetchRtkAsset('https://example.test/rtk.zip', {
      attempts: 2,
      fetchImpl: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } }); },
      waitImpl: async () => {},
    }),
    /after 2 attempts: ETIMEDOUT/u,
  );
});

test('RTK download honors Retry-After, limits retry statuses, and redacts raw errors', async () => {
  const delays = [];
  let calls = 0;
  const response = await fetchRtkAsset('https://example.test/rtk.zip', {
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('', { headers: { 'retry-after': '3' }, status: 429 });
      }
      return new Response('rtk', { status: 200 });
    },
    randomImpl: () => 0.99,
    waitImpl: async (delay) => { delays.push(delay); },
  });
  assert.equal(await response.text(), 'rtk');
  assert.deepEqual(delays, [3000]);
  assert.equal(parseRetryAfter('2', 0), 2000);
  assert.equal(parseRetryAfter('invalid', 0), null);

  const jitterDelays = [];
  let transientCalls = 0;
  const recovered = await fetchRtkAsset('https://example.test/rtk.zip', {
    fetchImpl: async () => {
      transientCalls += 1;
      return transientCalls === 1
        ? new Response('', { status: 503 })
        : new Response('recovered', { status: 200 });
    },
    randomImpl: () => 0.5,
    waitImpl: async (delay) => { jitterDelays.push(delay); },
  });
  assert.equal(await recovered.text(), 'recovered');
  assert.deepEqual(jitterDelays, [125]);

  for (const status of [501, 505]) {
    let permanentCalls = 0;
    await assert.rejects(
      fetchRtkAsset('https://user:secret@example.test/rtk.zip', {
        fetchImpl: async () => {
          permanentCalls += 1;
          return new Response('', { status });
        },
      }),
      (error) => error.code === 'RTK_DOWNLOAD_FAILED'
        && error.message.includes('HTTP ' + status)
        && error.message.includes('example.test')
        && !error.message.includes('secret'),
    );
    assert.equal(permanentCalls, 1);
  }

  await assert.rejects(
    fetchRtkAsset('https://example.test/rtk.zip', {
      fetchImpl: async () => {
        throw Object.assign(new Error('proxy https://user:secret@proxy.test failed'), { cause: { code: 'ETIMEDOUT' } });
      },
      attempts: 1,
    }),
    (error) => error.code === 'RTK_DOWNLOAD_FAILED'
      && error.message.includes('ETIMEDOUT')
      && !error.message.includes('secret'),
  );
});

test('RTK download enforces declared and streamed byte limits', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-rtk-size-'));
  try {
    await assert.rejects(
      downloadRtkResponse(
        new Response('abcd', { headers: { 'content-length': '4' } }),
        path.join(target, 'declared.bin'),
        { maxBytes: 3 },
      ),
      (error) => error.code === 'RTK_DOWNLOAD_TOO_LARGE',
    );
    await assert.rejects(
      downloadRtkResponse(new Response('abcd'), path.join(target, 'stream.bin'), { maxBytes: 3 }),
      (error) => error.code === 'RTK_DOWNLOAD_TOO_LARGE',
    );
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('RTK install lock serializes callers and recovers stale locks', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-rtk-lock-'));
  try {
    const release = await acquireRtkInstallLock(target);
    let now = Date.now();
    await assert.rejects(
      acquireRtkInstallLock(target, {
        nowImpl: () => now,
        waitImpl: async () => { now += 10; },
        waitMs: 10,
      }),
      (error) => error.code === 'RTK_INSTALL_LOCK_TIMEOUT',
    );
    await release();

    const releaseFirst = await acquireRtkInstallLock(target);
    let polls = 0;
    const releaseSecond = await acquireRtkInstallLock(target, {
      waitImpl: async () => {
        polls += 1;
        await releaseFirst();
      },
      waitMs: 1000,
    });
    assert.equal(polls, 1);
    await releaseSecond();

    const lockPath = path.join(target, '.install.lock');
    await writeFile(lockPath, 'stale\n', 'utf8');
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    const releaseRecovered = await acquireRtkInstallLock(target, { staleMs: 1000 });
    await releaseRecovered();
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('RTK dispatcher uses proxy variables and honors NO_PROXY', async () => {
  let proxyConnections = 0;
  const targetServer = createServer((request, response) => { response.end('direct'); });
  const proxyServer = createServer();
  proxyServer.on('connect', (request, clientSocket, head) => {
    proxyConnections += 1;
    const separator = request.url.lastIndexOf(':');
    const host = request.url.slice(0, separator);
    const port = Number(request.url.slice(separator + 1));
    const targetSocket = connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) targetSocket.write(head);
      targetSocket.pipe(clientSocket);
      clientSocket.pipe(targetSocket);
    });
    targetSocket.on('error', () => clientSocket.destroy());
  });
  const targetPort = await listen(targetServer);
  const proxyPort = await listen(proxyServer);
  const targetUrl = 'http://127.0.0.1:' + targetPort + '/rtk.zip';
  const proxyUrl = 'http://127.0.0.1:' + proxyPort;
  let dispatcher;
  let bypassDispatcher;
  let httpsDispatcher;
  try {
    dispatcher = await createRtkDispatcher({ HTTP_PROXY: proxyUrl });
    const proxied = await fetchRtkAsset(targetUrl, { attempts: 1, dispatcher });
    assert.equal(await proxied.text(), 'direct');
    assert.equal(proxyConnections, 1);

    bypassDispatcher = await createRtkDispatcher({ http_proxy: proxyUrl, no_proxy: '127.0.0.1' });
    const direct = await fetchRtkAsset(targetUrl, { attempts: 1, dispatcher: bypassDispatcher });
    assert.equal(await direct.text(), 'direct');
    assert.equal(proxyConnections, 1);

    httpsDispatcher = await createRtkDispatcher({ HTTPS_PROXY: proxyUrl });
    assert.ok(httpsDispatcher);

    await assert.rejects(
      createRtkDispatcher({ HTTP_PROXY: 'http://user:secret@[invalid' }),
      (error) => error.code === 'RTK_PROXY_CONFIG_INVALID'
        && !error.message.includes('secret')
        && !error.message.includes('user'),
    );
  } finally {
    await Promise.allSettled([dispatcher?.close?.(), bypassDispatcher?.close?.(), httpsDispatcher?.close?.()]);
    await Promise.all([closeServer(proxyServer), closeServer(targetServer)]);
  }
});

test('ast-grep provisioning defaults to the lockfile registry and permits an explicit override', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-ast-grep-env-'));
  const specs = createToolProvisioningPlan({
    profile: 'core',
    resolvedModules: ['agents', 'rules', 'rtk', 'ast-grep'],
    targetDir: target,
  });
  const spec = specs.find((item) => item.id === 'astGrep');
  const rtkSpec = specs.find((item) => item.id === 'rtk');
  try {
    const defaultEnv = await componentEnvironment(spec, target, { HOME: 'C:\\Users\\fixture' });
    assert.equal(defaultEnv.npm_config_registry, 'https://registry.npmjs.org/');
    assert.equal(defaultEnv.npm_config_include, 'optional');
    assert.equal(defaultEnv.npm_config_optional, 'true');
    const overriddenEnv = await componentEnvironment(spec, target, {
      HOME: 'C:\\Users\\fixture',
      npm_config_registry: 'https://registry.example.test/',
    });
    assert.equal(overriddenEnv.npm_config_registry, 'https://registry.example.test/');
    const rtkEnv = await componentEnvironment(rtkSpec, target, {
      HTTPS_PROXY: 'https://proxy.example.test/',
      NODE_EXTRA_CA_CERTS: 'C:\\Users\\fixture\\ca.pem',
      NODE_USE_ENV_PROXY: '0',
    });
    assert.equal(rtkEnv.NODE_USE_ENV_PROXY, '0');
    assert.equal(rtkEnv.NODE_EXTRA_CA_CERTS, 'C:\\Users\\fixture\\ca.pem');
    assert.equal(rtkEnv.npm_config_registry, 'https://registry.npmjs.org/');
    const defaultRtkEnv = await componentEnvironment(rtkSpec, target, {});
    assert.equal(defaultRtkEnv.NODE_USE_ENV_PROXY, undefined);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('ast-grep dependency provisioning explicitly includes platform optional packages', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-ast-grep-command-'));
  const specs = createToolProvisioningPlan({
    profile: 'core',
    resolvedModules: ['agents', 'rules', 'ast-grep'],
    targetDir: target,
  });
  const spec = specs.find((item) => item.id === 'astGrep');
  try {
    const request = await phaseRequest(spec, 'dependency-install', target, {});
    assert.ok(request.args.includes('--include=optional'));
    assert.equal(request.args.includes('--os=win32'), false);
    assert.equal(request.args.includes('--cpu=x64'), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('ast-grep resolves native packages for supported platform and architecture combinations', () => {
  const cases = [
    [{ platform: 'win32', arch: 'x64' }, '@ast-grep/cli-win32-x64-msvc'],
    [{ platform: 'win32', arch: 'arm64' }, '@ast-grep/cli-win32-arm64-msvc'],
    [{ platform: 'linux', arch: 'x64', libc: 'gnu' }, '@ast-grep/cli-linux-x64-gnu'],
    [{ platform: 'linux', arch: 'arm64', libc: 'gnu' }, '@ast-grep/cli-linux-arm64-gnu'],
    [{ platform: 'darwin', arch: 'x64' }, '@ast-grep/cli-darwin-x64'],
    [{ platform: 'darwin', arch: 'arm64' }, '@ast-grep/cli-darwin-arm64'],
  ];
  for (const [input, expected] of cases) assert.equal(resolveAstGrepPlatformPackage(input), expected);
  assert.equal(resolveAstGrepPlatformPackage({ platform: 'linux', arch: 'x64', libc: 'musl' }), null);
  assert.equal(resolveAstGrepPlatformPackage({ platform: 'freebsd', arch: 'x64' }), null);
});

test('tool provisioning plans expose the expected phases and versions', () => {
  const plan = createToolProvisioningPlan({
    profile: 'core',
    resolvedModules: ['agents', 'rules', 'rtk', 'ast-grep'],
    targetDir: path.resolve('tmp-target'),
  });
  assert.deepEqual(plan.map((item) => item.id), ['rtk', 'astGrep']);
  assert.deepEqual(plan.map((item) => item.version), ['0.45.0', '0.45.1']);
  assert.ok(plan.find((item) => item.id === 'rtk').phases.includes('dependency-install'));
  assert.ok(plan.find((item) => item.id === 'rtk').phases.includes('binary-install'));
  assert.ok(plan.find((item) => item.id === 'astGrep').phases.includes('dependency-install'));
});

test('explicit tool provisioning uses project-local RTK and ast-grep phases', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tool-provision-'));
  const calls = [];
  const rtkBinary = path.join(target, '.agents/runtime/tools/rtk/bin', process.platform === 'win32' ? 'rtk.exe' : 'rtk');
  const astGrepBinary = path.join(target, '.agents/runtime/tools/ast-grep/node_modules/@ast-grep/cli', process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep');
  const runtimeVersionRunner = async ({ command }) => ({
    stderr: '',
    stdout: command === rtkBinary ? 'rtk 0.45.0' : 'ast-grep 0.45.1',
  });
  try {
    const tools = await provisionProfileTools({
      commandRunner: async (request) => {
        if (request.component === 'astGrep') await seedAstGrepNativePackage(path.join(target, '.agents/runtime/tools/ast-grep'));
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
    assert.equal(tools.rtk.source, 'github:rtk-ai/rtk@v0.45.0');
    assert.equal(tools.astGrep.status, 'ready');
    assert.deepEqual(calls.map((call) => [call.component, call.phase]), [
      ['rtk', 'dependency-install'],
      ['rtk', 'binary-install'],
      ['astGrep', 'dependency-install'],
      ['astGrep', 'binary-install'],
    ]);
    assert.match(calls[1].args[0], /rtk[\\/]run\.mjs$/u);
    assert.match(calls[3].args[0], /ast-grep[\\/]node_modules[\\/]@ast-grep[\\/]cli[\\/]postinstall\.js$/u);
    const state = JSON.parse(await readFile(path.join(target, '.vibe-harness/tool-state/tools.json'), 'utf8'));
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
    const retained = JSON.parse(await readFile(path.join(target, '.vibe-harness/tool-state/tools.json'), 'utf8'));
    assert.deepEqual(Object.keys(retained.tools).sort(), ['astGrep', 'rtk']);
    assert.equal(retained.tools.astGrep.status, 'ready');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('optional tool provisioning rejects binaries with unexpected versions', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tool-provision-version-'));
  const rtkBinary = path.join(target, '.agents/runtime/tools/rtk/bin', process.platform === 'win32' ? 'rtk.exe' : 'rtk');
  const astGrepBinary = path.join(target, '.agents/runtime/tools/ast-grep/node_modules/@ast-grep/cli', process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep');
  try {
    const tools = await provisionProfileTools({
      commandRunner: async (request) => {
        const binary = request.component === 'rtk' ? rtkBinary : astGrepBinary;
        if (request.component === 'astGrep') await seedAstGrepNativePackage(path.join(target, '.agents/runtime/tools/ast-grep'));
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
        stdout: command === rtkBinary ? 'rtk 0.42.0' : 'ast-grep 0.45.0',
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
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tool-provision-unsupported-'));
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
    assert.equal(tools.rtk.source, 'github:rtk-ai/rtk@v0.45.0');
    const state = JSON.parse(await readFile(path.join(target, '.vibe-harness/tool-state/tools.json'), 'utf8'));
    assert.equal(state.tools.rtk.status, 'unsupported');
    assert.equal(state.tools.rtk.code, 'RTK_UNSUPPORTED_PLATFORM');
    assert.equal(state.tools.rtk.platform, 'freebsd-riscv64');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('ast-grep public failures produce compatible doctor recommendations', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-ast-grep-recommendations-'));
  const statePath = path.join(target, '.vibe-harness/tool-state/tools.json');
  try {
    await runCli(['init', '--project', target]);
    await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', '-rtk', 'ast-grep', '--rtk-hooks', 'off', '--write',
    ]);
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({
      fingerprints: {},
      tools: {
        astGrep: {
          code: 'AST_GREP_UNSUPPORTED_PLATFORM',
          phase: 'dependency-install',
          status: 'unsupported',
          version: '0.45.1',
        },
      },
    }) + '\n', 'utf8');

    const unsupported = JSON.parse((await execFileAsync(process.execPath, [
      cliPath, 'doctor', '--project', target, '--allow-degraded',
    ], { cwd: rootDir })).stdout);
    const unsupportedRecommendation = unsupported.recommendations.find((item) => item.tool === 'astGrep');
    assert.equal(unsupportedRecommendation.code, 'AST_GREP_UNSUPPORTED_PLATFORM');
    assert.equal(unsupportedRecommendation.action, 'fallback');
    assert.equal('command' in unsupportedRecommendation, false);
    assert.match(unsupportedRecommendation.message, /rg/u);

    await writeFile(statePath, JSON.stringify({
      fingerprints: {},
      tools: {
        astGrep: {
          code: 'AST_GREP_OPTIONAL_PACKAGE_MISSING',
          phase: 'dependency-install',
          status: 'degraded',
          version: '0.45.1',
        },
      },
    }) + '\n', 'utf8');

    const missingOptionalPackage = JSON.parse((await execFileAsync(process.execPath, [
      cliPath, 'doctor', '--project', target, '--allow-degraded',
    ], { cwd: rootDir })).stdout);
    const missingPackageRecommendation = missingOptionalPackage.recommendations.find((item) => item.tool === 'astGrep');
    assert.equal(missingPackageRecommendation.code, 'AST_GREP_OPTIONAL_PACKAGE_MISSING');
    assert.equal(missingPackageRecommendation.action, 'fallback');
    assert.match(missingPackageRecommendation.command, /--tool astGrep/u);
    assert.match(missingPackageRecommendation.message, /rg/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('failed optional-tool provisioning degrades health and allow-degraded preserves status', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tool-degraded-'));
  const env = { ...process.env, VIBE_HARNESS_TEST_OFFLINE: '1' };
  try {
    await runCli(['init', '--project', target]);
    await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', '-rtk', 'ast-grep', '--rtk-hooks', 'off', '--write',
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
    assert.equal(baseline.baseline.installation.tools.rtk.source, 'github:rtk-ai/rtk@v0.45.0');
    assert.equal(baseline.baseline.installation.tools.astGrep.status, 'degraded');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
