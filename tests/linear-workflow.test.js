import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { parse as parseToml } from '@iarna/toml';
import { parse as parseJsonc } from 'jsonc-parser';

import { parsePluginsOption, pluginModules, resolveModuleSelection } from '../scripts/lib/module-selection.js';
import { mergeManagedMcpBlock } from '../scripts/lib/tool-provisioning.js';

const rootDir = path.resolve(import.meta.dirname, '..');
const cliPath = path.join(rootDir, 'scripts/vibe-harness.js');
const execFileAsync = promisify(execFile);

async function runCli(args) {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: rootDir,
    maxBuffer: 1024 * 1024 * 8,
  });
  return JSON.parse(stdout);
}

async function runCliFailure(args) {
  try {
    await runCli(args);
  } catch (error) {
    return JSON.parse(error.stdout || error.stderr);
  }
  assert.fail('Expected CLI command to fail');
}

test('Linear MCP plugins are explicit alternatives and stay outside plugin all', () => {
  assert.deepEqual(parsePluginsOption('linear-mcp'), ['linear']);
  assert.deepEqual(parsePluginsOption('linear-mcp-readonly'), ['linear-readonly']);
  assert.equal(pluginModules.includes('linear'), false);
  assert.equal(pluginModules.includes('linear-readonly'), false);
  assert.equal(parsePluginsOption('all').includes('linear'), false);
  assert.throws(
    () => resolveModuleSelection({ requestedPlugins: ['linear', 'linear-readonly'] }),
    /mutually exclusive/u,
  );
});

test('managed Codex MCP block renders remote URL servers and preserves local servers', () => {
  const result = mergeManagedMcpBlock('', {
    linear: { url: 'https://mcp.linear.app/mcp' },
    local: { command: 'node', args: ['server.mjs'], env: {} },
  });
  const parsed = parseToml(result.content);
  assert.equal(parsed.mcp_servers.linear.url, 'https://mcp.linear.app/mcp');
  assert.equal(Object.hasOwn(parsed.mcp_servers.linear, 'command'), false);
  assert.equal(parsed.mcp_servers.local.command, 'node');
  assert.deepEqual(parsed.mcp_servers.local.args, ['server.mjs']);
  assert.throws(
    () => mergeManagedMcpBlock('', { invalid: { command: 'node', args: [], url: 'https://example.invalid' } }),
    /exactly one of command or url/u,
  );
  assert.throws(
    () => mergeManagedMcpBlock('', { invalid: {} }),
    /exactly one of command or url/u,
  );
  assert.throws(
    () => mergeManagedMcpBlock('', { invalid: { url: 'https://example.invalid', env: {} } }),
    /exactly one of command or url/u,
  );
  const takeover = mergeManagedMcpBlock([
    'model = "gpt-5"',
    '[mcp_servers.linear]',
    'url = "https://user.example/mcp"',
    '[mcp_servers.user-tool]',
    'command = "node"',
    'args = ["user.mjs"]',
    '',
  ].join('\n'), { linear: { url: 'https://mcp.linear.app/mcp' } }, { force: true });
  const takeoverConfig = parseToml(takeover.content);
  assert.deepEqual(takeover.conflicts, []);
  assert.equal(takeoverConfig.model, 'gpt-5');
  assert.equal(takeoverConfig.mcp_servers.linear.url, 'https://mcp.linear.app/mcp');
  assert.equal(takeoverConfig.mcp_servers['user-tool'].command, 'node');
});

test('Codex Linear plugins render read-write and read-only project MCP endpoints', async () => {
  for (const [plugin, endpoint, access] of [
    ['linear-mcp', 'https://mcp.linear.app/mcp', 'read-write'],
    ['linear-mcp-readonly', 'https://mcp.linear.app/mcp/readonly', 'read-only'],
  ]) {
    const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-linear-codex-'));
    try {
      await runCli(['init', '--project', target, '--target', 'codex']);
      const report = await runCli([
        'install', '--project', target, '--target', 'codex', '--profile', 'core',
        '--plugin', plugin, '--dry-run', '--verbose',
      ]);
      assert.equal(report.linearMcp.codex.access, access);
      assert.equal(report.linearMcp.codex.configuration, 'managed');
      assert.equal(report.linearMcp.codex.endpoint, endpoint);
      assert.equal(report.warnings.some((item) => item.code === 'LINEAR_MCP_AUTH_REQUIRED'), true);
      assert.equal(report.requiresRedZoneConfirmation, true);
      const config = report.previewFiles.find((item) => item.target === '.codex/config.toml');
      assert.ok(config);
      assert.equal(parseToml(config.content).mcp_servers.linear.url, endpoint);
      assert.doesNotMatch(config.content, /token|api[_-]?key|bearer/iu);
      assert.equal(report.actions.some((item) => item.relativeTarget === 'docs/rules/linear-workflow.md'), true);
      assert.equal(report.actions.some((item) => item.relativeTarget === '.agents/skills/linear-workflow/SKILL.md'), true);
      assert.equal(report.actions.some((item) => item.relativeTarget === 'docs/templates/linear/ai-coding-task.md'), true);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  }
});

test('OpenCode JSONC renders a remote Linear server while preserving user content', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-linear-opencode-jsonc-'));
  try {
    await runCli(['init', '--project', target, '--target', 'opencode']);
    await writeFile(path.join(target, 'opencode.jsonc'), [
      '{',
      '  // project-owned setting',
      '  "theme": "system",',
      '}',
      '',
    ].join('\n'), 'utf8');
    const report = await runCli([
      'install', '--project', target, '--target', 'opencode', '--profile', 'core',
      '--plugin', 'linear-mcp', '--dry-run', '--verbose', '--allow-preview', '--force',
    ]);
    const preview = report.previewFiles.find((item) => item.target === 'opencode.jsonc');
    assert.ok(preview);
    assert.match(preview.content, /project-owned setting/u);
    const config = parseJsonc(preview.content);
    assert.equal(config.theme, 'system');
    assert.deepEqual(config.mcp['vibe-harness-linear'], {
      type: 'remote',
      url: 'https://mcp.linear.app/mcp',
      enabled: true,
    });
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test('stable JSON adapters render Linear remote configuration in their native shape', async () => {
  const adapters = [
    ['cursor', '.cursor/mcp.json'],
    ['qoder', '.mcp.json'],
    ['zcode', '.zcode/config.json'],
    ['antigravity', '.agents/mcp_config.json'],
    ['opencode', 'opencode.json'],
  ];
  for (const [adapter, configTarget] of adapters) {
    const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-linear-' + adapter + '-'));
    try {
      await runCli(['init', '--project', target, '--target', adapter]);
      const report = await runCli([
        'install', '--project', target, '--target', adapter, '--profile', 'core',
        '--plugin', 'linear-mcp', '--dry-run', '--verbose', '--allow-preview',
      ]);
      assert.equal(report.linearMcp[adapter].configuration, 'managed');
      const preview = report.previewFiles.find((item) => item.target === configTarget);
      assert.ok(preview, adapter + ' should render its project MCP config');
      const config = JSON.parse(preview.content);
      const server = adapter === 'opencode'
        ? config.mcp['vibe-harness-linear']
        : (adapter === 'zcode'
          ? config.mcp.servers['vibe-harness-linear']
          : config.mcpServers['vibe-harness-linear']);
      assert.equal(server.url, 'https://mcp.linear.app/mcp');
      if (adapter === 'opencode') assert.equal(server.type, 'remote');
      assert.doesNotMatch(preview.content, /token|api[_-]?key|bearer/iu);
      assert.equal(report.actions.some((item) => item.relativeTarget === 'docs/rules/linear-workflow.md'), true);
      if (adapter === 'zcode') {
        assert.equal(report.actions.some((item) => item.relativeTarget.includes('/skills/linear-workflow/')), false);
      }
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  }
});

test('Claude and Gemini install Linear guidance and report manual MCP setup', async () => {
  for (const adapter of ['claude', 'gemini']) {
    const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-linear-manual-' + adapter + '-'));
    try {
      await runCli(['init', '--project', target, '--target', adapter]);
      const report = await runCli([
        'install', '--project', target, '--target', adapter, '--profile', 'core',
        '--plugin', 'linear-mcp', '--dry-run', '--verbose', '--allow-preview',
      ]);
      assert.equal(report.linearMcp[adapter].configuration, 'manual');
      assert.equal(report.warnings.some((item) => item.code === 'LINEAR_MCP_MANUAL_SETUP'), true);
      assert.equal(report.actions.some((item) => item.relativeTarget === 'docs/rules/linear-workflow.md'), true);
      assert.equal(report.actions.some((item) => item.mcpServers?.linear), false);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  }
});

test('Codex Linear install validates and uninstalls without persisting credentials', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-linear-lifecycle-'));
  try {
    await runCli(['init', '--project', target, '--target', 'codex']);
    await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', 'linear-mcp', '--write', '--confirm-red-zone',
    ]);
    const configPath = path.join(target, '.codex/config.toml');
    const content = await readFile(configPath, 'utf8');
    assert.equal(parseToml(content).mcp_servers.linear.url, 'https://mcp.linear.app/mcp');
    assert.doesNotMatch(content, /token|api[_-]?key|bearer/iu);
    assert.equal((await runCli(['validate', '--project', target])).ok, true);
    await runCli(['rollback', '--project', target, '--write', '--confirm-red-zone']);
    await assert.rejects(readFile(configPath, 'utf8'), /ENOENT/u);
    await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', 'linear-mcp', '--write', '--confirm-red-zone',
    ]);
    await runCli(['uninstall', '--project', target, '--all-targets', '--write', '--confirm-red-zone']);
    await assert.rejects(readFile(configPath, 'utf8'), /ENOENT/u);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test('Codex reports an unmanaged Linear MCP name conflict without overwriting it', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-linear-conflict-'));
  try {
    await runCli(['init', '--project', target, '--target', 'codex']);
    await mkdir(path.join(target, '.codex'), { recursive: true });
    await writeFile(path.join(target, '.codex/config.toml'), [
      '[mcp_servers.linear]',
      'url = "https://user.example/mcp"',
      '',
    ].join('\n'), 'utf8');
    const report = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', 'linear-mcp', '--dry-run', '--verbose',
    ]);
    const config = report.previewFiles.find((item) => item.target === '.codex/config.toml');
    assert.deepEqual(config.conflicts, ['linear']);
    assert.match(config.content, /https:\/\/user\.example\/mcp/u);
    assert.doesNotMatch(config.content, /https:\/\/mcp\.linear\.app\/mcp/u);
    const takeover = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', 'linear-mcp', '--dry-run', '--verbose', '--force',
    ]);
    const forcedConfig = takeover.previewFiles.find((item) => item.target === '.codex/config.toml');
    assert.deepEqual(forcedConfig.conflicts, []);
    assert.equal(parseToml(forcedConfig.content).mcp_servers.linear.url, 'https://mcp.linear.app/mcp');
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test('Linear plugin pair is rejected by the CLI', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-linear-exclusive-'));
  try {
    await runCli(['init', '--project', target, '--target', 'codex']);
    const failure = await runCliFailure([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', 'linear-mcp', '--plugin', 'linear-mcp-readonly', '--dry-run',
    ]);
    assert.match(failure.error.message, /mutually exclusive/u);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});
