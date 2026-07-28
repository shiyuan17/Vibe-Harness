import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { parsePluginsOption, resolveModuleSelection } from '../scripts/lib/module-selection.js';
import { validateProjectConfig } from '../scripts/lib/project-config.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '..');
const cliPath = path.join(rootDir, 'scripts/cognis.js');

async function runCli(args) {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], { cwd: rootDir });
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

test('chrome-devtools module installs its rule, runtime, skills, and managed MCP surface', async () => {
  const selection = resolveModuleSelection({ requestedModules: ['chrome-devtools'] });

  assert.deepEqual(selection.resolvedModules, ['agents', 'rules', 'templates', 'skills', 'chrome-devtools']);
  assert.deepEqual(selection.implicitModules, ['agents', 'rules', 'templates', 'skills']);
  assert.equal(selection.allowedGroups.has('rules-chrome-devtools'), true);
  assert.equal(selection.allowedGroups.has('tools-chrome-devtools'), true);
  assert.equal(selection.allowedGroups.has('mcp-config'), true);

  const target = await mkdtemp(path.join(tmpdir(), 'cognis-chrome-devtools-module-'));
  try {
    await runCli(['init', '--project', target]);
    const report = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--modules', 'chrome-devtools', '--dry-run', '--verbose',
    ]);

    assert.deepEqual(report.plannedToolActions.map((item) => item.id), ['chromeDevtoolsMcp']);
    assert.equal(report.actions.some((item) => item.relativeTarget === 'docs/rules/chrome-devtools-mcp.md'), true);
    assert.equal(report.actions.some((item) => item.relativeTarget === '.agents/cognis/tools/chrome-devtools-mcp/run.mjs'), true);
    assert.equal(report.actions.some((item) => item.relativeTarget === '.codex/config.toml'), true);
    const agentsPreview = report.previewFiles.find((item) => item.target === 'AGENTS.md');
    assert.match(agentsPreview.content, /cognis doctor --project <path>/u);
    assert.doesNotMatch(agentsPreview.content, /cognis doctor --target <path>/u);
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
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-modules-'));
  try {
    await runCli(['init', '--project', target]);
    const configPath = path.join(target, 'cognis.config.json');
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
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-modules-validate-'));
  try {
    await runCli(['init', '--project', target]);
    await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--modules', 'agents,rules', '--write',
    ]);

    const validation = await runCli(['validate', '--project', target]);
    assert.equal(validation.ok, true);
    const state = JSON.parse(await readFile(path.join(target, '.cognis', 'install-state.json'), 'utf8'));
    assert.deepEqual(state.requestedModules, ['agents', 'rules']);
    assert.deepEqual(state.resolvedModules, ['agents', 'rules']);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('plugin option accepts public aliases and normalizes a single leading dash', () => {
  assert.deepEqual(parsePluginsOption(['-rtk', 'ast-grep']), ['rtk', 'ast-grep']);
  assert.deepEqual(
    parsePluginsOption(['codebase-memory-mcp,chrome-devtools-mcp', 'playwright-cli']),
    ['codebase-memory', 'chrome-devtools', 'playwright'],
  );
});

test('plugin option expands all six plugins and rejects ambiguous input', () => {
  assert.deepEqual(parsePluginsOption(['-all']), [
    'rtk',
    'ast-grep',
    'codebase-memory',
    'chrome-devtools',
    'playwright',
    'open-code-review',
  ]);
  assert.deepEqual(parsePluginsOption(['none']), []);
  assert.throws(() => parsePluginsOption([]), /requires at least one plugin/u);
  assert.throws(() => parsePluginsOption(['unknown']), /Unknown plugin/u);
  assert.throws(() => parsePluginsOption(['rtk', '-rtk']), /duplicate plugin/u);
  assert.throws(() => parsePluginsOption(['all', 'rtk']), /cannot be combined/u);
  assert.throws(() => parsePluginsOption(['none', 'rtk']), /cannot be combined/u);
});

test('plugins augment the profile selection instead of replacing it', () => {
  const selection = resolveModuleSelection({
    profile: 'full',
    profileGroups: ['agents', 'rules-full', 'templates-full', 'runtime-full', 'skills-full', 'hooks'],
    requestedPlugins: ['rtk'],
  });

  assert.deepEqual(selection.requestedPlugins, ['rtk']);
  assert.equal(selection.resolvedModules.includes('hooks'), true);
  assert.equal(selection.resolvedModules.includes('memory'), false);
  assert.equal(selection.resolvedModules.includes('rtk'), true);
  assert.equal(selection.resolvedModules.includes('playwright'), false);
  assert.equal(selection.allowedGroups.has('rules-rtk'), true);
  assert.equal(selection.allowedGroups.has('tools-rtk'), true);
});

test('RTK integration adds safety hooks only when explicitly enabled', () => {
  const instructionsOnly = resolveModuleSelection({
    profile: 'core',
    requestedPlugins: ['rtk'],
  });
  assert.equal(instructionsOnly.resolvedModules.includes('hooks'), false);

  const integrated = resolveModuleSelection({
    profile: 'core',
    requestedPlugins: ['rtk'],
    rtkHooksEnabled: true,
  });
  assert.equal(integrated.resolvedModules.includes('rtk'), true);
  assert.equal(integrated.resolvedModules.includes('hooks'), true);
  assert.equal(integrated.implicitModules.includes('hooks'), true);
});

test('project config accepts valid plugins and rejects invalid plugin arrays', () => {
  const base = {
    packageManager: 'pnpm',
    profile: 'core',
    projectName: 'Example',
    target: 'codex',
    validationCommands: { lint: null, typecheck: null, test: null, eval: null },
  };
  assert.equal(validateProjectConfig({ ...base, plugins: ['rtk', 'playwright-cli'] }), true);
  assert.throws(() => validateProjectConfig({ ...base, plugins: [] }), /at least one plugin/u);
  assert.throws(() => validateProjectConfig({ ...base, plugins: ['missing'] }), /Unknown plugin/u);
  assert.equal(validateProjectConfig({
    ...base,
    hooks: { mode: 'guarded', rtk: { enabled: true } },
    plugins: ['rtk'],
  }), true);
  assert.throws(
    () => validateProjectConfig({ ...base, hooks: { rtk: { enabled: 'yes' } }, plugins: ['rtk'] }),
    /hooks\.rtk\.enabled must be boolean/u,
  );
  assert.equal(validateProjectConfig({ ...base, hooks: { rtk: { enabled: true } }, plugins: ['ast-grep'] }), true);
});

test('RTK hook CLI is explicit, Codex-only, and requires the RTK plugin', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-rtk-hook-contract-'));
  try {
    await runCli(['init', '--project', target]);
    const instructionsOnly = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', '-rtk', '--dry-run',
    ]);
    assert.equal(instructionsOnly.rtkHooks.enabled, false);
    assert.equal(instructionsOnly.actions.some((item) => item.relativeTarget === '.codex/hooks.json'), false);

    const enabled = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', '-rtk', '--rtk-hooks', 'on', '--dry-run',
    ]);
    assert.equal(enabled.rtkHooks.enabled, true);
    assert.equal(enabled.resolvedModules.includes('hooks'), true);
    assert.equal(enabled.implicitModules.includes('hooks'), true);
    assert.equal(enabled.actions.some((item) => item.relativeTarget === '.codex/hooks.json' && item.redZone), true);
    assert.equal(enabled.requiresRedZoneConfirmation, true);

    const missingPlugin = await runCliFailure([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--rtk-hooks', 'on', '--dry-run',
    ]);
    assert.match(missingPlugin.error.message, /requires the rtk plugin/u);

    const configPath = path.join(target, 'cognis.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.hooks.rtk = { enabled: true };
    config.plugins = ['ast-grep'];
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    const invalidConfig = await runCliFailure([
      'install', '--project', target, '--target', 'codex', '--profile', 'core', '--dry-run',
    ]);
    assert.match(invalidConfig.error.message, /requires the rtk plugin/u);
    delete config.hooks.rtk;
    delete config.plugins;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    const unsupportedTarget = await mkdtemp(path.join(tmpdir(), 'cognis-rtk-hook-claude-'));
    try {
      await runCli(['init', '--project', unsupportedTarget, '--target', 'claude']);
      const failure = await runCliFailure([
        'install', '--project', unsupportedTarget, '--target', 'claude', '--profile', 'core',
        '--plugin', '-rtk', '--rtk-hooks', 'on', '--dry-run',
      ]);
      assert.match(failure.error.message, /only supported for the codex target/u);
    } finally {
      await rm(unsupportedTarget, { force: true, recursive: true });
    }

    const invalid = await runCliFailure([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', '-rtk', '--rtk-hooks', 'maybe', '--dry-run',
    ]);
    assert.match(invalid.error.message, /--rtk-hooks must be on or off/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('RTK hook precedence persists CLI state and disables inherited hooks when RTK is removed', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-rtk-hook-precedence-'));
  try {
    await runCli(['init', '--project', target]);
    const installed = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', '-rtk', '--rtk-hooks', 'on', '--write', '--confirm-red-zone',
    ]);
    assert.equal(installed.rtkHooks.enabled, true);
    let state = JSON.parse(await readFile(path.join(target, '.cognis/install-state.json'), 'utf8'));
    assert.equal(state.rtkHooksEnabled, true);
    assert.equal(await readFile(path.join(target, '.agents/cognis/hooks/lib/rtk.mjs'), 'utf8').then(Boolean), true);
    const validation = await runCli(['validate', '--project', target]);
    const doctor = await runCli(['doctor', '--project', target]);
    assert.equal(validation.rtkHooks.enabled, true);
    assert.equal(validation.rtkHooks.status, 'pending');
    assert.equal(doctor.rtkHooks.enabled, true);
    assert.equal(doctor.rtkHooks.status, 'pending');

    const inherited = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--dry-run',
    ]);
    assert.equal(inherited.rtkHooks.enabled, true);

    const configPath = path.join(target, 'cognis.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.hooks.rtk = { enabled: false };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    const configDisabled = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core', '--dry-run',
    ]);
    assert.equal(configDisabled.rtkHooks.enabled, false);
    const cliEnabled = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--rtk-hooks', 'on', '--dry-run',
    ]);
    assert.equal(cliEnabled.rtkHooks.enabled, true);

    delete config.hooks.rtk;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    const removed = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', 'none', '--write', '--confirm-red-zone',
    ]);
    assert.equal(removed.rtkHooks.enabled, false);
    state = JSON.parse(await readFile(path.join(target, '.cognis/install-state.json'), 'utf8'));
    assert.equal(state.rtkHooksEnabled, false);
    assert.equal(state.resolvedModules.includes('hooks'), false);
    await assert.rejects(readFile(path.join(target, '.codex/hooks.json'), 'utf8'), /ENOENT/u);
    await assert.rejects(readFile(path.join(target, '.agents/cognis/hooks/lib/rtk.mjs'), 'utf8'), /ENOENT/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('core and full install no tool plugins by default', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-no-default-plugins-'));
  try {
    await runCli(['init', '--project', target]);
    for (const profile of ['core', 'full']) {
      const report = await runCli([
        'install', '--project', target, '--target', 'codex', '--profile', profile, '--dry-run',
      ]);
      assert.deepEqual(report.plannedToolActions, []);
      assert.deepEqual(report.requestedPlugins, []);
      assert.equal(report.actions.some((item) => item.relativeTarget.startsWith('.agents/cognis/tools/')), false);
      assert.equal(report.actions.some((item) => item.relativeTarget === '.codex/config.toml'), false);
    }
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('CLI plugin selection supports one, many, and all public plugins', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-plugin-selection-'));
  try {
    await runCli(['init', '--project', target]);
    const one = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', '-rtk', '--dry-run',
    ]);
    assert.deepEqual(one.plannedToolActions.map((item) => item.id), ['rtk']);

    const many = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', '-rtk', 'ast-grep', '--dry-run',
    ]);
    assert.deepEqual(many.plannedToolActions.map((item) => item.id), ['rtk', 'astGrep']);

    const all = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', '-all', '--dry-run', '--allow-preview',
    ]);
    assert.deepEqual(all.plannedToolActions.map((item) => item.id), [
      'codebaseMemoryMcp',
      'playwrightCli',
      'chromeDevtoolsMcp',
      'openCodeReview',
      'rtk',
      'astGrep',
    ]);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('retired Agentmemory plugin is rejected', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-agentmemory-plugin-preview-'));
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

test('CLI plugin selection augments full and persists for validation and reinstall', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-plugin-persistence-'));
  try {
    await runCli(['init', '--project', target, '--profile', 'full']);
    const installed = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'full',
      '--plugin', '-rtk', '--write', '--confirm-red-zone',
    ]);
    assert.deepEqual(installed.requestedPlugins, ['rtk']);
    assert.equal(installed.resolvedModules.includes('hooks'), true);
    assert.equal(installed.resolvedModules.includes('memory'), false);
    assert.deepEqual(installed.plannedToolActions.map((item) => item.id), ['rtk']);

    const state = JSON.parse(await readFile(path.join(target, '.cognis/install-state.json'), 'utf8'));
    assert.deepEqual(state.requestedPlugins, ['rtk']);
    const validation = await runCli(['validate', '--project', target]);
    assert.equal(validation.ok, true);
    const reinstall = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'full',
      '--dry-run', '--confirm-red-zone',
    ]);
    assert.deepEqual(reinstall.requestedPlugins, ['rtk']);
    assert.deepEqual(reinstall.plannedToolActions.map((item) => item.id), ['rtk']);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('config plugins override saved state while CLI selection can override or clear config', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-plugin-precedence-'));
  try {
    await runCli(['init', '--project', target]);
    await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core',
      '--plugin', '-rtk', '--write',
    ]);
    const configPath = path.join(target, 'cognis.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    await writeFile(configPath, `${JSON.stringify({ ...config, plugins: ['ast-grep'] }, null, 2)}\n`, 'utf8');

    const configured = await runCli([
      'install', '--project', target, '--target', 'codex', '--profile', 'core', '--dry-run',
    ]);
    assert.deepEqual(configured.requestedPlugins, ['ast-grep']);
    assert.deepEqual(configured.plannedToolActions.map((item) => item.id), ['astGrep']);

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
    const state = JSON.parse(await readFile(path.join(target, '.cognis/install-state.json'), 'utf8'));
    assert.deepEqual(state.requestedPlugins, []);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
