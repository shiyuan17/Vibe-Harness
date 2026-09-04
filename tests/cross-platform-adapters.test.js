import './helpers/offline-tools.js';

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  extractManagedInstructionBlock,
  mergeManagedInstructionBlock,
  removeManagedInstructionBlock,
} from '../scripts/lib/template-renderer.js';
import {
  canonicalAgentsTemplate,
  hookConfigTargets,
  loadAdapterCatalog,
  resolveAdapterEntry,
  skillRootMatcher,
  skillRootPrefixes,
} from '../scripts/lib/adapter.js';
import { createInstalledSurface, createInstallPlan } from '../scripts/lib/install-planner.js';
import { applyUninstallPlan, createUninstallPlan } from '../scripts/lib/install-state.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '..');
const cliPath = path.join(rootDir, 'scripts/vibe-harness.js');

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

async function run(args) {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], { cwd: rootDir, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function fail(args) {
  try { await run(args); } catch (error) { return JSON.parse(error.stderr); }
  assert.fail('Expected command to fail');
}

test('installed surface joins Hook lines with newlines', () => {
  const surface = createInstalledSurface({
    hookConfigTargets: [
      { target: '.codex/hooks.json', displayName: 'Codex' },
      { target: '.cursor/hooks.json', displayName: 'Cursor' },
    ],
    profile: 'full',
    targets: ['.codex/hooks.json', '.cursor/hooks.json'],
  });
  assert.match(surface.hooksLine, /Codex hook 配置位于.*\n- Cursor hook 配置位于/u);
  assert.doesNotMatch(surface.hooksLine, /。- /u);
});

test('AGENTS startup rendering contains no empty numbered entries', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-agents-startup-'));
  try {
    const plan = await createInstallPlan({
      adapterId: 'codex',
      dryRun: true,
      profile: 'minimal',
      rootDir,
      targetDir: target,
    });
    const content = plan.renderData.installedSurface.startupLines;
    assert.doesNotMatch(content, /^\d+\.\s*$/mu);
    assert.match(content, /^1\. /u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('all eight adapters share one project installation and support target-scoped uninstall', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-multi-adapter-'));
  const targets = ['codex', 'claude', 'gemini', 'cursor', 'qoder', 'zcode', 'antigravity', 'opencode'];
  try {
    await run(['init', '--project', target]);
    const configPath = path.join(target, 'vibe-harness.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    await writeFile(configPath, JSON.stringify({ ...config, targets }, null, 2) + '\n', 'utf8');

    const preview = await run(['install', '--project', target, '--profile', 'core', '--dry-run']);
    assert.deepEqual(preview.targets, targets);
    assert.equal(preview.actions.filter((action) => action.relativeTarget === 'AGENTS.md').length, 1);

    await run(['install', '--project', target, '--profile', 'core', '--write']);
    const statePath = path.join(target, '.vibe-harness/install-state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(state.stateVersion, 5);
    assert.deepEqual(state.targets, targets);
    assert.equal(Object.hasOwn(state, 'adapter'), false);
    assert.equal(new Set(state.files.map((file) => file.target)).size, state.files.length);
    assert.deepEqual(
      state.files.find((file) => file.target === 'AGENTS.md').owners,
      ['adapter:codex', 'adapter:cursor', 'adapter:opencode', 'adapter:qoder', 'adapter:zcode'],
    );
    assert.deepEqual(state.files.find((file) => file.target === 'docs/rules/coding-rules.md').owners, ['shared']);
    assert.deepEqual(state.files.find((file) => file.target === 'CLAUDE.md').owners, ['adapter:claude']);
    assert.deepEqual(
      state.files.find((file) => file.target === '.agents/rules/vibe-harness.md').owners,
      ['adapter:antigravity'],
    );
    const agents = await readFile(path.join(target, 'AGENTS.md'), 'utf8');
    assert.equal((agents.match(/<!-- VIBE_HARNESS:START -->/gu) ?? []).length, 1);
    assert.equal((await run(['validate', '--project', target])).status, 'ready');

    const selected = await run(['diff', '--project', target, '--target', 'codex']);
    assert.equal(selected.adapters.codex.status, 'stable');
    assert.equal(selected.adapters.claude.status, 'skipped');
    const all = await run(['diff', '--project', target]);
    assert.equal(all.adapters.cursor.status, 'preview');
    assert.equal(all.adapters.zcode.capabilities.skills, 'unsupported');

    await run(['uninstall', '--project', target, '--target', 'zcode', '--write']);
    const remainingState = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(remainingState.targets.includes('zcode'), false);
    assert.equal(await exists(path.join(target, 'AGENTS.md')), true);
    const updatedConfig = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(updatedConfig.targets.includes('zcode'), false);

    await run(['uninstall', '--project', target, '--all-targets', '--write']);
    assert.equal(await exists(statePath), false);
    assert.equal(await exists(path.join(target, 'docs/rules/coding-rules.md')), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('Antigravity structured MCP and Hook config preserves users, conflicts by name, and requires force takeover', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-antigravity-config-'));
  try {
    await run(['init', '--project', target, '--target', 'antigravity', '--profile', 'full']);
    const agentsDir = path.join(target, '.agents');
    await mkdir(agentsDir, { recursive: true });
    const mcpPath = path.join(agentsDir, 'mcp_config.json');
    const hooksPath = path.join(agentsDir, 'hooks.json');
    await writeFile(mcpPath, JSON.stringify({
      custom: true,
      mcpServers: {
        'custom-server': { command: 'custom' },
        'vibe-harness-codebase-memory-mcp': { command: 'user-owned' },
      },
    }, null, 2) + '\n', 'utf8');
    await writeFile(hooksPath, JSON.stringify({
      custom: true,
      'vibe-harness': {
        PreToolUse: [{ hooks: [{ command: 'user-owned', statusMessage: 'Vibe-Harness safety policy' }] }],
        UserEvent: [{ hooks: [{ command: 'custom', statusMessage: 'Custom policy' }] }],
      },
    }, null, 2) + '\n', 'utf8');
    const installArgs = [
      'install', '--project', target, '--target', 'antigravity', '--profile', 'full',
      '--modules', 'agents,rules,templates,skills,evals,hooks,memory',
      '--plugin', 'codebase-memory', '--allow-preview',
    ];

    const preview = await run([...installArgs, '--dry-run', '--verbose']);
    assert.equal(preview.actions.some((action) => action.relativeTarget === '.agents/mcp_config.json' && action.kind === 'conflict'), true);
    assert.equal(preview.actions.some((action) => action.relativeTarget === '.agents/hooks.json' && action.kind === 'conflict'), true);
    const blockedConflict = await fail([...installArgs, '--write', '--confirm-red-zone']);
    assert.match(blockedConflict.error.message, /overwrite existing file/iu);
    const blockedRedZone = await fail([...installArgs, '--write', '--force']);
    assert.match(blockedRedZone.error.message, /red-zone confirmation/iu);
    await run([...installArgs, '--write', '--force', '--confirm-red-zone']);

    const mcp = JSON.parse(await readFile(mcpPath, 'utf8'));
    assert.equal(mcp.custom, true);
    assert.deepEqual(mcp.mcpServers['custom-server'], { command: 'custom' });
    assert.notEqual(mcp.mcpServers['vibe-harness-codebase-memory-mcp'].command, 'user-owned');
    const hooks = JSON.parse(await readFile(hooksPath, 'utf8'));
    assert.equal(hooks.custom, true);
    assert.equal(hooks['vibe-harness'].UserEvent[0].hooks[0].command, 'custom');
    assert.notEqual(hooks['vibe-harness'].PreToolUse[0].hooks[0].command, 'user-owned');

    await run(['uninstall', '--project', target, '--all-targets', '--write', '--confirm-red-zone']);
    const remainingMcp = JSON.parse(await readFile(mcpPath, 'utf8'));
    assert.deepEqual(remainingMcp, { custom: true, mcpServers: { 'custom-server': { command: 'custom' } } });
    const remainingHooks = JSON.parse(await readFile(hooksPath, 'utf8'));
    assert.equal(remainingHooks.custom, true);
    assert.equal(remainingHooks['vibe-harness'].UserEvent[0].hooks[0].command, 'custom');
    assert.equal(Object.hasOwn(remainingHooks['vibe-harness'], 'PreToolUse'), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('all eight full adapters share one runtime, memory library, and root-scoped index contract', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-all-full-shared-'));
  const targets = ['codex', 'claude', 'gemini', 'cursor', 'qoder', 'zcode', 'antigravity', 'opencode'];
  try {
    await run(['init', '--project', target, '--profile', 'full']);
    const configPath = path.join(target, 'vibe-harness.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    await writeFile(configPath, JSON.stringify({ ...config, targets }, null, 2) + '\n', 'utf8');
    const installed = await run([
      'install', '--project', target, '--profile', 'full',
      '--modules', 'agents,rules,templates,skills,evals,hooks,memory',
      '--plugin', 'codebase-memory', '--allow-preview', '--write', '--confirm-red-zone',
    ]);
    assert.equal(installed.plannedToolActions.filter((action) => action.id === 'codebaseMemoryMcp').length, 1);

    const state = JSON.parse(await readFile(path.join(target, '.vibe-harness/install-state.json'), 'utf8'));
    assert.equal(new Set(state.files.map((file) => file.target)).size, state.files.length);
    const runtimeFiles = state.files.filter((file) => file.target.startsWith('.agents/runtime/tools/codebase-memory-mcp/'));
    assert.equal(runtimeFiles.length > 0, true);
    assert.equal(runtimeFiles.every((file) => file.owners.length === 1 && file.owners[0] === 'shared'), true);
    const memoryFiles = state.files.filter((file) => file.target.startsWith('.agents/memory/'));
    assert.equal(memoryFiles.length > 0, true);
    assert.equal(memoryFiles.every((file) => file.owners.length === 1 && file.owners[0] === 'shared'), true);

    const mcpPaths = ['.cursor/mcp.json', '.mcp.json', '.zcode/config.json', '.agents/mcp_config.json', 'opencode.json'];
    const indexedRoots = [];
    for (const relativePath of mcpPaths) {
      const hostConfig = JSON.parse(await readFile(path.join(target, relativePath), 'utf8'));
      const serialized = JSON.stringify(hostConfig);
      assert.match(serialized, /vibe-harness-codebase-memory-mcp/u);
      JSON.stringify(hostConfig, (key, value) => {
        if (key === 'CBM_ALLOWED_ROOT') indexedRoots.push(value);
        return value;
      });
    }
    assert.equal(indexedRoots.length, mcpPaths.length);
    assert.deepEqual([...new Set(indexedRoots)], [target]);

    await run(['uninstall', '--project', target, '--all-targets', '--write', '--confirm-red-zone']);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('doctor reports nested legacy installations without modifying them', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-nested-install-'));
  try {
    await run(['init', '--project', target, '--profile', 'minimal']);
    await run(['install', '--project', target, '--profile', 'minimal', '--write']);
    const nested = path.join(target, 'packages', 'legacy-app');
    const nestedStatePath = path.join(nested, '.vibe-harness', 'install-state.json');
    await mkdir(path.dirname(nestedStatePath), { recursive: true });
    await mkdir(path.join(nested, '.agents', 'runtime'), { recursive: true });
    await mkdir(path.join(nested, '.vibe-harness', 'tool-state', 'codebase-memory-mcp'), { recursive: true });
    await writeFile(nestedStatePath, JSON.stringify({
      adapter: 'codex',
      files: [],
      profile: 'core',
      stateVersion: 4,
      version: '0.2.0',
    }), 'utf8');
    const ignoredState = path.join(target, 'node_modules', 'fixture', '.vibe-harness', 'install-state.json');
    await mkdir(path.dirname(ignoredState), { recursive: true });
    await writeFile(ignoredState, '{}', 'utf8');

    const doctor = await run(['doctor', '--project', target]);
    assert.equal(doctor.nestedInstallations.length, 1);
    assert.equal(doctor.nestedInstallations[0].path, nested);
    assert.equal(doctor.nestedInstallations[0].stateVersion, 4);
    assert.equal(doctor.nestedInstallations[0].duplicateRuntime, true);
    assert.equal(doctor.nestedInstallations[0].duplicateIndex, true);
    assert.equal(doctor.nestedInstallMigration.length, 4);
    assert.match(doctor.nestedInstallMigration.at(-1), /uninstall.*--all-targets --write/iu);
    assert.equal(await exists(nestedStatePath), true);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('legacy target config migrates only on an upgrade write', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-legacy-target-'));
  try {
    await run(['init', '--project', target]);
    const configPath = path.join(target, 'vibe-harness.config.json');
    const current = JSON.parse(await readFile(configPath, 'utf8'));
    const legacy = { ...current, target: current.targets[0] };
    delete legacy.targets;
    await writeFile(configPath, JSON.stringify(legacy, null, 2) + '\n', 'utf8');

    await run(['install', '--project', target, '--profile', 'core', '--upgrade', '--dry-run']);
    assert.equal(Object.hasOwn(JSON.parse(await readFile(configPath, 'utf8')), 'target'), true);

    await run(['install', '--project', target, '--profile', 'core', '--upgrade', '--write']);
    const migrated = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(migrated.targets, ['codex']);
    assert.equal(Object.hasOwn(migrated, 'target'), false);
    const state = JSON.parse(await readFile(path.join(target, '.vibe-harness/install-state.json'), 'utf8'));
    assert.equal(state.stateVersion, 5);
    assert.deepEqual(state.targets, ['codex']);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('removed config targets remain stale until explicitly uninstalled', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-stale-target-'));
  try {
    await run(['init', '--project', target, '--profile', 'minimal']);
    const configPath = path.join(target, 'vibe-harness.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    await writeFile(configPath, JSON.stringify({ ...config, targets: ['codex', 'claude'] }, null, 2) + '\n', 'utf8');
    await run(['install', '--project', target, '--write']);
    const claudePath = path.join(target, 'CLAUDE.md');
    assert.equal(await exists(claudePath), true);

    await writeFile(configPath, JSON.stringify({ ...config, targets: ['codex'] }, null, 2) + '\n', 'utf8');
    const drift = await run(['diff', '--project', target]);
    assert.deepEqual(drift.staleProjections, ['claude']);
    assert.equal(drift.ok, false);

    await run(['install', '--project', target, '--upgrade', '--write']);
    const preservedState = JSON.parse(await readFile(path.join(target, '.vibe-harness/install-state.json'), 'utf8'));
    assert.deepEqual(preservedState.targets, ['codex', 'claude']);
    assert.equal(await exists(claudePath), true);

    await run(['uninstall', '--project', target, '--target', 'claude', '--write']);
    const cleanedState = JSON.parse(await readFile(path.join(target, '.vibe-harness/install-state.json'), 'utf8'));
    assert.deepEqual(cleanedState.targets, ['codex']);
    assert.equal(await exists(claudePath), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

for (const adapter of [
  { id: 'claude', instruction: 'CLAUDE.md', skills: '.claude/skills' },
  { id: 'gemini', instruction: 'GEMINI.md', skills: '.gemini/skills' },
]) {
  test(`${adapter.id} core install preserves local instructions and supports validate/uninstall`, async () => {
    const target = await mkdtemp(path.join(tmpdir(), `vibe-harness-${adapter.id}-`));
    try {
      await run(['init', '--project', target, '--target', adapter.id]);
      const config = JSON.parse(await readFile(path.join(target, 'vibe-harness.config.json'), 'utf8'));
      assert.deepEqual(config.targets, [adapter.id]);
      await writeFile(path.join(target, adapter.instruction), '# Local instructions\n', 'utf8');

      const preview = await run(['install', '--project', target, '--target', adapter.id, '--profile', 'core', '--dry-run', '--verbose']);
      const targets = preview.actions.map((action) => action.relativeTarget);
      assert.equal(targets.includes(adapter.instruction), true);
      assert.equal(targets.some((item) => item.startsWith(`${adapter.skills}/`)), true);
      assert.equal(targets.includes('AGENTS.md'), false);
      assert.equal(targets.some((item) => item.startsWith('.codex/')), false);

      await run(['install', '--project', target, '--target', adapter.id, '--profile', 'core', '--write']);
      const state = JSON.parse(await readFile(path.join(target, '.vibe-harness/install-state.json'), 'utf8'));
      assert.deepEqual(state.targets, [adapter.id]);
      assert.equal(state.files.find((file) => file.target === adapter.instruction).contentStrategy, 'managed-instruction-block');
      const installed = await readFile(path.join(target, adapter.instruction), 'utf8');
      assert.match(installed, /# Local instructions/u);
      assert.match(installed, /<!-- VIBE_HARNESS:START -->/u);
      const validation = await run(['validate', '--project', target]);
      assert.equal(validation.status, 'ready');

      await run(['install', '--project', target, '--target', adapter.id, '--profile', 'core', '--write']);
      await run(['install', '--project', target, '--target', adapter.id, '--profile', 'core', '--write', '--upgrade']);
      const managedRule = path.join(target, 'docs/rules/coding-rules.md');
      await writeFile(managedRule, '# locally modified\n', 'utf8');
      const conflict = await fail(['install', '--project', target, '--target', adapter.id, '--profile', 'core', '--write']);
      assert.match(conflict.error.message, /overwrite existing|user-modified/iu);
      await run(['install', '--project', target, '--target', adapter.id, '--profile', 'core', '--write', '--force']);

      await run(['uninstall', '--project', target, '--all-targets', '--write']);
      assert.equal(await readFile(path.join(target, adapter.instruction), 'utf8'), '# Local instructions\n');
      assert.equal(await exists(path.join(target, adapter.skills)), false);
    } finally {
      await rm(target, { force: true, recursive: true });
    }
  });
}

for (const adapter of ['claude', 'gemini']) {
  for (const profile of ['minimal', 'docs-only']) {
    test(`${adapter} ${profile} supports an empty-project write, validate, and uninstall lifecycle`, async () => {
      const target = await mkdtemp(path.join(tmpdir(), `vibe-harness-${adapter}-${profile}-`));
      try {
        await run(['init', '--project', target, '--target', adapter]);
        const configPath = path.join(target, 'vibe-harness.config.json');
        const config = JSON.parse(await readFile(configPath, 'utf8'));
        config.profile = profile;
        await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

        const installed = await run(['install', '--project', target, '--target', adapter, '--profile', profile, '--write']);
        assert.equal(installed.status, 'ready');
        assert.equal(await exists(path.join(target, adapter === 'claude' ? 'CLAUDE.md' : 'GEMINI.md')), true);
        assert.equal((await run(['validate', '--project', target])).status, 'ready');
        await run(['uninstall', '--project', target, '--all-targets', '--write']);
      } finally {
        await rm(target, { force: true, recursive: true });
      }
    });
  }
}

for (const adapter of [
  { id: 'cursor', config: '.cursor/hooks.json', mcpConfig: '.cursor/mcp.json', skills: '.cursor/skills' },
  { id: 'qoder', config: '.qoder/settings.json', mcpConfig: '.mcp.json', skills: '.qoder/skills' },
  { id: 'zcode', config: '.zcode/config.json', mcpConfig: '.zcode/config.json', skills: null },
]) {
  for (const profile of ['minimal', 'core', 'full', 'docs-only']) {
    test(`${adapter.id} ${profile} supports project-scoped install, validate, and uninstall`, async () => {
      const target = await mkdtemp(path.join(tmpdir(), `vibe-harness-${adapter.id}-${profile}-`));
      try {
        await run(['init', '--project', target, '--target', adapter.id]);
        const configPath = path.join(target, 'vibe-harness.config.json');
        const config = JSON.parse(await readFile(configPath, 'utf8'));
        await writeFile(configPath, `${JSON.stringify({ ...config, profile }, null, 2)}\n`, 'utf8');
        await writeFile(path.join(target, 'AGENTS.md'), '# Local instructions\n', 'utf8');

        const installArgs = ['install', '--project', target, '--target', adapter.id, '--profile', profile];
        if (profile === 'full') {
          await mkdir(path.dirname(path.join(target, adapter.config)), { recursive: true });
          await writeFile(path.join(target, adapter.config), '{\n  "custom": true\n}\n', 'utf8');
          const preview = await run([...installArgs, '--plugin', 'codebase-memory', '--allow-preview', '--dry-run']);
          assert.equal(preview.actions.some((action) => action.relativeTarget === adapter.config && action.redZone), true);
          const blocked = await fail([...installArgs, '--plugin', 'codebase-memory', '--allow-preview', '--write']);
          assert.match(blocked.error.message, /red-zone confirmation/iu);
          await run([...installArgs, '--plugin', 'codebase-memory', '--allow-preview', '--write', '--confirm-red-zone']);
        } else {
          await run([...installArgs, '--write']);
        }

        assert.match(await readFile(path.join(target, 'AGENTS.md'), 'utf8'), /# Local instructions/u);
        assert.equal((await run(['validate', '--project', target])).status, 'ready');
        if (profile === 'full') {
          const hostConfig = JSON.parse(await readFile(path.join(target, adapter.config), 'utf8'));
          assert.equal(hostConfig.custom, true);
          const mcpConfig = JSON.parse(await readFile(path.join(target, adapter.mcpConfig), 'utf8'));
          assert.match(JSON.stringify(mcpConfig), /vibe-harness-codebase-memory-mcp/u);
          assert.equal(
            adapter.skills
              ? await exists(path.join(target, adapter.skills, 'clarify-requirements', 'SKILL.md'))
              : await exists(path.join(target, '.zcode/skills')),
            Boolean(adapter.skills),
          );
          await run([...installArgs, '--plugin', 'codebase-memory', '--allow-preview', '--write', '--upgrade', '--confirm-red-zone']);
        }

        await run(['uninstall', '--project', target, '--all-targets', '--write', ...(profile === 'full' ? ['--confirm-red-zone'] : [])]);
        if (profile === 'full') {
          const remaining = JSON.parse(await readFile(path.join(target, adapter.config), 'utf8'));
          assert.deepEqual(remaining, { custom: true });
        }
      } finally {
        await rm(target, { force: true, recursive: true });
      }
    });
  }
}

test('modified Cursor managed JSON is retained during upgrade and uninstall', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-cursor-json-conflict-'));
  try {
    await run(['init', '--project', target, '--target', 'cursor']);
    await run(['install', '--project', target, '--target', 'cursor', '--profile', 'full', '--allow-preview', '--write', '--confirm-red-zone']);
    const configPath = path.join(target, '.cursor/hooks.json');
    const modified = (await readFile(configPath, 'utf8')).replace('Vibe-Harness safety policy', 'User-owned safety policy');
    await writeFile(configPath, modified, 'utf8');

    const upgrade = await createInstallPlan({
      adapterId: 'cursor',
      allowPreview: true,
      profile: 'full',
      renderData: { projectName: 'cursor-conflict' },
      rootDir,
      targetDir: target,
      upgrade: true,
    });
    assert.equal(upgrade.actions.find((action) => action.relativeTarget === '.cursor/hooks.json').kind, 'user-modified');

    const uninstall = await createUninstallPlan({ dryRun: false, redZoneConfirmed: true, targetDir: target });
    const result = await applyUninstallPlan(uninstall);
    assert.equal(result.retainedState, true);
    assert.deepEqual(result.skipped, [{ reason: 'managed-block-modified', target: '.cursor/hooks.json' }]);
    assert.match(await readFile(configPath, 'utf8'), /User-owned safety policy/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

for (const adapter of [
  { id: 'claude', skills: '.claude/skills', hasHooks: true },
  { id: 'gemini', skills: '.gemini/skills', hasHooks: false },
]) {
  test(`${adapter.id} full preview installs nine native Skills${adapter.hasHooks ? ' with Claude hooks' : ' without Codex metadata or hooks'}`, async () => {
    const target = await mkdtemp(path.join(tmpdir(), `vibe-harness-${adapter.id}-full-`));
    try {
      await run(['init', '--project', target, '--target', adapter.id, '--profile', 'full']);
      // Both adapters install the shared .agents/runtime/hooks/ scripts, which
      // are red-zone targets regardless of the adapter's own hooks capability.
      await run(['install', '--project', target, '--target', adapter.id, '--profile', 'full', '--allow-preview', '--write', '--confirm-red-zone']);
      const validation = await run(['validate', '--project', target]);
      const doctor = await run(['doctor', '--project', target]);
      assert.equal(validation.status, 'ready');
      assert.equal(doctor.status, 'ready');
      assert.equal(doctor.roles[adapter.id].roleCount, 7);
      assert.equal(doctor.roles[adapter.id].status, 'ready');
      assert.equal(await exists(path.join(target, adapter.id === 'claude' ? '.claude/agents/chief-architect.md' : '.gemini/agents/chief-architect.md')), true);
      for (const skill of ['clarify-requirements', 'define-goal', 'git-deliver', 'systematic-debugging', 'eval-driven-development', 'security-and-hardening', 'api-and-interface-design', 'frontend-design', 'runtime-cross-repo-rollout']) {
        assert.equal(await exists(path.join(target, adapter.skills, skill, 'SKILL.md')), true);
        assert.equal(await exists(path.join(target, adapter.skills, skill, 'agents/openai.yaml')), false);
      }
      assert.equal(await exists(path.join(target, '.codex/hooks.json')), false);
      if (adapter.hasHooks) {
        const settings = JSON.parse(await readFile(path.join(target, '.claude/settings.json'), 'utf8'));
        assert.deepEqual(Object.keys(settings.hooks).sort(), ['PermissionRequest', 'PreToolUse', 'enabled']);
        assert.equal(settings.hooks.enabled, true);
      }
    } finally {
      await rm(target, { force: true, recursive: true });
    }
  });
}

test('adapter catalog gates preview profiles and rejects target mismatch', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-adapter-errors-'));
  try {
    await run(['init', '--project', target, '--target', 'claude']);
    const unsupported = await fail(['install', '--project', target, '--target', 'claude', '--profile', 'full', '--dry-run']);
    assert.match(unsupported.error.message, /claude.*profile full.*preview.*allow-preview/iu);
    const preview = await run([
      'install', '--project', target, '--target', 'claude', '--profile', 'full', '--dry-run', '--allow-preview',
    ]);
    assert.equal(preview.previewCapabilities.includes('hooks'), false);
    assert.equal(preview.previewCapabilities.includes('mcp'), true);
    assert.equal(preview.missingCapabilities.includes('plugin'), true);
    const mismatch = await fail(['install', '--project', target, '--target', 'gemini', '--profile', 'core', '--dry-run']);
    assert.match(mismatch.error.message, /target.*not configured or installed/iu);
    const legacy = await fail(['install', '--target', 'claude', '--profile', 'core', '--dry-run']);
    assert.match(legacy.error.message, /--project.*--apply|removed/iu);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('adapter capability v4 uses explicit support levels for every product surface', async () => {
  const catalog = JSON.parse(await readFile(path.join(rootDir, 'manifests/adapters.json'), 'utf8'));
  const capabilityNames = ['instructions', 'skills', 'hooks', 'policy', 'mcp', 'sandbox', 'memory', 'plugin', 'goals', 'subagents'];
  assert.equal(catalog.schemaVersion, 5);
  for (const adapter of catalog.items) {
    assert.deepEqual(Object.keys(adapter.capabilities).sort(), [...capabilityNames].sort());
    assert.equal(
      Object.values(adapter.capabilities).every((status) => ['unsupported', 'preview', 'stable'].includes(status)),
      true,
    );
  }
});

test('skill-root prefixes derive from catalog and exclude unsupported adapters', async () => {
  const catalog = await loadAdapterCatalog(rootDir);
  const roots = skillRootPrefixes(catalog);
  // zcode declares `capabilities.skills: "unsupported"` and must be excluded;
  // every other adapter installs skills under its own skillRoot.
  assert.deepEqual(roots, ['.agents/skills', '.claude/skills', '.cursor/skills', '.gemini/skills', '.opencode/skills', '.qoder/skills']);
  assert.equal(roots.includes('.zcode/skills'), false, 'zcode must not appear because skills is unsupported');
  const isSkillRootTarget = skillRootMatcher(roots);
  assert.equal(isSkillRootTarget('.agents/skills/agentmemory/SKILL.md'), true);
  assert.equal(isSkillRootTarget('.claude/skills/browser-verification/SKILL.md'), true);
  assert.equal(isSkillRootTarget('.zcode/skills/agentmemory/SKILL.md'), false);
  assert.equal(isSkillRootTarget('docs/rules/governance-core.md'), false);
});

test('hook config targets derive from catalog and include antigravity', async () => {
  const catalog = await loadAdapterCatalog(rootDir);
  const targets = hookConfigTargets(catalog);
  const ids = targets.map((entry) => entry.id);
  // Adapters with hooks capability: codex (stable, install-map entry),
  // claude/cursor/qoder/zcode (projectConfig.hooks), antigravity (preview).
  // gemini/opencode have hooks unsupported.
  assert.equal(ids.includes('codex'), true);
  assert.equal(ids.includes('antigravity'), true);
  assert.equal(ids.includes('claude'), true);
  assert.equal(ids.includes('gemini'), false);
  assert.equal(ids.includes('opencode'), false);
  const antigravity = targets.find((entry) => entry.id === 'antigravity');
  assert.equal(antigravity.target, '.agents/hooks.json');
  const codex = targets.find((entry) => entry.id === 'codex');
  assert.equal(codex.target, '.codex/hooks.json');
  const claude = targets.find((entry) => entry.id === 'claude');
  assert.equal(claude.target, '.claude/settings.json');
});

test('install and upgrade reject a CLI target absent from configured and installed targets', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-adapter-state-'));
  try {
    await run(['init', '--project', target, '--target', 'claude']);
    await run(['install', '--project', target, '--target', 'claude', '--profile', 'core', '--write']);
    const configPath = path.join(target, 'vibe-harness.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    await writeFile(configPath, `${JSON.stringify({ ...config, target: 'gemini' }, null, 2)}\n`, 'utf8');

    for (const extraArgs of [[], ['--upgrade']]) {
      const report = await fail(['install', '--project', target, '--target', 'gemini', '--profile', 'core', '--write', ...extraArgs]);
      assert.match(report.error.message, /target gemini is not configured or installed/iu);
    }
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('shared install map declares explicit portable content strategies', async () => {
  const installMap = JSON.parse(await readFile(path.join(rootDir, 'adapters/install-map.json'), 'utf8'));
  const allowed = new Set(['managed-ignore-block', 'managed-instruction-block', 'managed-toml-block', 'replace']);
  assert.equal(installMap.entries.every((entry) => allowed.has(entry.contentStrategy)), true);
});

test('managed instruction helpers are platform-neutral and preserve local content', () => {
  const merged = mergeManagedInstructionBlock('# Local\n', '# Managed\n');
  assert.equal(extractManagedInstructionBlock(merged)?.includes('# Managed'), true);
  assert.equal(removeManagedInstructionBlock(merged), '# Local\n');
});

test('antigravity instruction template carries safety red-lines', async () => {
  const content = await readFile(path.join(rootDir, 'adapters/antigravity/RULES.template.md'), 'utf8');
  for (const marker of ['Edit before', 'red zone', 'manual confirmation', 'verify']) {
    assert.equal(content.includes(marker), true, `antigravity RULES.template.md must contain "${marker}"`);
  }
});

test('adapter red-zone prefixes classify transformed targets', () => {
  const resolved = resolveAdapterEntry({
    capabilities: { hooks: true, mcp: true },
    id: 'codex',
    instructionTarget: 'AGENTS.md',
    redZonePrefixes: ['.secure/'],
  }, {
    contentStrategy: 'replace',
    group: 'rules-minimal',
    redZone: false,
    source: 'docs/rules/git-rules.md',
    target: '.secure/policy.md',
  });
  assert.equal(resolved.redZone, true);
});

test('AGENTS.md targets share one canonical instruction template', async () => {
  const [catalog, installMap, canonicalContent] = await Promise.all([
    readFile(path.join(rootDir, 'manifests/adapters.json'), 'utf8').then(JSON.parse),
    readFile(path.join(rootDir, 'adapters/install-map.json'), 'utf8').then(JSON.parse),
    readFile(path.join(rootDir, 'adapters/codex/AGENTS.template.md'), 'utf8'),
  ]);
  const agentsEntry = installMap.entries.find((entry) => entry.group === 'agents');
  assert.ok(agentsEntry, 'install map must declare an agents group');
  const normalize = (text) => text.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
  for (const adapter of catalog.items) {
    if (adapter.instructionTarget !== 'AGENTS.md') continue;
    const resolved = resolveAdapterEntry(adapter, agentsEntry);
    assert.ok(resolved, `agents entry must resolve for ${adapter.id}`);
    assert.equal(
      resolved.source,
      canonicalAgentsTemplate,
      `${adapter.id} must resolve agents source to the canonical template`,
    );
    // If a per-adapter AGENTS.template.md exists, it must stay byte-identical
    // (modulo line endings) to the canonical codex template.
    const adapterTemplatePath = path.join(rootDir, `adapters/${adapter.id}/AGENTS.template.md`);
    let adapterTemplateExists = true;
    try {
      await access(adapterTemplatePath);
    } catch {
      adapterTemplateExists = false;
    }
    if (adapterTemplateExists) {
      const adapterContent = await readFile(adapterTemplatePath, 'utf8');
      assert.equal(
        normalize(adapterContent),
        normalize(canonicalContent),
        `adapters/${adapter.id}/AGENTS.template.md diverges from the canonical codex template`,
      );
    }
  }
});

test('all platform instruction entrypoints stay below ninety lines', async () => {
  for (const [adapter, filename] of [['codex', 'AGENTS'], ['claude', 'CLAUDE'], ['gemini', 'GEMINI']]) {
    const content = await readFile(path.join(rootDir, 'adapters', adapter, `${filename}.template.md`), 'utf8');
    assert.equal(content.split(/\r?\n/u).length <= 90, true, `${filename}.md exceeds the resident line budget`);
  }
});

test('README platform support matches the adapter catalog', async () => {
  const [catalog, readme, localizedReadme] = await Promise.all([
    readFile(path.join(rootDir, 'manifests/adapters.json'), 'utf8').then(JSON.parse),
    readFile(path.join(rootDir, 'README.md'), 'utf8'),
    readFile(path.join(rootDir, 'README.en.md'), 'utf8'),
  ]);
  for (const adapter of catalog.items) {
    for (const profile of adapter.supportedProfiles.filter((item) => ['minimal', 'core', 'full', 'docs-only'].includes(item))) {
      assert.equal(readme.includes(profile), true, `README omits ${adapter.id}:${profile}`);
      assert.equal(localizedReadme.includes(profile), true, `README.en omits ${adapter.id}:${profile}`);
    }
  }
  assert.doesNotMatch(readme, /非 Codex adapter.*后续路线/u);
  assert.doesNotMatch(localizedReadme, /非 Codex adapter.*后续路线/u);
});
