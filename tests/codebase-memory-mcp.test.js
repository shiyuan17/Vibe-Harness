import './helpers/offline-tools.js';

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  aliasPathForRoot,
  replaceAliasInStatusOutput,
} from '../runtime/tools/codebase-memory-mcp/path-alias.mjs';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '..');
const cliPath = path.join(rootDir, 'scripts/vibe-harness.js');

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

test('Vibe-Harness removes the CodeGraph CLI integration and doctor report', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-doctor-'));
  try {
    const help = await execFileAsync(process.execPath, [cliPath, 'help']);
    assert.equal(help.stdout.toLowerCase().includes('codegraph'), false);
    await execFileAsync(process.execPath, [cliPath, 'init', '--project', target]);

    let doctor;
    try {
      doctor = await execFileAsync(process.execPath, [cliPath, 'doctor', '--project', target]);
    } catch (error) {
      doctor = error;
    }
    const report = JSON.parse(doctor.stdout || doctor.stderr);
    assert.equal(Object.hasOwn(report, 'codegraph'), false);
    assert.equal(await exists(path.join(rootDir, 'scripts/lib/codegraph.js')), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('codebase-memory-mcp rule uses MCP tools and a repository-search fallback without global writes', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-codebase-memory-profile-'));
  const rulePath = path.join(rootDir, 'rules/codebase-memory-mcp.md');
  const ruleSource = await readFile(rulePath, 'utf8');
  const marker = String.fromCharCode(96);
  const rule = ruleSource.replaceAll('<code>', marker).replaceAll('</code>', marker);
  const agents = await readFile(path.join(rootDir, 'adapters/codex/AGENTS.template.md'), 'utf8');

  try {
    for (const tool of ['index_repository', 'index_status', 'search_graph', 'get_code_snippet', 'trace_call_path', 'detect_changes', 'get_architecture']) {
      assert.equal(rule.includes(`\`${tool}\``), true, `${tool} should be documented`);
    }
    assert.equal(rule.includes('<code>trace_path</code>'), false);
    assert.match(rule, /search_graph.*get_code_snippet.*trace_call_path/su);
    assert.match(rule, /MCP.*不可用.*(?:rg|仓库搜索)/su);
    assert.match(rule, /不得.*(?:全局|Agent).*配置/su);
    assert.equal(rule.includes('codebase-memory-mcp install'), false);
    assert.equal(agents.includes('codebase-memory-mcp'), false);
    assert.equal(agents.toLowerCase().includes('codegraph'), false);
    assert.equal(await exists(path.join(rootDir, 'rules/codegraph.md')), false);

    await execFileAsync(process.execPath, [cliPath, 'init', '--project', target]);
    const core = await execFileAsync(process.execPath, [cliPath, 'install', '--project', target, '--target', 'codex', '--profile', 'core', '--dry-run', '--verbose']);
    const full = await execFileAsync(process.execPath, [cliPath, 'install', '--project', target, '--target', 'codex', '--profile', 'full', '--dry-run', '--verbose']);
    const selected = await execFileAsync(process.execPath, [cliPath, 'install', '--project', target, '--target', 'codex', '--profile', 'full', '--plugin', '-codebase-memory-mcp', '--dry-run', '--verbose']);
    const coreAgents = JSON.parse(core.stdout).previewFiles.find((file) => file.target === 'AGENTS.md').content;
    const fullAgents = JSON.parse(full.stdout).previewFiles.find((file) => file.target === 'AGENTS.md').content;
    const selectedAgents = JSON.parse(selected.stdout).previewFiles.find((file) => file.target === 'AGENTS.md').content;

    assert.equal(coreAgents.includes('codebase-memory-mcp'), false);
    assert.equal(fullAgents.includes('codebase-memory-mcp'), false);
    assert.equal(selectedAgents.includes('codebase-memory-mcp'), true);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('codebase-memory uses a stable Windows alias for the same Unicode root', () => {
  const root = 'D:\\projects\\web-ui\\组件\\code\\sample-admin';
  const first = aliasPathForRoot(root);
  const second = aliasPathForRoot(root);

  assert.equal(first, second);
  assert.match(path.basename(first), /^vibe-harness-cbm-[a-f0-9]{16}$/u);
  assert.notEqual(aliasPathForRoot(`${root}-other`), first);
});

test('codebase-memory preserves valid JSON when replacing a Windows alias in status output', () => {
  const alias = 'C:\\Users\\test\\AppData\\Local\\Temp\\vibe-harness-cbm-0123456789abcdef';
  const target = 'D:\\projects\\web-ui\\组件\\code\\sample-admin';
  const output = JSON.stringify({ root_path: alias, status: 'ready' });
  const parsed = JSON.parse(replaceAliasInStatusOutput(output, alias, target));

  assert.equal(parsed.root_path, target);
  assert.equal(parsed.status, 'ready');
});
