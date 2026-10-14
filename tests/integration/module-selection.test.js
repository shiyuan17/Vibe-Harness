import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { parsePluginsOption, resolveModuleSelection } from '../../scripts/lib/module-selection.js';
import { validateProjectConfig } from '../../scripts/lib/project-config.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '../..');
const cliPath = path.join(rootDir, 'scripts/vibe-harness.js');

async function runCli(args) {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], { cwd: rootDir, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function runCliFailure(args) {
  try {
    await runCli(args);
  } catch (error) {
    return JSON.parse(error.stdout || error.stderr);
  }
  assert.fail(`Expected command to fail: ${args.join(' ')}`);
}

test('public modules resolve dependencies without exposing install-map groups', () => {
  const selection = resolveModuleSelection({ requestedModules: ['memory', 'hooks'] });

  assert.deepEqual(selection.requestedModules, ['memory', 'hooks']);
  assert.deepEqual(selection.resolvedModules, [
    'agents', 'rules', 'templates', 'skills', 'memory', 'hooks',
  ]);
  assert.deepEqual(selection.implicitModules, ['agents', 'rules', 'templates', 'skills']);
  assert.equal(selection.allowedGroups.has('skills-memory'), true);
  assert.equal(selection.allowedGroups.has('tools-codebase-memory'), false);
  assert.equal(selection.allowedGroups.has('mcp-config'), false);
});

test('project-scripts is a standalone deterministic runtime module and is included by core/full', () => {
  const standalone = resolveModuleSelection({ requestedModules: ['project-scripts'] });
  assert.deepEqual(standalone.resolvedModules, ['project-scripts']);
  assert.deepEqual(standalone.implicitModules, []);
  assert.equal(standalone.allowedGroups.has('runtime-project-scripts'), true);

  for (const profile of ['core', 'full']) {
    const selection = resolveModuleSelection({ profile });
    assert.equal(selection.resolvedModules.includes('project-scripts'), true);
    assert.equal(selection.allowedGroups.has('runtime-project-scripts'), true);
  }
});

test('chrome-devtools module installs its rule, runtime, skills, and managed MCP surface', async () => {
  const selection = resolveModuleSelection({ requestedModules: ['chrome-devtools'] });

  assert.deepEqual(selection.resolvedModules, ['agents', 'rules', 'templates', 'skills', 'chrome-devtools']);
  assert.deepEqual(selection.implicitModules, ['agents', 'rules', 'templates', 'skills']);
  assert.equal(selection.allowedGroups.has('rules-chrome-devtools'), true);
  assert.equal(selection.allowedGroups.has('tools-chrome-devtools'), true);
  assert.equal(selection.allowedGroups.has('mcp-config'), true);

  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-chrome-devtools-module-'));
  try {
    await runCli(['init', '--project', target]);
    const report = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--modules', 'chrome-devtools', '--dry-run', '--verbose',
    ]);

    assert.deepEqual(report.plannedToolActions.map((item) => item.id), ['chromeDevtoolsMcp']);
    assert.equal(report.actions.some((item) => item.relativeTarget === 'docs/rules/chrome-devtools-mcp.md'), true);
    assert.equal(report.actions.some((item) => item.relativeTarget === '.agents/runtime/tools/chrome-devtools-mcp/run.mjs'), true);
    assert.equal(report.actions.some((item) => item.relativeTarget === '.codex/config.toml'), true);
    const agentsPreview = report.previewFiles.find((item) => item.target === 'AGENTS.md');
    assert.match(agentsPreview.content, /vibe-harness doctor --project <path>/u);
    assert.doesNotMatch(agentsPreview.content, /vibe-harness doctor --target <path>/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
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
    validationCommands: { lint: null, typecheck: null, test: null, eval: null },
  };
  assert.equal(validateProjectConfig({ ...base, modules: ['rules'] }), true);
  assert.throws(() => validateProjectConfig({ ...base, modules: [] }), /at least one module/u);
  assert.throws(() => validateProjectConfig({ ...base, modules: ['missing'] }), /Unknown module/u);
});

test('CLI modules override config and provision only the selected tool capability', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-modules-'));
  try {
    await runCli(['init', '--project', target]);
    const configPath = path.join(target, 'vibe-harness.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    await writeFile(configPath, `${JSON.stringify({ ...config, modules: ['open-code-review'] }, null, 2)}\n`, 'utf8');

    const report = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--modules', 'chrome-devtools', '--dry-run',
    ]);

    assert.deepEqual(report.requestedModules, ['chrome-devtools']);
    assert.deepEqual(report.resolvedModules, ['agents', 'rules', 'templates', 'skills', 'chrome-devtools']);
    assert.deepEqual(report.implicitModules, ['agents', 'rules', 'templates', 'skills']);
    assert.deepEqual(report.plannedToolActions.map((item) => item.id), ['chromeDevtoolsMcp']);
    assert.equal(report.actions.some((item) => item.relativeTarget.includes('chrome-devtools-mcp/package.json')), true);
    assert.equal(report.actions.some((item) => item.relativeTarget.includes('open-code-review/package.json')), false);
    assert.equal(report.actions.some((item) => item.relativeTarget === '.codex/config.toml'), true);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('project validation reuses CLI module selection recorded by the install state', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-modules-validate-'));
  try {
    await runCli(['init', '--project', target]);
    await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--modules', 'agents,rules', '--write',
    ]);

    const validation = await runCli(['validate', '--project', target]);
    assert.equal(validation.ok, true);
    const state = JSON.parse(await readFile(path.join(target, '.vibe-harness', 'install-state.json'), 'utf8'));
    assert.deepEqual(state.requestedModules, ['agents', 'rules']);
    assert.deepEqual(state.resolvedModules, ['agents', 'rules']);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('replaying an install keeps the recorded module selection instead of retiring it', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-modules-replay-'));
  try {
    await runCli(['init', '--project', target]);
    await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'full',
      '--modules', 'evals,memory', '--write',
    ]);
    const state = JSON.parse(await readFile(path.join(target, '.vibe-harness', 'install-state.json'), 'utf8'));
    assert.deepEqual(state.requestedModules, ['evals', 'memory']);

    // A replay that only names a profile must not recompute the surface from
    // that profile: doing so drops the recorded modules and retires their
    // files, which previously deleted installed memory artifacts.
    const replay = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'full', '--dry-run',
    ]);
    assert.deepEqual(replay.requestedModules, ['evals', 'memory']);
    assert.equal(replay.resolvedModules.includes('memory'), true);
    assert.deepEqual(replay.actions.filter((action) => action.kind?.startsWith('retire')), []);
    assert.equal(replay.actions.some((action) => action.relativeTarget === 'docs/memory/PROJECT_STATE.md'), true);
    assert.equal(replay.actions.some((action) => action.relativeTarget === '.agents/memory/CURRENT.md'), true);

    // Explicitly narrowing the selection still retires what was deselected.
    const narrowed = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'full',
      '--modules', 'agents,rules', '--dry-run',
    ]);
    assert.ok(narrowed.actions.some(
      (action) => action.kind === 'retire' && action.relativeTarget === 'docs/memory/PROJECT_STATE.md',
    ));
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('plugin option accepts public aliases and normalizes a single leading dash', () => {
  assert.deepEqual(parsePluginsOption(['-chrome-devtools-mcp', 'playwright-cli']), ['chrome-devtools', 'playwright']);
  assert.deepEqual(
    parsePluginsOption(['chrome-devtools-mcp', 'playwright-cli']),
    ['chrome-devtools', 'playwright'],
  );
});

test('plugin option expands all three plugins and rejects ambiguous input', () => {
  assert.deepEqual(parsePluginsOption(['-all']), [
    'chrome-devtools',
    'playwright',
    'open-code-review',
  ]);
  assert.deepEqual(parsePluginsOption(['none']), []);
  assert.throws(() => parsePluginsOption([]), /requires at least one plugin/u);
  assert.throws(() => parsePluginsOption(['unknown']), /Unknown plugin/u);
  assert.throws(() => parsePluginsOption(['playwright', '-playwright']), /duplicate plugin/u);
  assert.throws(() => parsePluginsOption(['all', 'playwright']), /cannot be combined/u);
  assert.throws(() => parsePluginsOption(['none', 'playwright']), /cannot be combined/u);
});

test('plugins augment the profile selection instead of replacing it', () => {
  const selection = resolveModuleSelection({
    profile: 'full',
    profileGroups: ['agents', 'rules-full', 'templates-minimal', 'runtime-full', 'skills-full', 'hooks'],
    requestedPlugins: ['open-code-review'],
  });

  assert.deepEqual(selection.requestedPlugins, ['open-code-review']);
  assert.equal(selection.resolvedModules.includes('hooks'), true);
  assert.equal(selection.resolvedModules.includes('memory'), false);
  assert.equal(selection.resolvedModules.includes('open-code-review'), true);
  assert.equal(selection.resolvedModules.includes('playwright'), false);
  assert.equal(selection.allowedGroups.has('rules-rtk'), false);
  assert.equal(selection.allowedGroups.has('tools-open-code-review'), true);
});

test('project config accepts valid plugins and rejects invalid plugin arrays', () => {
  const base = {
    packageManager: 'pnpm',
    profile: 'core',
    projectName: 'Example',
    target: 'codex',
    validationCommands: { lint: null, typecheck: null, test: null, eval: null },
  };
  assert.equal(validateProjectConfig({ ...base, plugins: ['open-code-review', 'playwright-cli'] }), true);
  assert.equal(validateProjectConfig({ ...base, plugins: [] }), true);
  assert.throws(() => validateProjectConfig({ ...base, plugins: ['missing'] }), /Unknown plugin/u);
  assert.throws(() => validateProjectConfig({ ...base, hooks: { rtk: { enabled: true } } }), /retired/u);
});

// The raised tests below issue eight CLI invocations per test (install/
// validate/doctor round-trips); on slow filesystems that legitimately exceeds
// the default 120s test budget.
// 2026-09-19 calibration (solo, slow box): install --write 35s, validate 68s,
// doctor 73s per invocation; RTK round-trip measured >300s solo, so 600s is a
// hang guard, not a performance claim.


test('core and full install no tool plugins by default', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-no-default-plugins-'));
  try {
    await runCli(['init', '--project', target]);
    for (const profile of ['core', 'full']) {
      const report = await runCli([
        'install', '--project', target, '--target', 'codex', '--profile', profile, '--dry-run',
      ]);
      assert.deepEqual(report.plannedToolActions, []);
      assert.deepEqual(report.requestedPlugins, []);
      assert.equal(report.actions.some((item) => item.relativeTarget.startsWith('.agents/runtime/tools/')), false);
      assert.equal(report.actions.some((item) => item.relativeTarget === '.agents/runtime/commands/run.mjs'), true);
      assert.equal(report.actions.some((item) => item.relativeTarget === '.codex/config.toml'), false);
    }
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('CLI plugin selection supports one, many, and all public plugins', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-plugin-selection-'));
  try {
    await runCli(['init', '--project', target]);
    const one = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', '-open-code-review', '--dry-run',
    ]);
    assert.deepEqual(one.plannedToolActions.map((item) => item.id), ['openCodeReview']);

    const many = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', '-open-code-review', 'playwright', '--dry-run',
    ]);
    assert.deepEqual(many.plannedToolActions.map((item) => item.id), ['playwrightCli', 'openCodeReview']);

    const all = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', '-all', '--dry-run', '--allow-preview',
    ]);
    assert.deepEqual(all.plannedToolActions.map((item) => item.id), [
      'playwrightCli',
      'chromeDevtoolsMcp',
      'openCodeReview',
    ]);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('retired Agentmemory plugin is rejected', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-agentmemory-plugin-preview-'));
  try {
    await runCli(['init', '--project', target]);
    const failure = await runCliFailure([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', '-agentmemory', '--dry-run',
    ]);
    assert.equal(failure.ok, false);
    assert.match(failure.error.message, /Unknown plugin: agentmemory/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('CLI plugin selection augments full and persists for validation and reinstall', { timeout: 600000 }, async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-plugin-persistence-'));
  try {
    await runCli(['init', '--project', target, '--profile', 'full']);
    const installed = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'full',
      '--plugin', '-open-code-review', '--write', '--confirm-red-zone',
    ]);
    assert.deepEqual(installed.requestedPlugins, ['open-code-review']);
    assert.equal(installed.resolvedModules.includes('hooks'), true);
    assert.equal(installed.resolvedModules.includes('memory'), false);
    assert.deepEqual(installed.plannedToolActions.map((item) => item.id), ['openCodeReview']);

    const state = JSON.parse(await readFile(path.join(target, '.vibe-harness/install-state.json'), 'utf8'));
    assert.deepEqual(state.requestedPlugins, ['open-code-review']);
    const validation = await runCli(['validate', '--project', target]);
    assert.equal(validation.ok, true);
    const reinstall = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'full',
      '--dry-run', '--confirm-red-zone',
    ]);
    assert.deepEqual(reinstall.requestedPlugins, ['open-code-review']);
    assert.deepEqual(reinstall.plannedToolActions.map((item) => item.id), ['openCodeReview']);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('config plugins override saved state while CLI selection can override or clear config', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-plugin-precedence-'));
  try {
    await runCli(['init', '--project', target]);
    await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', 'open-code-review', '--write',
    ]);
    const configPath = path.join(target, 'vibe-harness.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    await writeFile(configPath, `${JSON.stringify({ ...config, plugins: ['playwright'] }, null, 2)}\n`, 'utf8');

    const configured = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core', '--dry-run',
    ]);
    assert.deepEqual(configured.requestedPlugins, ['playwright']);
    assert.deepEqual(configured.plannedToolActions.map((item) => item.id), ['playwrightCli']);

    const overridden = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', '-playwright-cli', '--dry-run',
    ]);
    assert.deepEqual(overridden.requestedPlugins, ['playwright']);
    assert.deepEqual(overridden.plannedToolActions.map((item) => item.id), ['playwrightCli']);

    delete config.plugins;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    const cleared = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', 'none', '--write',
    ]);
    assert.deepEqual(cleared.requestedPlugins, []);
    assert.deepEqual(cleared.plannedToolActions, []);
    const state = JSON.parse(await readFile(path.join(target, '.vibe-harness/install-state.json'), 'utf8'));
    assert.deepEqual(state.requestedPlugins, []);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
