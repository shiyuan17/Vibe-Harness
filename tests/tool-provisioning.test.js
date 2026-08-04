import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { parse as parseToml } from '@iarna/toml';

import { createInstallPlan, previewInstallPlan } from '../scripts/lib/install-planner.js';
import { resolveOcrEndpoint } from '../scripts/lib/ocr-config.js';
import {
  createToolProvisioningPlan,
  mergeManagedCbmIgnoreBlock,
  inspectProfileTools,
  mergeManagedMcpBlock,
  provisionProfileTools,
  repairCodebaseMemoryBinary,
  removeManagedCbmIgnoreBlock,
  runMcpHandshake,
} from '../scripts/lib/tool-provisioning.js';

const rootDir = path.resolve(import.meta.dirname, '..');
const execFileAsync = promisify(execFile);
const cliPath = path.join(rootDir, 'scripts/vibe-harness.js');
const offlineEnv = {
  ...process.env,
  ANTHROPIC_API_KEY: '',
  OCR_LLM_MODEL: '',
  OCR_LLM_TOKEN: '',
  OCR_LLM_URL: '',
  OPENAI_API_KEY: '',
  VIBE_HARNESS_TEST_OFFLINE: '1',
  npm_config_cache: path.join(tmpdir(), 'vibe-harness-empty-npm-cache'),
  npm_config_offline: 'true',
};
const PROFILE_TOOL_MODULES = [
  'codebase-memory',
  'playwright',
  'chrome-devtools',
  'open-code-review',
];

async function successfulToolOutput(request, targetDir, { materializeCodebaseMemoryRuntime = true } = {}) {
  if (request.component === 'codebaseMemoryMcp'
    && request.phase === 'binary-install'
    && materializeCodebaseMemoryRuntime) {
    await seedCodebaseMemoryRuntime(request.cwd);
  }
  if (request.component === 'codebaseMemoryMcp' && request.phase === 'index') {
    return {
      stdout: JSON.stringify({
        edges: 13,
        nodes: 21,
        project: 'vibe-harness-target',
        status: 'indexed',
      }),
    };
  }
  if (request.component === 'codebaseMemoryMcp' && request.phase === 'index-verify') {
    return {
      stdout: JSON.stringify({
        edges: 13,
        nodes: 21,
        project: 'vibe-harness-target',
        root_path: path.resolve(targetDir).replaceAll('\\', '/'),
        status: 'ready',
      }),
    };
  }
  return { stdout: '{}' };
}

async function seedCodebaseMemoryRuntime(toolDir) {
  const packageDir = path.join(toolDir, 'node_modules/codebase-memory-mcp');
  const binary = process.platform === 'win32' ? 'codebase-memory-mcp.exe' : 'codebase-memory-mcp';
  await mkdir(path.join(packageDir, 'bin'), { recursive: true });
  await writeFile(path.join(packageDir, 'bin.js'), 'runtime shim\n', 'utf8');
  await writeFile(path.join(packageDir, 'bin', binary), 'runtime binary\n', 'utf8');
}

async function seedChromeDevtoolsRuntime(toolDir) {
  const entryDir = path.join(toolDir, 'node_modules/chrome-devtools-mcp/build/src/bin');
  await mkdir(entryDir, { recursive: true });
  await writeFile(path.join(entryDir, 'chrome-devtools-mcp.js'), 'runtime shim\n', 'utf8');
}

async function runCli(args, options = {}) {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: rootDir,
    maxBuffer: 1024 * 1024 * 8,
    ...options,
  });
  return JSON.parse(stdout);
}

async function runCliFailure(args, options = {}) {
  try {
    await runCli(args, options);
  } catch (error) {
    return {
      code: error.code,
      report: JSON.parse(error.stdout),
    };
  }
  assert.fail('Expected CLI command to fail');
}

async function runCliSummary(args, options = {}) {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: rootDir,
    maxBuffer: 1024 * 1024 * 8,
    ...options,
  });
  return stdout;
}

test('tool plans require explicitly resolved plugin modules', () => {
  const targetDir = path.resolve('target-project');
  const stable = createToolProvisioningPlan({ profile: 'full', targetDir });
  const full = createToolProvisioningPlan({ allowPreview: true, profile: 'full', targetDir });
  const core = createToolProvisioningPlan({ profile: 'core', targetDir });

  assert.deepEqual(stable, []);
  assert.deepEqual(full, []);
  assert.deepEqual(core, []);
});

test('managed MCP block preserves local TOML and refuses duplicate unmanaged server tables', () => {
  const local = [
    'model = "gpt-5"',
    '',
    '[mcp_servers.agentmemory]',
    'command = "user-memory"',
    '',
    '[mcp_servers."chrome-devtools"]',
    'command = "user-chrome"',
    '',
  ].join('\n');

  const result = mergeManagedMcpBlock(local, {
    agentmemory: { args: ['memory.mjs'], command: 'node', env: { HOME: 'project-home' } },
    'chrome-devtools': { args: ['chrome.mjs'], command: 'node', env: { CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1' } },
    'codebase-memory-mcp': { args: ['codebase.mjs'], command: 'node', env: { CBM_ALLOWED_ROOT: 'project' } },
  });

  assert.equal(result.content.includes('model = "gpt-5"'), true);
  assert.equal(result.content.includes('command = "user-memory"'), true);
  assert.equal(result.content.includes('command = "user-chrome"'), true);
  assert.equal(result.content.includes('# VIBE_HARNESS:MCP:START'), true);
  assert.equal(result.content.includes('[mcp_servers.codebase-memory-mcp]'), true);
  assert.equal(result.content.includes('[mcp_servers.chrome-devtools]'), false);
  assert.equal(result.content.includes('[mcp_servers.agentmemory]\ncommand = "node"'), false);
  assert.deepEqual(result.conflicts, ['agentmemory', 'chrome-devtools']);
  assert.doesNotThrow(() => parseToml(result.content));
});

test('Chrome DevTools runtime pins safe headless isolated defaults without forwarding arbitrary arguments', async () => {
  const plan = await createInstallPlan({
    dryRun: true,
    profile: 'full',
    requestedPlugins: ['chrome-devtools'],
    rootDir,
    targetDir: path.resolve('target-project'),
  });
  const runtime = plan.actions.find((action) => action.relativeTarget === '.agents/runtime/tools/chrome-devtools-mcp/run.mjs');
  assert.ok(runtime, 'full profile should install the Chrome DevTools runtime');

  const source = await readFile(path.join(rootDir, 'runtime/tools/chrome-devtools-mcp/run.mjs'), 'utf8');
  const packageJson = JSON.parse(await readFile(path.join(rootDir, 'runtime/tools/chrome-devtools-mcp/package.json'), 'utf8'));
  assert.equal(packageJson.dependencies['chrome-devtools-mcp'], '1.6.0');
  for (const flag of ['--headless', '--isolated', '--no-usage-statistics', '--no-performance-crux', '--redact-network-headers']) {
    assert.match(source, new RegExp(flag, 'u'));
  }
  assert.match(source, /CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS/u);
  assert.match(source, /build\/src\/bin\/chrome-devtools-mcp\.js/u);
  assert.doesNotMatch(source, /process\.argv\.slice/u);
});

test('Chrome DevTools wrapper strips secrets, credentialed proxies, and caller arguments from its child', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-chrome-wrapper-'));
  const runtimeDir = path.join(targetDir, 'runtime');
  const entryDir = path.join(runtimeDir, 'node_modules/chrome-devtools-mcp/build/src/bin');
  try {
    await mkdir(entryDir, { recursive: true });
    await copyFile(path.join(rootDir, 'runtime/tools/chrome-devtools-mcp/run.mjs'), path.join(runtimeDir, 'run.mjs'));
    await writeFile(path.join(entryDir, 'chrome-devtools-mcp.js'), [
      "import { writeFile } from 'node:fs/promises';",
      "await writeFile('child-observation.json', JSON.stringify({ argv: process.argv.slice(2), env: process.env }));",
    ].join('\n'), 'utf8');

    await execFileAsync(process.execPath, [path.join(runtimeDir, 'run.mjs'), '--browser-url=http://127.0.0.1:9222'], {
      cwd: targetDir,
      env: {
        ...process.env,
        AWS_SECRET_ACCESS_KEY: 'cloud-secret',
        VIBE_HARNESS_SECRET_SENTINEL: 'must-not-leak',
        HTTPS_PROXY: 'http://user:password@proxy.example.test',
        SSL_CERT_DIR: 'C:\\untrusted-ca-dir',
        SSL_CERT_FILE: 'C:\\untrusted-ca.pem',
      },
    });

    const observation = JSON.parse(await readFile(path.join(targetDir, 'child-observation.json'), 'utf8'));
    assert.deepEqual(observation.argv, [
      '--headless', '--isolated', '--no-usage-statistics', '--no-performance-crux', '--redact-network-headers',
    ]);
    assert.equal(observation.env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(observation.env.VIBE_HARNESS_SECRET_SENTINEL, undefined);
    assert.equal(observation.env.HTTPS_PROXY, undefined);
    assert.equal(observation.env.SSL_CERT_DIR, undefined);
    assert.equal(observation.env.SSL_CERT_FILE, undefined);
    assert.equal(observation.env.CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS, '1');
    assert.equal(observation.env.CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS, '1');
    assert.equal(observation.env.PATH ?? observation.env.Path, process.env.PATH ?? process.env.Path);
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('provisioning continues after one component fails and never persists command secrets', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tools-'));
  const calls = [];
  const env = {
    OCR_LLM_TOKEN: 'super-secret-token',
    OCR_LLM_URL: 'https://llm.example.test',
    OCR_LLM_MODEL: 'test-model',
  };
  try {
    const report = await provisionProfileTools({
      allowPreview: true,
      commandRunner: async (request) => {
        calls.push(request);
        if (request.component === 'codebaseMemoryMcp' && request.phase === 'index') {
          throw Object.assign(new Error('token=super-secret-token failed'), {
            code: 'TOOL_COMMAND_FAILED',
            exitCode: 23,
            stderr: [
              `connect ETIMEDOUT for ${targetDir}: Bearer super-secret-token`,
              `path=${targetDir.replaceAll('\\', '/').toUpperCase()}`,
              'payload={"token":"json-secret","password":"json-password"}',
              'api_key: colon-secret',
              'request=https://user:pa:ss@example.test/resource',
              'tokenUri=https://token-only@example.test/resource',
              'passwordUri=https://:password-only@example.test/resource',
              'You can install manually: https://example.test/install',
              'Try reinstalling: npm install -g codebase-memory-mcp',
            ].join('\n'),
            stdout: 'retrying index',
          });
        }
        return successfulToolOutput(request, targetDir);
      },
      env,
      profile: 'full',
      resolvedModules: PROFILE_TOOL_MODULES,
      targetDir,
    });

    assert.equal(report.codebaseMemoryMcp.status, 'degraded');
    assert.deepEqual(report.codebaseMemoryMcp.diagnostic, {
      code: 'TOOL_COMMAND_FAILED',
      exitCode: 23,
      message: 'connect ETIMEDOUT for <project>: Bearer [REDACTED]',
      phase: 'index',
      stderrTail: [
        'connect ETIMEDOUT for <project>: Bearer [REDACTED]',
        'path=<project>',
        'payload={"token":"[REDACTED]","password":"[REDACTED]"}',
        'api_key: [REDACTED]',
        'request=https://[REDACTED]@example.test/resource',
        'tokenUri=https://[REDACTED]@example.test/resource',
        'passwordUri=https://[REDACTED]@example.test/resource',
        'You can install manually: https://example.test/install',
        'Try reinstalling: npm install -g codebase-memory-mcp',
      ].join('\n'),
      stdoutTail: 'retrying index',
      truncated: false,
    });
    assert.equal(report.playwrightCli.status, 'ready');
    assert.equal(report.openCodeReview.status, 'ready');
    assert.equal(calls.some((call) => call.component === 'openCodeReview' && call.phase === 'llm-test'), true);
    const index = calls.find((call) => call.component === 'codebaseMemoryMcp' && call.phase === 'index');
    assert.deepEqual(calls
      .filter((call) => call.component === 'codebaseMemoryMcp')
      .map((call) => call.phase)
      .slice(0, 5), [
      'dependency-install',
      'binary-install',
      'configure-auto-index',
      'configure-auto-watch',
      'index',
    ]);
    const configureAutoIndex = calls.find((call) => call.component === 'codebaseMemoryMcp' && call.phase === 'configure-auto-index');
    const configureAutoWatch = calls.find((call) => call.component === 'codebaseMemoryMcp' && call.phase === 'configure-auto-watch');
    assert.deepEqual(configureAutoIndex.args.slice(1), ['config', 'set', 'auto_index', 'false']);
    assert.deepEqual(configureAutoWatch.args.slice(1), ['config', 'set', 'auto_watch', 'false']);
    assert.deepEqual(index.args.slice(1), [
      'cli', 'index_repository',
      '--repo-path', '.',
      '--mode', 'moderate',
      '--persistence', 'false',
    ]);
    assert.equal(index.env.CBM_ALLOWED_ROOT, targetDir);
    assert.equal(index.env.CBM_CACHE_DIR.startsWith(targetDir), true);
    assert.equal(index.env.CBM_MEM_BUDGET_MB, '2048');
    assert.equal(index.env.CBM_WORKERS, '2');
    const state = await readFile(path.join(targetDir, '.vibe-harness/tool-state/tools.json'), 'utf8');
    assert.equal(state.includes('connect ETIMEDOUT for <project>'), true);
    assert.equal(state.includes('super-secret-token'), false);
    assert.equal(state.includes('json-secret'), false);
    assert.equal(state.includes('json-password'), false);
    assert.equal(state.includes('colon-secret'), false);
    assert.equal(state.includes('pa:ss'), false);
    assert.equal(state.includes('token-only'), false);
    assert.equal(state.includes('password-only'), false);
    assert.equal(state.includes('token='), false);
    assert.equal(state.includes(targetDir), false);
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('codebase-memory index verification gates ready status and persists only a sanitized summary', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-index-verify-'));
  const calls = [];
  try {
    const report = await provisionProfileTools({
      commandRunner: async (request) => {
        calls.push(request);
        return successfulToolOutput(request, targetDir);
      },
      env: { OPENAI_API_KEY: 'configured' },
      profile: 'full',
      resolvedModules: ['codebase-memory'],
      targetDir,
    });

    const verify = calls.find((call) => call.component === 'codebaseMemoryMcp' && call.phase === 'index-verify');
    assert.deepEqual(verify.args.slice(1), ['cli', 'index_status', '--project', 'vibe-harness-target']);
    assert.deepEqual(report.codebaseMemoryMcp.index, {
      edges: 13,
      mode: 'moderate',
      nodes: 21,
      status: 'ready',
    });

    const state = await readFile(path.join(targetDir, '.vibe-harness/tool-state/tools.json'), 'utf8');
    assert.equal(state.includes('vibe-harness-target'), false);
    assert.equal(state.includes(targetDir), false);
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('codebase-memory rejects empty verification output and mismatched project roots', async () => {
  for (const [name, verifyOutput, expectedCode] of [
    ['empty-output', '', 'INDEX_OUTPUT_INVALID'],
    ['wrong-root', JSON.stringify({ root_path: 'C:/other-project', status: 'ready' }), 'INDEX_ROOT_MISMATCH'],
  ]) {
    const targetDir = await mkdtemp(path.join(tmpdir(), `vibe-harness-index-${name}-`));
    try {
      const report = await provisionProfileTools({
        commandRunner: async (request) => {
          if (request.component === 'codebaseMemoryMcp' && request.phase === 'index-verify') {
            return { stdout: verifyOutput };
          }
          return successfulToolOutput(request, targetDir);
        },
        env: { OPENAI_API_KEY: 'configured' },
        profile: 'full',
        resolvedModules: ['codebase-memory'],
        targetDir,
      });

      assert.equal(report.codebaseMemoryMcp.status, 'degraded');
      assert.equal(report.codebaseMemoryMcp.phase, 'index-verify');
      assert.equal(report.codebaseMemoryMcp.code, expectedCode);
      const state = await readFile(path.join(targetDir, '.vibe-harness/tool-state/tools.json'), 'utf8');
      assert.equal(state.includes('C:/other-project'), false);
    } finally {
      await rm(targetDir, { force: true, recursive: true });
    }
  }
});

test('codebase-memory rejects index output that does not identify an indexed project', async () => {
  for (const [indexOutput, expectedCode] of [
    ['', 'INDEX_OUTPUT_INVALID'],
    [JSON.stringify({ status: 'indexed' }), 'INDEX_RESULT_INVALID'],
    [JSON.stringify({ project: 'vibe-harness-target', status: 'failed' }), 'INDEX_RESULT_INVALID'],
  ]) {
    const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-index-result-'));
    try {
      const report = await provisionProfileTools({
        commandRunner: async (request) => request.component === 'codebaseMemoryMcp' && request.phase === 'index'
          ? { stdout: indexOutput }
          : successfulToolOutput(request, targetDir),
        env: { OPENAI_API_KEY: 'configured' },
        profile: 'full',
        resolvedModules: ['codebase-memory'],
        targetDir,
      });
      assert.equal(report.codebaseMemoryMcp.status, 'degraded');
      assert.equal(report.codebaseMemoryMcp.phase, 'index');
      assert.equal(report.codebaseMemoryMcp.code, expectedCode);
    } finally {
      await rm(targetDir, { force: true, recursive: true });
    }
  }
});

test('real codebase-memory provisioning creates a verified project-local index', {
  skip: process.env.VIBE_HARNESS_REAL_TOOL_INTEGRATION !== '1',
}, async (testContext) => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-index-integration-'));
  const toolDir = path.join(targetDir, '.agents/runtime/tools/codebase-memory-mcp');
  const runtimeSource = path.join(rootDir, 'runtime/tools/codebase-memory-mcp');
  try {
    const locator = process.platform === 'win32' ? ['where.exe', ['codebase-memory-mcp']] : ['which', ['codebase-memory-mcp']];
    let systemBinary;
    try {
      const { stdout } = await execFileAsync(locator[0], locator[1]);
      systemBinary = stdout.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
      const { stdout: versionOutput } = await execFileAsync(systemBinary, ['--version']);
      if (!versionOutput.includes('0.9.0')) {
        testContext.skip('requires a local codebase-memory-mcp 0.9.0 binary fixture');
        return;
      }
    } catch {
      testContext.skip('requires a local codebase-memory-mcp 0.9.0 binary fixture');
      return;
    }

    await mkdir(toolDir, { recursive: true });
    await writeFile(path.join(targetDir, 'example.js'), 'export const indexedValue = 42;\n', 'utf8');
    for (const file of ['package.json', 'package-lock.json', 'run.mjs', 'path-alias.mjs']) {
      await copyFile(path.join(runtimeSource, file), path.join(toolDir, file));
    }

    const report = await provisionProfileTools({
      commandRunner: async (request) => {
        if (request.phase === 'binary-install') {
          const binary = process.platform === 'win32' ? 'codebase-memory-mcp.exe' : 'codebase-memory-mcp';
          const binaryDir = path.join(toolDir, 'node_modules/codebase-memory-mcp/bin');
          await mkdir(binaryDir, { recursive: true });
          await copyFile(systemBinary, path.join(binaryDir, binary));
        }
        if (request.phase === 'mcp-handshake') {
          await runMcpHandshake(request);
          return { stderr: '', stdout: '' };
        }
        const { stderr, stdout } = await execFileAsync(request.command, request.args, {
          cwd: request.cwd,
          env: request.env,
          maxBuffer: 1024 * 1024,
          timeout: request.timeout,
        });
        return { stderr, stdout };
      },
      env: { ...process.env, VIBE_HARNESS_TOOL_TIMEOUT_MS: '60000' },
      profile: 'full',
      resolvedModules: ['codebase-memory'],
      targetDir,
    });
    assert.equal(report.codebaseMemoryMcp.status, 'ready', JSON.stringify(report.codebaseMemoryMcp));
    assert.equal(report.codebaseMemoryMcp.index.status, 'ready');
    assert.equal(report.codebaseMemoryMcp.index.nodes > 0, true);
    const state = await readFile(path.join(targetDir, '.vibe-harness/tool-state/tools.json'), 'utf8');
    assert.equal(state.includes(targetDir), false);
    await assert.rejects(readFile(path.join(targetDir, '.codebase-memory/graph.db.zst')), /ENOENT/u);
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('every full-profile tool persists a sanitized diagnostic for its failed phase', async () => {
  const failures = [
    ['codebaseMemoryMcp', 'index'],
    ['codebaseMemoryMcp', 'index-verify'],
    ['playwrightCli', 'browser-install'],
    ['openCodeReview', 'llm-test'],
  ];
  for (const [toolId, phase] of failures) {
    const targetDir = await mkdtemp(path.join(tmpdir(), `vibe-harness-diagnostic-${toolId}-`));
    try {
      const report = await provisionProfileTools({
        allowPreview: true,
        commandRunner: async (request) => {
          if (request.component === toolId && request.phase === phase) {
            throw Object.assign(new Error('token=diagnostic-secret'), {
              code: 'TOOL_COMMAND_FAILED',
              exitCode: 9,
              stderr: `failed in ${targetDir}: Bearer diagnostic-secret`,
            });
          }
          return successfulToolOutput(request, targetDir);
        },
        env: { OPENAI_API_KEY: 'configured' },
        profile: 'full',
        resolvedModules: PROFILE_TOOL_MODULES,
        targetDir,
      });
      const diagnostic = report[toolId].diagnostic;

      assert.equal(report[toolId].status, 'degraded');
      assert.equal(diagnostic.code, 'TOOL_COMMAND_FAILED');
      assert.equal(diagnostic.phase, phase);
      assert.equal(diagnostic.exitCode, 9);
      assert.equal(diagnostic.stderrTail, 'failed in <project>: Bearer [REDACTED]');
    } finally {
      await rm(targetDir, { force: true, recursive: true });
    }
  }
});

test('tool phase timeouts can be bounded by the lifecycle smoke environment', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tools-timeout-'));
  const calls = [];
  try {
    await provisionProfileTools({
      commandRunner: async (request) => { calls.push(request); return successfulToolOutput(request, targetDir); },
      env: { VIBE_HARNESS_TOOL_TIMEOUT_MS: '1500', OPENAI_API_KEY: 'configured' },
      profile: 'full',
      resolvedModules: PROFILE_TOOL_MODULES,
      targetDir,
    });
    assert.equal(calls.length > 0, true);
    assert.equal(calls.every((request) => request.timeout <= 1500), true);
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('MCP handshake reports a closed stdin without an unhandled EPIPE', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-mcp-stdin-'));
  const script = path.join(targetDir, 'close-stdin.mjs');
  try {
    await writeFile(script, 'process.stdin.destroy(); setTimeout(() => {}, 1000);\n', 'utf8');
    await assert.rejects(
      runMcpHandshake({ args: [script], command: process.execPath, cwd: targetDir, env: process.env, timeout: 2000 }),
      (error) => ['MCP_EARLY_EXIT', 'MCP_STDIN_FAILED'].includes(error.code),
    );
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('OCR without credentials is pending-config and inspect restores persisted statuses', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tools-pending-'));
  try {
    const report = await provisionProfileTools({
      commandRunner: async (request) => successfulToolOutput(request, targetDir),
      env: {},
      ocrHomeDir: path.join(tmpdir(), 'vibe-harness-no-ocr-config'),
      profile: 'full',
      resolvedModules: ['codebase-memory', 'open-code-review'],
      targetDir,
    });
    const inspected = await inspectProfileTools('full', targetDir, ['codebase-memory', 'open-code-review']);

    assert.equal(report.openCodeReview.status, 'pending-config');
    assert.equal(report.openCodeReview.phase, 'llm-config');
    assert.equal(inspected.openCodeReview.status, 'pending-config');
    assert.equal(inspected.codebaseMemoryMcp.version, '0.9.0');
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('unchanged OCR pending-config is reused until credentials become available', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tools-ocr-reuse-'));
  const ocr = createToolProvisioningPlan({ profile: 'full', resolvedModules: ['open-code-review'], targetDir })
    .find((tool) => tool.id === 'openCodeReview');
  const calls = [];
  const runner = async (request) => {
    calls.push(request);
    return successfulToolOutput(request, targetDir);
  };
  try {
    await mkdir(ocr.toolDir, { recursive: true });
    await writeFile(path.join(ocr.toolDir, 'package-lock.json'), 'ocr-lock\n', 'utf8');

    await provisionProfileTools({ commandRunner: runner, env: {}, profile: 'full', resolvedModules: ['open-code-review'], targetDir });
    const firstOcrCallCount = calls.filter((call) => call.component === 'openCodeReview').length;
    await provisionProfileTools({ commandRunner: runner, env: {}, profile: 'full', resolvedModules: ['open-code-review'], targetDir });
    assert.equal(calls.filter((call) => call.component === 'openCodeReview').length, firstOcrCallCount);

    const configured = await provisionProfileTools({
      commandRunner: runner,
      env: { OPENAI_API_KEY: 'configured' },
      profile: 'full',
      resolvedModules: ['open-code-review'],
      targetDir,
    });
    assert.equal(configured.openCodeReview.status, 'ready');
    assert.equal(calls.some((call) => call.component === 'openCodeReview' && call.phase === 'llm-test'), true);
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('ready tools reuse package phases while codebase-memory reindexes and verifies every install', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tools-reuse-'));
  const plan = createToolProvisioningPlan({ allowPreview: true, profile: 'full', resolvedModules: PROFILE_TOOL_MODULES, targetDir });
  const calls = [];
  const runner = async (request) => {
    calls.push(request);
    return successfulToolOutput(request, targetDir);
  };
  const env = { OPENAI_API_KEY: 'configured' };
  try {
    for (const tool of plan) {
      await mkdir(tool.toolDir, { recursive: true });
      await writeFile(path.join(tool.toolDir, 'package-lock.json'), `${tool.id}\n`, 'utf8');
    }
    await seedCodebaseMemoryRuntime(plan.find((tool) => tool.id === 'codebaseMemoryMcp').toolDir);
    await seedChromeDevtoolsRuntime(plan.find((tool) => tool.id === 'chromeDevtoolsMcp').toolDir);
    await provisionProfileTools({ allowPreview: true, commandRunner: runner, env, profile: 'full', resolvedModules: PROFILE_TOOL_MODULES, targetDir });
    const firstCallCount = calls.length;
    await provisionProfileTools({ allowPreview: true, commandRunner: runner, env, profile: 'full', resolvedModules: PROFILE_TOOL_MODULES, targetDir });
    const repeatedCalls = calls.slice(firstCallCount);
    assert.deepEqual(repeatedCalls.map((call) => [call.component, call.phase]), [
      ['codebaseMemoryMcp', 'configure-auto-index'],
      ['codebaseMemoryMcp', 'configure-auto-watch'],
      ['codebaseMemoryMcp', 'index'],
      ['codebaseMemoryMcp', 'index-verify'],
      ['codebaseMemoryMcp', 'mcp-handshake'],
      ['chromeDevtoolsMcp', 'browser-smoke'],
    ]);

    const openCodeReview = plan.find((tool) => tool.id === 'openCodeReview');
    await writeFile(path.join(openCodeReview.toolDir, 'package-lock.json'), 'changed\n', 'utf8');
    const beforeChangedLock = calls.length;
    await provisionProfileTools({ allowPreview: true, commandRunner: runner, env, profile: 'full', resolvedModules: PROFILE_TOOL_MODULES, targetDir });
    const newCalls = calls.slice(beforeChangedLock);
    assert.deepEqual(newCalls.filter((call) => call.component === 'codebaseMemoryMcp').map((call) => call.phase), [
      'configure-auto-index', 'configure-auto-watch', 'index', 'index-verify', 'mcp-handshake',
    ]);
    assert.equal(newCalls.some((call) => call.component === 'openCodeReview'), true);
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('a missing codebase-memory runtime bypasses package reuse and reinstalls before indexing', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tools-runtime-repair-'));
  const plan = createToolProvisioningPlan({ profile: 'full', resolvedModules: ['codebase-memory'], targetDir });
  const codebaseMemory = plan.find((tool) => tool.id === 'codebaseMemoryMcp');
  const binary = process.platform === 'win32' ? 'codebase-memory-mcp.exe' : 'codebase-memory-mcp';
  const calls = [];
  const runner = async (request) => {
    calls.push(request);
    return successfulToolOutput(request, targetDir);
  };
  try {
    for (const tool of plan) {
      await mkdir(tool.toolDir, { recursive: true });
      await writeFile(path.join(tool.toolDir, 'package-lock.json'), `${tool.id}\n`, 'utf8');
    }
    await seedCodebaseMemoryRuntime(codebaseMemory.toolDir);
    await provisionProfileTools({ commandRunner: runner, env: { OPENAI_API_KEY: 'configured' }, profile: 'full', resolvedModules: ['codebase-memory'], targetDir });

    await rm(path.join(codebaseMemory.toolDir, 'node_modules/codebase-memory-mcp/bin', binary), { force: true });
    const beforeRepair = calls.length;
    await provisionProfileTools({ commandRunner: runner, env: { OPENAI_API_KEY: 'configured' }, profile: 'full', resolvedModules: ['codebase-memory'], targetDir });

    assert.deepEqual(calls.slice(beforeRepair)
      .filter((call) => call.component === 'codebaseMemoryMcp')
      .map((call) => call.phase), [
      'dependency-install', 'binary-install', 'configure-auto-index', 'configure-auto-watch',
      'index', 'index-verify', 'mcp-handshake',
    ]);
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('a missing Chrome DevTools runtime bypasses dependency reuse before browser smoke', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-chrome-runtime-repair-'));
  const plan = createToolProvisioningPlan({ profile: 'full', resolvedModules: ['chrome-devtools'], targetDir });
  const chromeDevtools = plan.find((tool) => tool.id === 'chromeDevtoolsMcp');
  const calls = [];
  const runner = async (request) => {
    calls.push(request);
    if (request.component === 'codebaseMemoryMcp' && request.phase === 'binary-install') {
      await seedCodebaseMemoryRuntime(codebaseMemory.toolDir);
    }
    return successfulToolOutput(request, targetDir);
  };
  try {
    await mkdir(chromeDevtools.toolDir, { recursive: true });
    await writeFile(path.join(chromeDevtools.toolDir, 'package-lock.json'), 'chromeDevtoolsMcp\n', 'utf8');
    await seedChromeDevtoolsRuntime(chromeDevtools.toolDir);
    await provisionProfileTools({ commandRunner: runner, env: {}, profile: 'full', resolvedModules: ['chrome-devtools'], targetDir });

    await rm(path.join(chromeDevtools.toolDir, 'node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'), { force: true });
    const beforeRepair = calls.length;
    await provisionProfileTools({ commandRunner: runner, env: {}, profile: 'full', resolvedModules: ['chrome-devtools'], targetDir });

    assert.deepEqual(calls.slice(beforeRepair).map((call) => call.phase), ['dependency-install', 'browser-smoke']);
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('a successful codebase-memory binary install repairs a still-missing runtime before configuration', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tools-runtime-false-success-'));
  const plan = createToolProvisioningPlan({ profile: 'full', resolvedModules: ['codebase-memory'], targetDir });
  const codebaseMemory = plan.find((tool) => tool.id === 'codebaseMemoryMcp');
  const calls = [];
  let repairCalls = 0;
  try {
    await mkdir(codebaseMemory.toolDir, { recursive: true });
    await writeFile(path.join(codebaseMemory.toolDir, 'package-lock.json'), 'codebaseMemoryMcp\n', 'utf8');
    await mkdir(path.join(codebaseMemory.toolDir, 'node_modules/codebase-memory-mcp'), { recursive: true });
    await writeFile(
      path.join(codebaseMemory.toolDir, 'node_modules/codebase-memory-mcp/bin.js'),
      'runtime shim\n',
      'utf8',
    );

    const report = await provisionProfileTools({
      codebaseMemoryRepair: async (spec) => {
        repairCalls += 1;
        await seedCodebaseMemoryRuntime(spec.toolDir);
        return true;
      },
      commandRunner: async (request) => {
        calls.push(request);
        return successfulToolOutput(request, targetDir, { materializeCodebaseMemoryRuntime: false });
      },
      env: {},
      profile: 'full',
      resolvedModules: ['codebase-memory'],
      targetDir,
    });

    assert.equal(report.codebaseMemoryMcp.status, 'ready');
    assert.equal(repairCalls, 1);
    assert.deepEqual(calls.map((call) => call.phase), [
      'dependency-install', 'binary-install', 'configure-auto-index', 'configure-auto-watch',
      'index', 'index-verify', 'mcp-handshake',
    ]);
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('codebase-memory provisioning fixes resource limits even when the parent environment overrides them', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tools-resource-defaults-'));
  const plan = createToolProvisioningPlan({ profile: 'full', resolvedModules: ['codebase-memory'], targetDir });
  const codebaseMemory = plan.find((tool) => tool.id === 'codebaseMemoryMcp');
  const calls = [];
  try {
    await mkdir(codebaseMemory.toolDir, { recursive: true });
    await writeFile(path.join(codebaseMemory.toolDir, 'package-lock.json'), 'codebaseMemoryMcp\n', 'utf8');
    const report = await provisionProfileTools({
      commandRunner: async (request) => {
        calls.push(request);
        if (request.phase === 'binary-install') await seedCodebaseMemoryRuntime(codebaseMemory.toolDir);
        return successfulToolOutput(request, targetDir);
      },
      env: { CBM_MEM_BUDGET_MB: '99999', CBM_WORKERS: '999' },
      profile: 'full',
      resolvedModules: ['codebase-memory'],
      targetDir,
    });

    assert.equal(report.codebaseMemoryMcp.status, 'ready');
    for (const request of calls) {
      assert.equal(request.env.CBM_MEM_BUDGET_MB, '2048');
      assert.equal(request.env.CBM_WORKERS, '2');
    }
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('codebase-memory PATH repair rejects an untrusted binary before copying it', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tools-untrusted-runtime-'));
  const spec = createToolProvisioningPlan({ profile: 'full', resolvedModules: ['codebase-memory'], targetDir })[0];
  const untrustedBinary = path.join(targetDir, 'codebase-memory-mcp.exe');
  try {
    await writeFile(untrustedBinary, 'untrusted binary\n', 'utf8');
    const repaired = await repairCodebaseMemoryBinary(spec, {
      locateBinary: async () => untrustedBinary,
      platform: 'win32',
    });
    assert.equal(repaired, false);
    await assert.rejects(
      readFile(path.join(spec.toolDir, 'node_modules/codebase-memory-mcp/bin/codebase-memory-mcp.exe')),
      /ENOENT/u,
    );
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('managed MCP block is idempotent and replaces only its own previous content', () => {
  const first = mergeManagedMcpBlock('', {
    agentmemory: { args: ['old.mjs'], command: 'node', env: {} },
  }).content;
  const second = mergeManagedMcpBlock(`${first}\n# local tail\n`, {
    agentmemory: { args: ['new.mjs'], command: 'node', env: {} },
  }).content;

  assert.equal((second.match(/# VIBE_HARNESS:MCP:START/gu) ?? []).length, 1);
  assert.equal(second.includes('old.mjs'), false);
  assert.equal(second.includes('new.mjs'), true);
  assert.equal(second.includes('# local tail'), true);
});

test('MCP configuration conflicts retain an actionable diagnostic', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tools-conflict-'));
  try {
    const report = await provisionProfileTools({
      commandRunner: async (request) => successfulToolOutput(request, targetDir),
      mcpConflicts: ['codebase-memory-mcp'],
      env: { OPENAI_API_KEY: 'configured' },
      profile: 'full',
      resolvedModules: ['codebase-memory'],
      targetDir,
    });

    assert.deepEqual(report.codebaseMemoryMcp.diagnostic, {
      code: 'MCP_CONFIG_CONFLICT',
      message: 'An unmanaged MCP server already uses the codebase-memory-mcp name.',
      phase: 'mcp-config',
      truncated: false,
    });
    assert.equal(report.codebaseMemoryMcp.status, 'degraded');
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('an unmanaged chrome-devtools server degrades only the Chrome tool', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-chrome-conflict-'));
  try {
    const report = await provisionProfileTools({
      commandRunner: async (request) => successfulToolOutput(request, targetDir),
      mcpConflicts: ['chrome-devtools'],
      env: {},
      profile: 'full',
      resolvedModules: ['chrome-devtools', 'playwright'],
      targetDir,
    });

    assert.equal(report.chromeDevtoolsMcp.status, 'degraded');
    assert.equal(report.chromeDevtoolsMcp.code, 'MCP_CONFIG_CONFLICT');
    assert.equal(report.chromeDevtoolsMcp.diagnostic.message, 'An unmanaged MCP server already uses the chrome-devtools name.');
    assert.notEqual(report.playwrightCli.status, 'degraded');
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('MCP configuration conflicts tell summary users to resolve the duplicate server', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tools-conflict-summary-'));
  try {
    await runCli(['init', '--project', targetDir]);
    const configPath = path.join(targetDir, '.codex/config.toml');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, '[mcp_servers.codebase-memory-mcp]\ncommand = "user-managed"\n', 'utf8');
    const projectConfigPath = path.join(targetDir, 'vibe-harness.config.json');
    const projectConfig = JSON.parse(await readFile(projectConfigPath, 'utf8'));
    await writeFile(projectConfigPath, `${JSON.stringify({ ...projectConfig, profile: 'full' }, null, 2)}\n`, 'utf8');

    const report = await runCli(
      ['install', '--project', targetDir, '--target', 'codex', '--profile', 'full', '--plugin', '-codebase-memory-mcp', '--write', '--provision', '--confirm-red-zone', '--allow-degraded'],
      { env: offlineEnv, timeout: 120_000 },
    );
    const summary = await runCliSummary(
      ['doctor', '--project', targetDir, '--profile', 'full', '--allow-degraded', '--output', 'summary'],
      { env: offlineEnv },
    );

    assert.equal(report.tools.codebaseMemoryMcp.code, 'MCP_CONFIG_CONFLICT');
    assert.match(summary, /reason: An unmanaged MCP server already uses the codebase-memory-mcp name\./u);
    assert.match(summary, /next: Remove or rename the unmanaged MCP server for codebaseMemoryMcp, then retry provisioning\./u);
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('full install map includes project-local runtimes and managed Codex MCP config', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tools-plan-'));
  try {
    await writeFile(path.join(targetDir, '.codex-config-local'), '', 'utf8');
    const full = await createInstallPlan({ allowPreview: true, dryRun: true, profile: 'full', requestedPlugins: PROFILE_TOOL_MODULES, rootDir, targetDir });
    const core = await createInstallPlan({ dryRun: true, profile: 'core', rootDir, targetDir });
    const fullTargets = full.actions.map((action) => action.relativeTarget);
    const coreTargets = core.actions.map((action) => action.relativeTarget);

    assert.equal(fullTargets.includes('.agents/runtime/tools/codebase-memory-mcp/package-lock.json'), true);
    assert.equal(fullTargets.includes('.cbmignore'), true);
    assert.equal(fullTargets.includes('.agents/runtime/tools/chrome-devtools-mcp/package-lock.json'), true);
    assert.equal(fullTargets.includes('.agents/runtime/tools/open-code-review/package-lock.json'), true);
    assert.equal(fullTargets.includes('.codex/config.toml'), true);
    assert.equal(coreTargets.includes('.codex/config.toml'), false);
    assert.equal(coreTargets.some((target) => target.includes('codebase-memory-mcp/package-lock.json')), false);
    assert.equal(full.generatedDirectories.some((item) => item.target.endsWith('codebase-memory-mcp/node_modules')), true);
    assert.equal(full.generatedDirectories.some((item) => item.target.endsWith('chrome-devtools-mcp/node_modules')), true);
    assert.equal(full.generatedDirectories.some((item) => item.target === '.vibe-harness/tool-state/codebase-memory-mcp'), true);

    const config = (await previewInstallPlan(full)).find((file) => file.target === '.codex/config.toml');
    const cbmignore = (await previewInstallPlan(full)).find((file) => file.target === '.cbmignore');
    assert.equal(full.actions.find((action) => action.relativeTarget === '.codex/config.toml').redZone, true);
    assert.match(config.content, /# VIBE_HARNESS:MCP:START[\s\S]*mcp_servers\.chrome-devtools[\s\S]*mcp_servers\.codebase-memory-mcp/u);
    assert.match(config.content, /CBM_MEM_BUDGET_MB = "2048"/u);
    assert.match(config.content, /CBM_WORKERS = "2"/u);
    assert.match(cbmignore.content, /# VIBE_HARNESS:CBM:START[\s\S]*\/\.agents\/[\s\S]*# VIBE_HARNESS:CBM:END/u);
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('full CLI dry-run includes all explicitly selected stable tools', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tools-cli-plan-'));
  try {
    await runCli(['init', '--project', targetDir]);
    const report = await runCli(
      ['install', '--project', targetDir, '--target', 'codex', '--profile', 'full', '--plugin', '-codebase-memory-mcp', 'playwright-cli', 'chrome-devtools-mcp', 'open-code-review', '--dry-run'],
      { env: { ...process.env, ANTHROPIC_API_KEY: '', OCR_LLM_MODEL: '', OCR_LLM_TOKEN: '', OCR_LLM_URL: '', OPENAI_API_KEY: '' } },
    );

    assert.deepEqual(report.plannedToolActions.map((item) => item.id), [
      'codebaseMemoryMcp', 'playwrightCli', 'chromeDevtoolsMcp', 'openCodeReview',
    ]);
    assert.deepEqual(report.deferredToolActions, []);
    assert.equal(report.tools.codebaseMemoryMcp.status, 'pending');
    assert.equal(report.tools.playwrightCli.status, 'pending');
    assert.equal(['pending', 'pending-config'].includes(report.tools.openCodeReview.status), true);
    await assert.rejects(readFile(path.join(targetDir, '.vibe-harness/tool-state/tools.json'), 'utf8'), /ENOENT/u);
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('tool command cancellation terminates the child before rejecting', async () => {
  const controller = new AbortController();
  const module = await import('../scripts/lib/tool-provisioning.js');
  const running = module.runToolCommand({
    args: ['-e', 'setInterval(() => {}, 1000)'],
    command: process.execPath,
    cwd: rootDir,
    env: process.env,
    signal: controller.signal,
    timeout: 10_000,
  });
  setTimeout(() => controller.abort(), 50);

  await assert.rejects(running, (error) => error.code === 'TOOL_CANCELLED');
});

test('codebase-memory ignore block preserves user rules and requires force for unmanaged files', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-cbmignore-'));
  try {
    const userContent = '# user rules\n/keep-private/\n';
    await writeFile(path.join(targetDir, '.cbmignore'), userContent, 'utf8');

    const blocked = await createInstallPlan({
      dryRun: true,
      force: false,
      profile: 'full',
      requestedPlugins: ['codebase-memory'],
      rootDir,
      targetDir,
    });
    assert.equal(blocked.actions.find((action) => action.relativeTarget === '.cbmignore').kind, 'conflict');

    const forced = await createInstallPlan({
      dryRun: true,
      force: true,
      profile: 'full',
      requestedPlugins: ['codebase-memory'],
      rootDir,
      targetDir,
    });
    const preview = (await previewInstallPlan(forced)).find((file) => file.target === '.cbmignore');
    assert.match(preview.content, /# user rules[\s\S]*\/keep-private\/[\s\S]*# VIBE_HARNESS:CBM:START/u);
    assert.equal(removeManagedCbmIgnoreBlock(preview.content), userContent);

    const updated = mergeManagedCbmIgnoreBlock(preview.content, '/.agents/\n/.vibe-harness/');
    assert.equal((updated.match(/# VIBE_HARNESS:CBM:START/gu) ?? []).length, 1);
    assert.match(updated, /\/keep-private\/[\s\S]*\/\.agents\/[\s\S]*\/\.vibe-harness\//u);

    assert.throws(
      () => mergeManagedCbmIgnoreBlock(`${preview.content}\n${preview.content}`, '/.agents/'),
      /multiple Vibe-Harness codebase-memory ignore blocks/iu,
    );
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('MCP handshake cancellation terminates the process and rejects as TOOL_CANCELLED', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-mcp-cancel-'));
  const script = path.join(targetDir, 'hanging-mcp.mjs');
  const controller = new AbortController();
  try {
    await writeFile(script, 'setInterval(() => {}, 1000);\n', 'utf8');
    const running = runMcpHandshake({
      args: [script],
      command: process.execPath,
      cwd: targetDir,
      env: process.env,
      signal: controller.signal,
      timeout: 10_000,
    });
    setTimeout(() => controller.abort(), 50);

    await assert.rejects(running, (error) => error.code === 'TOOL_CANCELLED');
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('tool processes receive only base variables and tool-specific credentials', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tools-env-policy-'));
  const requests = [];
  try {
    await provisionProfileTools({
      allowPreview: true,
      commandRunner: async (request) => requests.push(request),
      env: {
        ...process.env,
        VIBE_HARNESS_SECRET_SENTINEL: 'must-not-leak',
        OPENAI_API_KEY: 'ocr-only-secret',
      },
      profile: 'full',
      resolvedModules: ['open-code-review'],
      targetDir,
    });

    const openCodeReview = requests.find((request) => request.component === 'openCodeReview');
    assert.equal(openCodeReview.env.VIBE_HARNESS_SECRET_SENTINEL, undefined);
    assert.equal(openCodeReview.env.OPENAI_API_KEY, 'ocr-only-secret');
    assert.equal(openCodeReview.env.PATH ?? openCodeReview.env.Path, process.env.PATH ?? process.env.Path);
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('codebase-memory maps allowed-root path failures to a stable diagnostic code', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-index-path-'));
  try {
    const report = await provisionProfileTools({
      commandRunner: async (request) => {
        if (request.component === 'codebaseMemoryMcp' && request.phase === 'index') {
          throw Object.assign(new Error('repo_path is outside the allowed root'), {
            code: 'TOOL_COMMAND_FAILED',
            stderr: 'repo_path is outside the allowed root',
          });
        }
        return successfulToolOutput(request, targetDir);
      },
      env: { OPENAI_API_KEY: 'configured' },
      profile: 'full',
      resolvedModules: ['codebase-memory'],
      targetDir,
    });

    assert.equal(report.codebaseMemoryMcp.code, 'INDEX_PATH_OUTSIDE_ALLOWED_ROOT');
    assert.match(report.codebaseMemoryMcp.diagnostic.message, /outside the allowed root/iu);
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('MCP browser probe invokes list_pages after tool discovery', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-mcp-browser-probe-'));
  const script = path.join(targetDir, 'browser-probe.mjs');
  const marker = path.join(targetDir, 'list-pages-called.txt');
  try {
    await writeFile(script, [
      "import { writeFile } from 'node:fs/promises';",
      "import path from 'node:path';",
      "let buffer = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', async (chunk) => {",
      "  buffer += chunk;",
      "  const lines = buffer.split(/\\r?\\n/u);",
      "  buffer = lines.pop() ?? '';",
      "  for (const line of lines) {",
      "    if (!line.trim()) continue;",
      "    const message = JSON.parse(line);",
      "    if (message.id === 1) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fixture', version: '1.0.0' } } }) + '\\n');",
      "    if (message.id === 2) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'list_pages' }] } }) + '\\n');",
      `    if (message.id === 3 && message.method === 'tools/call' && message.params?.name === 'list_pages') { await writeFile(path.join(process.cwd(), ${JSON.stringify(path.basename(marker))}), 'called\\n'); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'about:blank' }] } }) + '\\n'); }`,
      "  }",
      "});",
      "setTimeout(() => {}, 10000);",
    ].join('\n'), 'utf8');

    await runMcpHandshake(
      { args: [script], command: process.execPath, cwd: targetDir, env: process.env, timeout: 2000 },
      { probeTool: 'list_pages' },
    );
    assert.equal(await readFile(marker, 'utf8'), 'called\n');
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('MCP browser probe maps list_pages failures without persisting probe response text', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-mcp-browser-failure-'));
  const script = path.join(targetDir, 'browser-probe-failure.mjs');
  try {
    await writeFile(script, [
      "let buffer = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => {",
      "  buffer += chunk;",
      "  const lines = buffer.split(/\\r?\\n/u);",
      "  buffer = lines.pop() ?? '';",
      "  for (const line of lines) {",
      "    if (!line.trim()) continue;",
      "    const message = JSON.parse(line);",
      "    if (message.id === 1) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fixture', version: '1.0.0' } } }) + '\\n');",
      "    if (message.id === 2) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'list_pages' }] } }) + '\\n');",
      "    if (message.id === 3) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 3, result: { isError: true, content: [{ type: 'text', text: 'sensitive-page-response' }] } }) + '\\n');",
      "  }",
      "});",
      "setTimeout(() => {}, 10000);",
    ].join('\n'), 'utf8');

    await assert.rejects(
      runMcpHandshake(
        { args: [script], command: process.execPath, cwd: targetDir, env: process.env, timeout: 2000 },
        { probeTool: 'list_pages' },
      ),
      (error) => {
        assert.equal(error.code, 'CHROME_LAUNCH_FAILED');
        assert.equal(error.stdout, '');
        assert.doesNotMatch(JSON.stringify(error), /sensitive-page-response/u);
        return true;
      },
    );
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('MCP browser probe reports initialize and tools/list JSON-RPC errors as protocol failures', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-mcp-protocol-failure-'));
  try {
    for (const failedId of [1, 2]) {
      const script = path.join(targetDir, `browser-protocol-failure-${failedId}.mjs`);
      await writeFile(script, [
        "let buffer = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => {",
        "  buffer += chunk;",
        "  const lines = buffer.split(/\\r?\\n/u);",
        "  buffer = lines.pop() ?? '';",
        "  for (const line of lines) {",
        "    if (!line.trim()) continue;",
        "    const message = JSON.parse(line);",
        `    if (message.id === ${failedId}) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: ${failedId}, error: { code: -32603, message: 'fixture protocol failure' } }) + '\\n');`,
        ...(failedId === 2 ? [
          "    if (message.id === 1) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fixture', version: '1.0.0' } } }) + '\\n');",
        ] : []),
        "  }",
        "});",
        "setTimeout(() => {}, 10000);",
      ].join('\n'), 'utf8');

      await assert.rejects(
        runMcpHandshake(
          { args: [script], command: process.execPath, cwd: targetDir, env: process.env, timeout: 500 },
          { probeTool: 'list_pages' },
        ),
        (error) => {
          assert.equal(error.code, 'MCP_PROTOCOL_ERROR');
          assert.notEqual(error.code, 'MCP_HANDSHAKE_TIMEOUT');
          return true;
        },
      );
    }
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('codebase-memory automatically rebuilds a corrupt cache on the next provision attempt', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-index-corrupt-'));
  const calls = [];
  try {
    await mkdir(path.join(targetDir, '.codebase-memory'), { recursive: true });
    await writeFile(path.join(targetDir, '.codebase-memory/graph.db.zst'), 'corrupt', 'utf8');
    const report = await provisionProfileTools({
      commandRunner: async (request) => {
        calls.push(request);
        if (request.component === 'codebaseMemoryMcp' && request.phase === 'index' && calls.filter((item) => item.phase === 'index').length === 1) {
          throw Object.assign(new Error('index database is corrupt; needs reindex'), {
            code: 'TOOL_COMMAND_FAILED',
            stderr: 'index database is corrupt; needs reindex',
          });
        }
        return successfulToolOutput(request, targetDir);
      },
      env: { OPENAI_API_KEY: 'configured' },
      profile: 'full',
      resolvedModules: ['codebase-memory'],
      targetDir,
    });

    const indexCalls = calls.filter((request) => request.phase === 'index');
    assert.equal(indexCalls.length, 2);
    assert.equal(path.basename(indexCalls[1].env.CBM_CACHE_DIR), 'cache');
    await assert.rejects(readFile(path.join(targetDir, '.codebase-memory/graph.db.zst')), /ENOENT/u);
    assert.equal(report.codebaseMemoryMcp.status, 'ready');
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('codebase-memory uses the same relative repo path for ASCII, spaced, and Unicode roots', async () => {
  for (const name of ['ascii', 'space path', '中文路径']) {
    const targetDir = await mkdtemp(path.join(tmpdir(), `vibe-harness-index-${name}-`));
    const calls = [];
    try {
      await provisionProfileTools({
        commandRunner: async (request) => {
          calls.push(request);
          return successfulToolOutput(request, targetDir);
        },
        env: { OPENAI_API_KEY: 'configured' },
        profile: 'full',
        resolvedModules: ['codebase-memory'],
        targetDir,
      });
      const index = calls.find((request) => request.phase === 'index');
      assert.equal(index.args[index.args.indexOf('--repo-path') + 1], '.');
      assert.equal(index.cwd, targetDir);
      assert.equal(index.env.CBM_ALLOWED_ROOT, targetDir);
    } finally {
      await rm(targetDir, { force: true, recursive: true });
    }
  }
});

test('OCR endpoint resolver prioritizes complete explicit credentials', async () => {
  const result = await resolveOcrEndpoint({
    env: {
      OCR_LLM_MODEL: 'explicit-model',
      OCR_LLM_TOKEN: 'explicit-token',
      OCR_LLM_URL: 'https://explicit.example/v1',
      OPENAI_API_KEY: 'compat-token',
    },
    homeDir: path.join(tmpdir(), 'missing-ocr-home'),
  });

  assert.equal(result.source, 'explicit');
  assert.deepEqual(result.env, {
    OCR_LLM_MODEL: 'explicit-model',
    OCR_LLM_TOKEN: 'explicit-token',
    OCR_LLM_URL: 'https://explicit.example/v1',
  });
});

test('OCR endpoint resolver reads the active user config before Codex fallback', async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-ocr-home-'));
  try {
    await mkdir(path.join(homeDir, '.opencodereview'), { recursive: true });
    await mkdir(path.join(homeDir, '.codex'), { recursive: true });
    await writeFile(path.join(homeDir, '.opencodereview/config.json'), JSON.stringify({
      provider: 'custom-review',
      custom_providers: {
        'custom-review': {
          api_key: 'ocr-user-token',
          model: 'ocr-user-model',
          protocol: 'openai',
          url: 'http://ocr-user.example/v1',
          auth_header: 'authorization',
          extra_headers: 'X-Org-ID=org-123',
          timeout_sec: 45,
        },
      },
    }), 'utf8');
    await writeFile(path.join(homeDir, '.codex/config.toml'), [
      'model = "codex-model"',
      'model_provider = "custom"',
      '[model_providers.custom]',
      'base_url = "http://codex.example/v1"',
      'wire_api = "responses"',
    ].join('\n'), 'utf8');

    const result = await resolveOcrEndpoint({ env: {}, homeDir });
    assert.equal(result.source, 'opencodereview');
    assert.equal(result.env.OCR_LLM_URL, 'http://ocr-user.example/v1/chat/completions');
    assert.equal(result.env.OCR_LLM_MODEL, 'ocr-user-model');
    assert.equal(result.env.OCR_LLM_TOKEN, 'ocr-user-token');
    assert.equal(result.env.OCR_LLM_PROTOCOL, 'openai');
    assert.equal(result.env.OCR_USE_ANTHROPIC, 'false');
    assert.equal(result.env.OCR_LLM_AUTH_HEADER, 'authorization');
    assert.equal(result.env.OCR_LLM_EXTRA_HEADERS, 'X-Org-ID=org-123');
    assert.equal(result.env.OCR_LLM_TIMEOUT, '45');
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test('OCR endpoint resolver supports Anthropic and OpenAI compatibility variables', async () => {
  const anthropic = await resolveOcrEndpoint({
    env: {
      ANTHROPIC_AUTH_TOKEN: 'anthropic-token',
      ANTHROPIC_BASE_URL: 'https://anthropic.example',
      ANTHROPIC_MODEL: 'anthropic-model',
    },
    homeDir: path.join(tmpdir(), 'missing-ocr-home'),
  });
  assert.equal(anthropic.source, 'compat-env');
  assert.equal(anthropic.env.OCR_LLM_TOKEN, 'anthropic-token');
  assert.equal(anthropic.env.OCR_LLM_URL, 'https://anthropic.example/messages');
  assert.equal(anthropic.env.OCR_LLM_MODEL, 'anthropic-model');
  assert.equal(anthropic.env.ANTHROPIC_AUTH_TOKEN, 'anthropic-token');

  const openai = await resolveOcrEndpoint({
    env: {
      OPENAI_API_KEY: 'openai-token',
      OPENAI_BASE_URL: 'https://openai.example/v1',
    },
    homeDir: path.join(tmpdir(), 'missing-ocr-home'),
  });
  assert.equal(openai.source, 'compat-env');
  assert.equal(openai.env.OCR_LLM_TOKEN, 'openai-token');
  assert.equal(openai.env.OCR_LLM_URL, 'https://openai.example/v1/chat/completions');
  assert.equal(openai.env.OCR_LLM_MODEL, undefined);
});

test('OCR endpoint resolver returns pending-config and redacted diagnostics for malformed config', async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-ocr-invalid-'));
  try {
    await mkdir(path.join(homeDir, '.opencodereview'), { recursive: true });
    await writeFile(
      path.join(homeDir, '.opencodereview/config.json'),
      '{"provider":"broken","custom_providers":{"broken":{"api_key":"do-not-return"}}}',
      'utf8',
    );
    const result = await resolveOcrEndpoint({ env: {}, homeDir });
    assert.equal(result.status, 'pending-config');
    assert.equal(result.env, undefined);
    assert.equal(JSON.stringify(result).includes('do-not-return'), false);
    assert.match(result.diagnostic.message, /missing|incomplete|configuration/iu);
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test('installed tool wrappers enforce runtime environment allowlists', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-runtime-env-'));
  const fixtureSource = 'console.log(JSON.stringify({ cbmRoot: process.env.CBM_ALLOWED_ROOT, cbmMemory: process.env.CBM_MEM_BUDGET_MB, cbmWorkers: process.env.CBM_WORKERS, openai: process.env.OPENAI_API_KEY, sentinel: process.env.VIBE_HARNESS_SECRET_SENTINEL }));\n';
  const cases = [
    {
      entry: 'node_modules/@alibaba-group/open-code-review/bin/ocr.js',
      expected: { openai: 'ocr-secret' },
      runtime: 'open-code-review',
    },
    {
      entry: 'node_modules/codebase-memory-mcp/bin.js',
      expected: { cbmMemory: '2048', cbmRoot: targetDir, cbmWorkers: '2' },
      runtime: 'codebase-memory-mcp',
    },
  ];
  try {
    for (const item of cases) {
      const runtimeDir = path.join(targetDir, item.runtime);
      const entryPath = path.join(runtimeDir, item.entry);
      await mkdir(path.dirname(entryPath), { recursive: true });
      await copyFile(path.join(rootDir, `runtime/tools/${item.runtime}/run.mjs`), path.join(runtimeDir, 'run.mjs'));
      if (item.runtime === 'codebase-memory-mcp') {
        await copyFile(
          path.join(rootDir, 'runtime/tools/codebase-memory-mcp/path-alias.mjs'),
          path.join(runtimeDir, 'path-alias.mjs'),
        );
      }
      if (item.runtime === 'open-code-review') {
        await copyFile(
          path.join(rootDir, 'runtime/tools/open-code-review/ocr-config.mjs'),
          path.join(runtimeDir, 'ocr-config.mjs'),
        );
      }
      await writeFile(entryPath, fixtureSource, 'utf8');
      const { stdout } = await execFileAsync(process.execPath, [path.join(runtimeDir, 'run.mjs')], {
        cwd: targetDir,
        env: {
          ...process.env,
          CBM_ALLOWED_ROOT: targetDir,
          CBM_MEM_BUDGET_MB: '2048',
          CBM_WORKERS: '2',
          VIBE_HARNESS_SECRET_SENTINEL: 'must-not-leak',
          OPENAI_API_KEY: 'ocr-secret',
        },
      });
      const observed = JSON.parse(stdout);
      assert.deepEqual(observed, item.expected);
    }
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('cancelled provisioning preserves an interrupted process marker for doctor', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tools-interrupted-'));
  const controller = new AbortController();
  try {
    await runCli(['init', '--project', targetDir, '--profile', 'core']);
    await runCli(['install', '--project', targetDir, '--profile', 'core', '--write']);
    await assert.rejects(
      provisionProfileTools({
        commandRunner: async () => {
          controller.abort();
          throw Object.assign(new Error('token=must-not-leak'), { code: 'TOOL_CANCELLED' });
        },
        env: process.env,
        profile: 'full',
        resolvedModules: ['codebase-memory'],
        signal: controller.signal,
        targetDir,
      }),
      (error) => error.code === 'TOOL_CANCELLED',
    );

    const markerText = await readFile(path.join(targetDir, '.vibe-harness/tool-state/provisioning.json'), 'utf8');
    const marker = JSON.parse(markerText);
    assert.equal(marker.status, 'interrupted');
    assert.equal(marker.currentTool, 'codebaseMemoryMcp');
    assert.equal(markerText.includes('must-not-leak'), false);

    const doctor = await runCli(['doctor', '--project', targetDir, '--allow-degraded']);
    assert.equal(doctor.status, 'degraded');
    assert.equal(doctor.provisioningProcess.status, 'interrupted');
    assert.equal(doctor.warnings.some((warning) => warning.code === 'PROVISIONING_PROCESS_INCOMPLETE'), true);
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('full write installs governance assets without provisioning tools by default', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tools-assets-only-'));
  try {
    await runCli(['init', '--project', targetDir, '--profile', 'full']);
    const report = await runCli([
      'install', '--project', targetDir, '--target', 'codex', '--profile', 'full', '--write', '--confirm-red-zone',
    ], { env: offlineEnv });

    assert.equal(report.status, 'ready');
    assert.deepEqual(report.provisioning, { executed: false, requested: false });
    assert.deepEqual(report.warnings, []);
    assert.deepEqual(report.tools, {});
    await assert.rejects(readFile(path.join(targetDir, '.vibe-harness/tool-state/tools.json'), 'utf8'), /ENOENT/u);

    const validation = await runCli(['validate', '--project', targetDir], { env: offlineEnv });
    assert.equal(validation.status, 'ready');
    assert.deepEqual(validation.tools, {});

    const doctor = await runCli(['doctor', '--project', targetDir], { env: offlineEnv });
    assert.equal(doctor.status, 'ready');
    assert.deepEqual(doctor.tools, {});
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('provision previews and writes only explicitly selected tools', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tools-provision-command-'));
  try {
    await runCli(['init', '--project', targetDir, '--profile', 'full']);
    await runCli([
      'install', '--project', targetDir, '--target', 'codex', '--profile', 'full', '--plugin', '-open-code-review', '--write', '--confirm-red-zone',
    ], { env: offlineEnv });

    const preview = await runCli([
      'provision', '--project', targetDir, '--target', 'codex', '--profile', 'full', '--tool', 'openCodeReview', '--dry-run',
    ], { env: offlineEnv });
    assert.deepEqual(preview.plannedToolActions.map((item) => item.id), ['openCodeReview']);
    assert.equal(preview.dryRun, true);
    await assert.rejects(readFile(path.join(targetDir, '.vibe-harness/tool-state/tools.json'), 'utf8'), /ENOENT/u);

    const result = await runCli([
      'provision', '--project', targetDir, '--target', 'codex', '--profile', 'full', '--tool', 'openCodeReview', '--write', '--allow-degraded',
    ], { env: offlineEnv });
    assert.deepEqual(Object.keys(result.tools), ['openCodeReview']);
    const state = JSON.parse(await readFile(path.join(targetDir, '.vibe-harness/tool-state/tools.json'), 'utf8'));
    assert.deepEqual(Object.keys(state.tools), ['openCodeReview']);
    assert.match(state.tools.openCodeReview.source, /^npm:@alibaba-group\/open-code-review@/u);
    assert.equal(Number.isNaN(Date.parse(state.tools.openCodeReview.startedAt)), false);
    assert.equal(Number.isNaN(Date.parse(state.tools.openCodeReview.finishedAt)), false);
    assert.equal(state.tools.openCodeReview.result, state.tools.openCodeReview.status);
    assert.equal(typeof state.tools.openCodeReview.logSummary, 'string');
    assert.equal(state.tools.openCodeReview.logSummary.includes('secret'), false);
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('provision rejects tool directories redirected outside the project', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tools-link-project-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tools-link-outside-'));
  try {
    await runCli(['init', '--project', targetDir, '--profile', 'full']);
    await runCli([
      'install', '--project', targetDir, '--target', 'codex', '--profile', 'full', '--plugin', '-open-code-review', '--write', '--confirm-red-zone',
    ], { env: offlineEnv });
    const toolDir = path.join(targetDir, '.agents/runtime/tools/open-code-review');
    await rm(toolDir, { force: true, recursive: true });
    await symlink(outside, toolDir, process.platform === 'win32' ? 'junction' : 'dir');

    await assert.rejects(
      execFileAsync(process.execPath, [
        cliPath, 'provision', '--project', targetDir, '--profile', 'full', '--tool', 'openCodeReview', '--write', '--allow-degraded',
      ], { cwd: rootDir, env: offlineEnv }),
      /link|junction|reparse/iu,
    );
    assert.deepEqual(await import('node:fs/promises').then(({ readdir }) => readdir(outside)), []);
  } finally {
    await rm(targetDir, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  }
});

test('full write degrades unavailable tools and rollback removes only the managed MCP block', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tools-cli-write-'));
  try {
    await runCli(['init', '--project', targetDir]);
    const projectConfigPath = path.join(targetDir, 'vibe-harness.config.json');
    const projectConfig = JSON.parse(await readFile(projectConfigPath, 'utf8'));
    await writeFile(projectConfigPath, `${JSON.stringify({ ...projectConfig, profile: 'full' }, null, 2)}\n`, 'utf8');
    const configPath = path.join(targetDir, '.codex/config.toml');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, 'model = "gpt-5"\n', 'utf8');

    const report = await runCli(
      ['install', '--project', targetDir, '--target', 'codex', '--profile', 'full', '--plugin', '-codebase-memory-mcp', 'playwright-cli', 'chrome-devtools-mcp', 'open-code-review', '--write', '--provision', '--confirm-red-zone', '--allow-degraded'],
      { env: offlineEnv, timeout: 120_000 },
    );
    const config = await readFile(configPath, 'utf8');

    assert.equal(config.includes('model = "gpt-5"'), true);
    assert.equal(config.includes('# VIBE_HARNESS:MCP:START'), true);
    assert.equal(config.includes('[mcp_servers.chrome-devtools]'), true);
    assert.equal(await readFile(path.join(targetDir, '.agents/runtime/tools/chrome-devtools-mcp/run.mjs'), 'utf8').then(Boolean), true);
    assert.equal(Object.values(report.tools).some((tool) => tool.status === 'degraded'), true);
    assert.equal(report.status, 'degraded');
    assert.equal(report.ok, false);
    assert.equal(report.warnings.length > 0, true);

    const failedValidation = await runCliFailure(['validate', '--project', targetDir], { env: offlineEnv });
    assert.equal(failedValidation.code, 2);
    assert.equal(failedValidation.report.status, 'degraded');
    assert.equal(failedValidation.report.ok, false);
    const validation = await runCli(['validate', '--project', targetDir, '--allow-degraded'], { env: offlineEnv });
    assert.equal(validation.status, 'degraded');
    assert.equal(validation.ok, false);
    assert.equal(validation.warnings.length > 0, true);

    const failedDoctor = await runCliFailure(['doctor', '--project', targetDir, '--profile', 'full'], { env: offlineEnv });
    assert.equal(failedDoctor.code, 2);
    const doctor = await runCli(['doctor', '--project', targetDir, '--profile', 'full', '--allow-degraded'], { env: offlineEnv });
    assert.equal(doctor.status, 'degraded');
    assert.equal(doctor.ok, false);
    const degradedRecommendation = doctor.recommendations.find(
      (recommendation) => recommendation.tool === 'codebaseMemoryMcp',
    );
    assert.equal(degradedRecommendation.phase, doctor.tools.codebaseMemoryMcp.phase);
    assert.equal(degradedRecommendation.action, 'retry-provision');
    assert.match(degradedRecommendation.command, /provision --project <project> --target codex --profile full --write/u);
    assert.equal(JSON.stringify(degradedRecommendation).includes(targetDir), false);

    const summary = await runCliSummary(
      ['doctor', '--project', targetDir, '--profile', 'full', '--allow-degraded', '--output', 'summary'],
      { env: offlineEnv },
    );
    assert.match(summary, /tool: codebaseMemoryMcp/u);
    assert.match(summary, /phase: dependency-install/u);
    assert.match(summary, /reason: Offline test fixture\./u);
    assert.match(summary, /next: vibe-harness provision --project <project> --target codex --profile full --write/u);

    await runCli(['rollback', '--project', targetDir, '--write', '--confirm-red-zone'], { env: offlineEnv });
    const rolledBack = await readFile(configPath, 'utf8');
    assert.equal(rolledBack.includes('model = "gpt-5"'), true);
    assert.equal(rolledBack.includes('# VIBE_HARNESS:MCP:START'), false);
    await assert.rejects(readFile(path.join(targetDir, '.agents/runtime/tools/chrome-devtools-mcp/run.mjs'), 'utf8'), /ENOENT/u);
    await assert.rejects(readFile(path.join(targetDir, '.vibe-harness/tool-state/tools.json'), 'utf8'), /ENOENT/u);
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('core plugin provisioning failures degrade health and exit status', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-core-plugin-degraded-'));
  try {
    await runCli(['init', '--project', targetDir]);
    const report = await runCli([
      'install', '--project', targetDir, '--target', 'codex', '--profile', 'core',
      '--plugin', '-chrome-devtools-mcp', '--write', '--provision',
      '--confirm-red-zone', '--allow-degraded',
    ], { env: offlineEnv, timeout: 120_000 });

    assert.equal(report.tools.chromeDevtoolsMcp.status, 'degraded');
    assert.equal(report.status, 'degraded');
    assert.equal(report.ok, false);

    const failedDoctor = await runCliFailure(['doctor', '--project', targetDir], { env: offlineEnv });
    assert.equal(failedDoctor.code, 2);
    assert.equal(failedDoctor.report.status, 'degraded');
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});
