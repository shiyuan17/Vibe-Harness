import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { parse } from 'jsonc-parser';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '../..');
const cliPath = path.join(rootDir, 'scripts/vibe-harness.js');

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

async function run(args) {
  const result = await execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: rootDir,
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}

async function fail(args) {
  try { await run(args); } catch (error) { return JSON.parse(error.stderr); }
  assert.fail('Expected command to fail');
}

async function runAllowIncomplete(args) {
  try { return await run(args); } catch (error) {
    if (error.stdout) return JSON.parse(error.stdout);
    throw error;
  }
}

function installArgs(target, extra = []) {
  return [
    'install', '--project', target, '--target', 'opencode', '--profile', 'core',
    '--plugin', 'codebase-memory', ...extra,
  ];
}

const OPENCODE_AGENT_FILES = [
  'adversarial-security-reviewer.md',
  'chief-architect.md',
  'product-manager.md',
  'senior-engineer.md',
  'technical-project-manager.md',
  'technical-release-manager.md',
  'test-lead.md',
];

test('OpenCode role agents deny delegation, fetch, and search and keep the bash allowlist after the catch-all', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-opencode-roles-'));
  try {
    await run(['init', '--project', target, '--target', 'opencode', '--profile', 'full']);
    const installed = await run([
      'install', '--project', target, '--target', 'opencode', '--profile', 'full',
      '--allow-preview', '--write', '--confirm-red-zone',
    ]);
    assert.equal(installed.ok, true);
    const agentsDir = path.join(target, '.opencode', 'agents');
    const names = (await readdir(agentsDir)).filter((name) => name.endsWith('.md')).sort();
    assert.deepEqual(names, OPENCODE_AGENT_FILES);
    for (const name of names) {
      const content = await readFile(path.join(agentsDir, name), 'utf8');
      assert.match(content, /^mode: subagent$/mu, name + ' must stay a subagent');
      for (const key of ['task', 'webfetch', 'websearch']) {
        assert.match(content, new RegExp('^  ' + key + ': deny$', 'mu'), name + ' must deny ' + key);
      }
      const executable = ['senior-engineer.md', 'test-lead.md', 'technical-release-manager.md'].includes(name);
      assert.match(
        content,
        new RegExp('^  external_directory: ' + (executable ? 'ask' : 'deny') + '$', 'mu'),
        name + ' external directory decision',
      );
      const bashLines = content.slice(content.indexOf('\n  bash:\n')).split('\n').slice(2)
        .filter((line) => line.startsWith('    '));
      // OpenCode resolves the last matching pattern, so the catch-all is written
      // first and every later entry narrows it to an argument-free read command.
      assert.equal(bashLines[0], '    "*": ' + (executable ? 'ask' : 'deny'), name + ' catch-all goes first');
      if (!executable) {
        assert.equal(bashLines.length, 1, name + ' must keep bash fully disabled');
      } else {
        assert.ok(bashLines.length > 100, name + ' needs the read-only allowlist');
        for (const line of bashLines.slice(1)) {
          assert.match(line, /^ {4}".+": allow$/u, name + ' allowlist entries must be quoted read-only commands');
        }
      }
    }
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('OpenCode exposes all profiles, native Skills, shared instructions, and degraded safety', async () => {
  for (const profile of ['minimal', 'core', 'full', 'docs-only']) {
    const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-opencode-profile-'));
    try {
      await run(['init', '--project', target, '--target', 'opencode', '--profile', profile]);
      const preview = await run([
        'install', '--project', target, '--target', 'opencode', '--profile', profile,
        '--dry-run', ...(profile === 'full' ? ['--allow-preview'] : []),
      ]);
      assert.equal(preview.actions.filter((action) => action.relativeTarget === 'AGENTS.md').length, 1);
      assert.equal(preview.warnings.some((warning) => warning.code === 'DEGRADED_SAFETY_POSTURE'), true);
      assert.equal(preview.adapterCapabilities.hooks, 'unsupported');
      assert.equal(preview.adapterCapabilities.mcp, 'stable');
      if (profile === 'core' || profile === 'full') {
        assert.equal(preview.actions.some((action) => action.relativeTarget.startsWith('.opencode/skills/')), true);
      }
    } finally {
      await rm(target, { force: true, recursive: true });
    }
  }
});

test('OpenCode JSONC MCP lifecycle preserves comments, formatting, trailing commas, and user properties', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-opencode-jsonc-'));
  try {
    await run(['init', '--project', target, '--target', 'opencode', '--profile', 'core']);
    const configPath = path.join(target, 'opencode.jsonc');
    const original = [
      '{',
      '  // project-owned OpenCode settings',
      '  "theme": "system",',
      '  "mcp": {',
      '    "custom": { "type": "remote", "url": "https://example.invalid" },',
      '    "vibe-harness-codebase-memory-mcp": { "type": "local", "command": ["user-owned"] },',
      '  },',
      '}',
      '',
    ].join('\n');
    await writeFile(configPath, original, 'utf8');

    const preview = await run([...installArgs(target), '--dry-run']);
    assert.equal(preview.actions.find((action) => action.relativeTarget === 'opencode.jsonc').kind, 'conflict');
    assert.equal((await fail([...installArgs(target), '--write', '--force'])).error.message.includes('red-zone confirmation'), true);
    const installed = await run([...installArgs(target), '--write', '--force', '--confirm-red-zone']);
    assert.equal(installed.warnings.some((warning) => warning.code === 'DEGRADED_SAFETY_POSTURE'), true);

    const content = await readFile(configPath, 'utf8');
    assert.match(content, /project-owned OpenCode settings/u);
    assert.match(content, /"custom"/u);
    assert.match(content, /,\s*\}/u);
    const errors = [];
    const config = parse(content, errors, { allowTrailingComma: true, disallowComments: false });
    assert.deepEqual(errors, []);
    const server = config.mcp['vibe-harness-codebase-memory-mcp'];
    assert.equal(server.type, 'local');
    assert.equal(server.command[0], process.execPath);
    assert.match(server.command[1], /codebase-memory-mcp[\\/]run\.mjs$/u);
    assert.equal(server.environment.CBM_ALLOWED_ROOT, target);
    assert.equal(server.enabled, true);

    const state = JSON.parse(await readFile(path.join(target, '.vibe-harness/install-state.json'), 'utf8'));
    const managed = state.files.find((file) => file.target === 'opencode.jsonc');
    assert.deepEqual(managed.owners, ['adapter:opencode']);
    assert.equal(managed.managedJson.syntax, 'jsonc');
    assert.equal((await run(['validate', '--project', target])).status, 'ready');
    assert.equal((await run(['doctor', '--project', target])).warnings.some((warning) => warning.code === 'DEGRADED_SAFETY_POSTURE'), true);
    assert.equal((await run(['diff', '--project', target])).adapters.opencode.status, 'preview');

    await run([...installArgs(target), '--write', '--upgrade', '--confirm-red-zone']);
    assert.equal(await readFile(configPath, 'utf8'), content);

    await run(['uninstall', '--project', target, '--all-targets', '--write', '--confirm-red-zone']);
    const remaining = await readFile(configPath, 'utf8');
    assert.match(remaining, /project-owned OpenCode settings/u);
    const remainingConfig = parse(remaining, [], { allowTrailingComma: true, disallowComments: false });
    assert.equal(remainingConfig.theme, 'system');
    assert.equal(Object.hasOwn(remainingConfig.mcp, 'custom'), true);
    assert.equal(Object.hasOwn(remainingConfig.mcp, 'vibe-harness-codebase-memory-mcp'), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('OpenCode rejects dual configs, invalid JSONC, and non-object mcp even with force', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-opencode-invalid-'));
  try {
    await run(['init', '--project', target, '--target', 'opencode', '--profile', 'core']);
    await writeFile(path.join(target, 'opencode.json'), '{}\n', 'utf8');
    await writeFile(path.join(target, 'opencode.jsonc'), '{}\n', 'utf8');
    assert.match((await fail([...installArgs(target), '--dry-run', '--force'])).error.message, /Conflicting adapter configuration files/u);

    await rm(path.join(target, 'opencode.json'), { force: true });
    await writeFile(path.join(target, 'opencode.jsonc'), '{ invalid', 'utf8');
    assert.match((await fail([...installArgs(target), '--dry-run', '--force'])).error.message, /JSONC configuration is invalid/u);

    await writeFile(path.join(target, 'opencode.jsonc'), '{ "mcp": [] }\n', 'utf8');
    assert.match((await fail([...installArgs(target), '--dry-run', '--force'])).error.message, /path mcp must contain an object/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('OpenCode created config is removed by rollback and uninstall while modified managed MCP is protected', async () => {
  const rollbackTarget = await mkdtemp(path.join(tmpdir(), 'vibe-harness-opencode-rollback-'));
  const modifiedTarget = await mkdtemp(path.join(tmpdir(), 'vibe-harness-opencode-modified-'));
  try {
    await run(['init', '--project', rollbackTarget, '--target', 'opencode', '--profile', 'core']);
    await run([...installArgs(rollbackTarget), '--write', '--confirm-red-zone']);
    assert.equal(await exists(path.join(rollbackTarget, 'opencode.json')), true);
    await run(['rollback', '--project', rollbackTarget, '--write', '--confirm-red-zone']);
    assert.equal(await exists(path.join(rollbackTarget, 'opencode.json')), false);

    await run(['init', '--project', modifiedTarget, '--target', 'opencode', '--profile', 'core']);
    await run([...installArgs(modifiedTarget), '--write', '--confirm-red-zone']);
    const configPath = path.join(modifiedTarget, 'opencode.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.mcp['vibe-harness-codebase-memory-mcp'].enabled = false;
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    const result = await runAllowIncomplete(['uninstall', '--project', modifiedTarget, '--all-targets', '--write', '--confirm-red-zone']);
    assert.deepEqual(result.skipped, [{ reason: 'managed-block-modified', target: 'opencode.json' }]);
    assert.equal(await exists(configPath), true);
  } finally {
    await rm(rollbackTarget, { force: true, recursive: true });
    await rm(modifiedTarget, { force: true, recursive: true });
  }
});
