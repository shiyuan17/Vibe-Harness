import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { createInstallPlan, previewInstallPlan } from '../scripts/lib/install-planner.js';
import {
  createToolProvisioningPlan,
  inspectProfileTools,
  mergeManagedMcpBlock,
  provisionProfileTools,
  runMcpHandshake,
} from '../scripts/lib/tool-provisioning.js';

const rootDir = path.resolve('.');
const execFileAsync = promisify(execFile);
const cliPath = path.join(rootDir, 'scripts/loopengine.js');
const offlineEnv = {
  ...process.env,
  ANTHROPIC_API_KEY: '',
  OCR_LLM_MODEL: '',
  OCR_LLM_TOKEN: '',
  OCR_LLM_URL: '',
  OPENAI_API_KEY: '',
  npm_config_cache: path.join(tmpdir(), 'loopengine-empty-npm-cache'),
  npm_config_offline: 'true',
};

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

test('full tool plan pins four project-local components while core keeps Playwright lazy', () => {
  const targetDir = path.resolve('target-project');
  const full = createToolProvisioningPlan({ profile: 'full', targetDir });
  const core = createToolProvisioningPlan({ profile: 'core', targetDir });

  assert.deepEqual(
    full.map(({ id, version }) => ({ id, version })),
    [
      { id: 'codebaseMemoryMcp', version: '0.9.0' },
      { id: 'playwrightCli', version: '0.1.17' },
      { id: 'openCodeReview', version: '1.7.7' },
      { id: 'agentmemory', version: '0.9.27' },
    ],
  );
  assert.equal(full.every((item) => item.toolDir.startsWith(targetDir)), true);
  assert.deepEqual(core.map(({ id, mode }) => ({ id, mode })), [{ id: 'playwrightCli', mode: 'lazy' }]);
});

test('managed MCP block preserves local TOML and refuses duplicate unmanaged server tables', () => {
  const local = [
    'model = "gpt-5"',
    '',
    '[mcp_servers.agentmemory]',
    'command = "user-memory"',
    '',
  ].join('\n');

  const result = mergeManagedMcpBlock(local, {
    agentmemory: { args: ['memory.mjs'], command: 'node', env: { HOME: 'project-home' } },
    'codebase-memory-mcp': { args: ['codebase.mjs'], command: 'node', env: { CBM_ALLOWED_ROOT: 'project' } },
  });

  assert.equal(result.content.includes('model = "gpt-5"'), true);
  assert.equal(result.content.includes('command = "user-memory"'), true);
  assert.equal(result.content.includes('# LOOPENGINE:MCP:START'), true);
  assert.equal(result.content.includes('[mcp_servers.codebase-memory-mcp]'), true);
  assert.equal(result.content.includes('[mcp_servers.agentmemory]\ncommand = "node"'), false);
  assert.deepEqual(result.conflicts, ['agentmemory']);
});

test('provisioning continues after one component fails and never persists command secrets', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'loopengine-tools-'));
  const calls = [];
  const env = {
    OCR_LLM_TOKEN: 'super-secret-token',
    OCR_LLM_URL: 'https://llm.example.test',
    OCR_LLM_MODEL: 'test-model',
  };
  try {
    const report = await provisionProfileTools({
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
        return { stdout: '{"ok":true}' };
      },
      env,
      profile: 'full',
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
    assert.equal(report.agentmemory.status, 'ready');
    assert.equal(calls.some((call) => call.component === 'agentmemory' && call.phase === 'mcp-handshake'), true);
    assert.equal(calls.some((call) => call.component === 'openCodeReview' && call.phase === 'llm-test'), true);
    const dependency = calls.find((call) => call.component === 'agentmemory' && call.phase === 'dependency-install');
    assert.equal(dependency.args.includes('ci'), true);
    assert.equal(dependency.args.includes('--omit=optional'), true);
    assert.equal(dependency.cwd.startsWith(targetDir), true);
    const index = calls.find((call) => call.component === 'codebaseMemoryMcp' && call.phase === 'index');
    const indexInput = JSON.parse(index.args.at(-1));
    assert.equal(indexInput.repo_path, targetDir);
    assert.equal(indexInput.mode, 'moderate');
    assert.equal(indexInput.persistence, false);
    assert.equal(index.env.CBM_ALLOWED_ROOT, targetDir);
    assert.equal(index.env.CBM_CACHE_DIR.startsWith(targetDir), true);
    const agentmemory = calls.find((call) => call.component === 'agentmemory' && call.phase === 'mcp-handshake');
    assert.equal(agentmemory.env.HOME.startsWith(targetDir), true);
    assert.equal(agentmemory.env.USERPROFILE, agentmemory.env.HOME);

    const state = await readFile(path.join(targetDir, '.loopengine/tool-state/tools.json'), 'utf8');
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

test('every full-profile tool persists a sanitized diagnostic for its failed phase', async () => {
  const failures = [
    ['codebaseMemoryMcp', 'index'],
    ['playwrightCli', 'browser-install'],
    ['openCodeReview', 'llm-test'],
    ['agentmemory', 'mcp-handshake'],
  ];
  for (const [toolId, phase] of failures) {
    const targetDir = await mkdtemp(path.join(tmpdir(), `loopengine-diagnostic-${toolId}-`));
    try {
      const report = await provisionProfileTools({
        commandRunner: async (request) => {
          if (request.component === toolId && request.phase === phase) {
            throw Object.assign(new Error('token=diagnostic-secret'), {
              code: 'TOOL_COMMAND_FAILED',
              exitCode: 9,
              stderr: `failed in ${targetDir}: Bearer diagnostic-secret`,
            });
          }
          return { stdout: '{}' };
        },
        env: { OPENAI_API_KEY: 'configured' },
        profile: 'full',
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
  const targetDir = await mkdtemp(path.join(tmpdir(), 'loopengine-tools-timeout-'));
  const calls = [];
  try {
    await provisionProfileTools({
      commandRunner: async (request) => { calls.push(request); return { stdout: '{}' }; },
      env: { LOOPENGINE_TOOL_TIMEOUT_MS: '1500', OPENAI_API_KEY: 'configured' },
      profile: 'full',
      targetDir,
    });
    assert.equal(calls.length > 0, true);
    assert.equal(calls.every((request) => request.timeout <= 1500), true);
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('MCP handshake reports a closed stdin without an unhandled EPIPE', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'loopengine-mcp-stdin-'));
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
  const targetDir = await mkdtemp(path.join(tmpdir(), 'loopengine-tools-pending-'));
  try {
    const report = await provisionProfileTools({
      commandRunner: async () => ({ stdout: '{}' }),
      env: {},
      profile: 'full',
      targetDir,
    });
    const inspected = await inspectProfileTools('full', targetDir);

    assert.equal(report.openCodeReview.status, 'pending-config');
    assert.equal(report.openCodeReview.phase, 'llm-config');
    assert.equal(inspected.openCodeReview.status, 'pending-config');
    assert.equal(inspected.codebaseMemoryMcp.version, '0.9.0');
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('unchanged OCR pending-config is reused until credentials become available', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'loopengine-tools-ocr-reuse-'));
  const ocr = createToolProvisioningPlan({ profile: 'full', targetDir })
    .find((tool) => tool.id === 'openCodeReview');
  const calls = [];
  const runner = async (request) => {
    calls.push(request);
    return { stdout: '{}' };
  };
  try {
    await mkdir(ocr.toolDir, { recursive: true });
    await writeFile(path.join(ocr.toolDir, 'package-lock.json'), 'ocr-lock\n', 'utf8');

    await provisionProfileTools({ commandRunner: runner, env: {}, profile: 'full', targetDir });
    const firstOcrCallCount = calls.filter((call) => call.component === 'openCodeReview').length;
    await provisionProfileTools({ commandRunner: runner, env: {}, profile: 'full', targetDir });
    assert.equal(calls.filter((call) => call.component === 'openCodeReview').length, firstOcrCallCount);

    const configured = await provisionProfileTools({
      commandRunner: runner,
      env: { OPENAI_API_KEY: 'configured' },
      profile: 'full',
      targetDir,
    });
    assert.equal(configured.openCodeReview.status, 'ready');
    assert.equal(calls.some((call) => call.component === 'openCodeReview' && call.phase === 'llm-test'), true);
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('ready tools reuse matching lockfiles while a changed lockfile reprovisions its component', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'loopengine-tools-reuse-'));
  const plan = createToolProvisioningPlan({ profile: 'full', targetDir });
  const calls = [];
  const runner = async (request) => {
    calls.push(request);
    return { stdout: '{}' };
  };
  const env = { OPENAI_API_KEY: 'configured' };
  try {
    for (const tool of plan) {
      await mkdir(tool.toolDir, { recursive: true });
      await writeFile(path.join(tool.toolDir, 'package-lock.json'), `${tool.id}\n`, 'utf8');
    }
    await provisionProfileTools({ commandRunner: runner, env, profile: 'full', targetDir });
    const firstCallCount = calls.length;
    await provisionProfileTools({ commandRunner: runner, env, profile: 'full', targetDir });
    assert.equal(calls.length, firstCallCount);

    const agentmemory = plan.find((tool) => tool.id === 'agentmemory');
    await writeFile(path.join(agentmemory.toolDir, 'package-lock.json'), 'changed\n', 'utf8');
    await provisionProfileTools({ commandRunner: runner, env, profile: 'full', targetDir });
    const newCalls = calls.slice(firstCallCount);
    assert.equal(newCalls.every((call) => call.component === 'agentmemory'), true);
    assert.equal(newCalls.length > 0, true);
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

  assert.equal((second.match(/# LOOPENGINE:MCP:START/gu) ?? []).length, 1);
  assert.equal(second.includes('old.mjs'), false);
  assert.equal(second.includes('new.mjs'), true);
  assert.equal(second.includes('# local tail'), true);
});

test('MCP configuration conflicts retain an actionable diagnostic', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'loopengine-tools-conflict-'));
  try {
    const report = await provisionProfileTools({
      commandRunner: async () => ({ stdout: '{}' }),
      mcpConflicts: ['codebase-memory-mcp'],
      env: { OPENAI_API_KEY: 'configured' },
      profile: 'full',
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

test('MCP configuration conflicts tell summary users to resolve the duplicate server', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'loopengine-tools-conflict-summary-'));
  try {
    await runCli(['init', '--project', targetDir]);
    const configPath = path.join(targetDir, '.codex/config.toml');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, '[mcp_servers.codebase-memory-mcp]\ncommand = "user-managed"\n', 'utf8');
    const projectConfigPath = path.join(targetDir, 'loopengine.config.json');
    const projectConfig = JSON.parse(await readFile(projectConfigPath, 'utf8'));
    await writeFile(projectConfigPath, `${JSON.stringify({ ...projectConfig, profile: 'full' }, null, 2)}\n`, 'utf8');

    const report = await runCli(
      ['install', '--project', targetDir, '--target', 'codex', '--profile', 'full', '--write', '--confirm-red-zone', '--allow-degraded'],
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
  const targetDir = await mkdtemp(path.join(tmpdir(), 'loopengine-tools-plan-'));
  try {
    await writeFile(path.join(targetDir, '.codex-config-local'), '', 'utf8');
    const full = await createInstallPlan({ dryRun: true, profile: 'full', rootDir, targetDir });
    const core = await createInstallPlan({ dryRun: true, profile: 'core', rootDir, targetDir });
    const fullTargets = full.actions.map((action) => action.relativeTarget);
    const coreTargets = core.actions.map((action) => action.relativeTarget);

    assert.equal(fullTargets.includes('.agents/loopengine/tools/codebase-memory-mcp/package-lock.json'), true);
    assert.equal(fullTargets.includes('.agents/loopengine/tools/open-code-review/package-lock.json'), true);
    assert.equal(fullTargets.includes('.agents/loopengine/tools/agentmemory/package-lock.json'), true);
    assert.equal(fullTargets.includes('.codex/config.toml'), true);
    assert.equal(coreTargets.includes('.codex/config.toml'), false);
    assert.equal(coreTargets.some((target) => target.includes('codebase-memory-mcp/package-lock.json')), false);
    assert.equal(full.generatedDirectories.some((item) => item.target.endsWith('codebase-memory-mcp/node_modules')), true);
    assert.equal(full.generatedDirectories.some((item) => item.target.endsWith('agentmemory/node_modules')), true);
    assert.equal(full.generatedDirectories.some((item) => item.target === '.loopengine/tool-state/codebase-memory-mcp'), true);

    const config = (await previewInstallPlan(full)).find((file) => file.target === '.codex/config.toml');
    assert.equal(full.actions.find((action) => action.relativeTarget === '.codex/config.toml').redZone, true);
    assert.match(config.content, /# LOOPENGINE:MCP:START[\s\S]*mcp_servers\.agentmemory[\s\S]*mcp_servers\.codebase-memory-mcp/u);
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('full CLI dry-run reports four planned tools without provisioning them', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'loopengine-tools-cli-plan-'));
  try {
    await runCli(['init', '--project', targetDir]);
    const report = await runCli(
      ['install', '--project', targetDir, '--target', 'codex', '--profile', 'full', '--dry-run'],
      { env: { ...process.env, ANTHROPIC_API_KEY: '', OCR_LLM_MODEL: '', OCR_LLM_TOKEN: '', OCR_LLM_URL: '', OPENAI_API_KEY: '' } },
    );

    assert.deepEqual(report.plannedToolActions.map((item) => item.id), [
      'codebaseMemoryMcp', 'playwrightCli', 'openCodeReview', 'agentmemory',
    ]);
    assert.equal(report.tools.codebaseMemoryMcp.status, 'pending');
    assert.equal(report.tools.playwrightCli.status, 'pending');
    assert.equal(report.tools.openCodeReview.status, 'pending-config');
    assert.equal(report.tools.agentmemory.status, 'pending');
    await assert.rejects(readFile(path.join(targetDir, '.loopengine/tool-state/tools.json'), 'utf8'), /ENOENT/u);
    await assert.rejects(readFile(path.join(targetDir, '.agents/loopengine/tools/agentmemory/node_modules/.package-lock.json'), 'utf8'), /ENOENT/u);
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('full write degrades unavailable tools and rollback removes only the managed MCP block', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'loopengine-tools-cli-write-'));
  try {
    await runCli(['init', '--project', targetDir]);
    const projectConfigPath = path.join(targetDir, 'loopengine.config.json');
    const projectConfig = JSON.parse(await readFile(projectConfigPath, 'utf8'));
    await writeFile(projectConfigPath, `${JSON.stringify({ ...projectConfig, profile: 'full' }, null, 2)}\n`, 'utf8');
    const configPath = path.join(targetDir, '.codex/config.toml');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, 'model = "gpt-5"\n', 'utf8');

    const report = await runCli(
      ['install', '--project', targetDir, '--target', 'codex', '--profile', 'full', '--write', '--confirm-red-zone', '--allow-degraded'],
      { env: offlineEnv, timeout: 120_000 },
    );
    const config = await readFile(configPath, 'utf8');

    assert.equal(config.includes('model = "gpt-5"'), true);
    assert.equal(config.includes('# LOOPENGINE:MCP:START'), true);
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
    assert.match(degradedRecommendation.command, /install --project <project> --target codex --profile full --write --confirm-red-zone/u);
    assert.equal(JSON.stringify(degradedRecommendation).includes(targetDir), false);

    const summary = await runCliSummary(
      ['doctor', '--project', targetDir, '--profile', 'full', '--allow-degraded', '--output', 'summary'],
      { env: offlineEnv },
    );
    assert.match(summary, /tool: codebaseMemoryMcp/u);
    assert.match(summary, /phase: dependency-install/u);
    assert.match(summary, /reason: npm error request .*cache mode is 'only-if-cached'/u);
    assert.match(summary, /next: loopengine install --project <project> --target codex --profile full --write --confirm-red-zone/u);

    await runCli(['rollback', '--project', targetDir, '--write', '--confirm-red-zone'], { env: offlineEnv });
    const rolledBack = await readFile(configPath, 'utf8');
    assert.equal(rolledBack.includes('model = "gpt-5"'), true);
    assert.equal(rolledBack.includes('# LOOPENGINE:MCP:START'), false);
    await assert.rejects(readFile(path.join(targetDir, '.loopengine/tool-state/tools.json'), 'utf8'), /ENOENT/u);
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});
