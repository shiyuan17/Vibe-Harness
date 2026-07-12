import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { resolveModuleSelection } from '../scripts/lib/module-selection.js';
import { validateProjectConfig } from '../scripts/lib/project-config.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '..');
const cliPath = path.join(rootDir, 'scripts/loopengine.js');

async function runCli(args) {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], { cwd: rootDir });
  return JSON.parse(stdout);
}

test('public modules resolve dependencies without exposing install-map groups', () => {
  const selection = resolveModuleSelection({ requestedModules: ['agentmemory', 'hooks'] });

  assert.deepEqual(selection.requestedModules, ['agentmemory', 'hooks']);
  assert.deepEqual(selection.resolvedModules, [
    'agents', 'rules', 'templates', 'governance', 'skills', 'memory', 'agentmemory', 'hooks',
  ]);
  assert.deepEqual(selection.implicitModules, ['agents', 'rules', 'templates', 'governance', 'skills', 'memory']);
  assert.equal(selection.allowedGroups.has('tools-agentmemory'), true);
  assert.equal(selection.allowedGroups.has('tools-codebase-memory'), false);
  assert.equal(selection.allowedGroups.has('mcp-config'), true);
});

test('module selection rejects empty, duplicate, and unknown module ids', () => {
  assert.throws(() => resolveModuleSelection({ requestedModules: [] }), /at least one module/u);
  assert.throws(() => resolveModuleSelection({ requestedModules: ['rules', 'rules'] }), /duplicate module/u);
  assert.throws(() => resolveModuleSelection({ requestedModules: ['unknown'] }), /Unknown module/u);
});

test('project config accepts valid modules and rejects invalid module arrays', () => {
  const base = {
    packageManager: 'pnpm',
    profile: 'core',
    projectName: 'Example',
    target: 'codex',
    validationCommands: { governance: 'node validate.mjs', lint: null, typecheck: null },
  };
  assert.equal(validateProjectConfig({ ...base, modules: ['rules'] }), true);
  assert.throws(() => validateProjectConfig({ ...base, modules: [] }), /at least one module/u);
  assert.throws(() => validateProjectConfig({ ...base, modules: ['missing'] }), /Unknown module/u);
});

test('CLI modules override config and provision only the selected tool capability', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-modules-'));
  try {
    await runCli(['init', '--project', target]);
    const configPath = path.join(target, 'loopengine.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    await writeFile(configPath, `${JSON.stringify({ ...config, modules: ['open-code-review'] }, null, 2)}\n`, 'utf8');

    const report = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--modules', 'codebase-memory', '--dry-run',
    ]);

    assert.deepEqual(report.requestedModules, ['codebase-memory']);
    assert.deepEqual(report.resolvedModules, ['agents', 'rules', 'codebase-memory']);
    assert.deepEqual(report.implicitModules, ['agents', 'rules']);
    assert.deepEqual(report.plannedToolActions.map((item) => item.id), ['codebaseMemoryMcp']);
    assert.equal(report.actions.some((item) => item.relativeTarget.includes('codebase-memory-mcp/package.json')), true);
    assert.equal(report.actions.some((item) => item.relativeTarget.includes('open-code-review/package.json')), false);
    assert.equal(report.actions.some((item) => item.relativeTarget === '.codex/config.toml'), true);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('project validation reuses CLI module selection recorded by the install state', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-modules-validate-'));
  try {
    await runCli(['init', '--project', target]);
    await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--modules', 'agents,rules', '--write',
    ]);

    const validation = await runCli(['validate', '--project', target]);
    assert.equal(validation.ok, true);
    const state = JSON.parse(await readFile(path.join(target, '.loopengine', 'install-state.json'), 'utf8'));
    assert.deepEqual(state.requestedModules, ['agents', 'rules']);
    assert.deepEqual(state.resolvedModules, ['agents', 'rules']);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
