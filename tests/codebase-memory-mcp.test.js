import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve('.');
const cliPath = path.join(rootDir, 'scripts/loopengine.js');

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

test('LoopEngine removes the CodeGraph CLI integration and doctor report', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-doctor-'));
  try {
    const help = await execFileAsync(process.execPath, [cliPath, 'help']);
    assert.equal(help.stdout.toLowerCase().includes('codegraph'), false);

    const doctor = await execFileAsync(process.execPath, [cliPath, 'doctor', '--target', target]);
    const report = JSON.parse(doctor.stdout);
    assert.equal(Object.hasOwn(report, 'codegraph'), false);
    assert.equal(await exists(path.join(rootDir, 'scripts/lib/codegraph.js')), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('codebase-memory-mcp rule uses MCP tools and a repository-search fallback without global writes', async () => {
  const rulePath = path.join(rootDir, 'rules/codebase-memory-mcp.md');
  const rule = await readFile(rulePath, 'utf8');
  const agents = await readFile(path.join(rootDir, 'adapters/codex/AGENTS.template.md'), 'utf8');

  for (const tool of ['index_repository', 'index_status', 'search_graph', 'trace_call_path', 'detect_changes', 'get_architecture']) {
    assert.equal(rule.includes(`\`${tool}\``), true, `${tool} should be documented`);
  }
  assert.match(rule, /MCP.*不可用.*(?:rg|仓库搜索)/su);
  assert.match(rule, /不得.*(?:全局|Agent).*配置/su);
  assert.equal(rule.includes('codebase-memory-mcp install'), false);
  assert.equal(agents.includes('codebase-memory-mcp'), true);
  assert.equal(agents.toLowerCase().includes('codegraph'), false);
  assert.equal(await exists(path.join(rootDir, 'rules/codegraph.md')), false);
});
