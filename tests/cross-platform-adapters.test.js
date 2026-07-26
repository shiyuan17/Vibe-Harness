import './helpers/offline-tools.js';

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  extractManagedInstructionBlock,
  mergeManagedInstructionBlock,
  removeManagedInstructionBlock,
} from '../scripts/lib/template-renderer.js';
import { resolveAdapterEntry } from '../scripts/lib/adapter.js';
import { createInstallPlan } from '../scripts/lib/install-planner.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve('.');
const cliPath = path.join(rootDir, 'scripts/cognis.js');

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

for (const adapter of [
  { id: 'claude', instruction: 'CLAUDE.md', skills: '.claude/skills' },
  { id: 'gemini', instruction: 'GEMINI.md', skills: '.gemini/skills' },
]) {
  test(`${adapter.id} core install preserves local instructions and supports validate/uninstall`, async () => {
    const target = await mkdtemp(path.join(tmpdir(), `cognis-${adapter.id}-`));
    try {
      await run(['init', '--project', target, '--target', adapter.id]);
      const config = JSON.parse(await readFile(path.join(target, 'cognis.config.json'), 'utf8'));
      assert.equal(config.target, adapter.id);
      await writeFile(path.join(target, adapter.instruction), '# Local instructions\n', 'utf8');

      const preview = await run(['install', '--project', target, '--target', adapter.id, '--profile', 'core', '--dry-run', '--verbose']);
      const targets = preview.actions.map((action) => action.relativeTarget);
      assert.equal(targets.includes(adapter.instruction), true);
      assert.equal(targets.some((item) => item.startsWith(`${adapter.skills}/`)), true);
      assert.equal(targets.includes('AGENTS.md'), false);
      assert.equal(targets.some((item) => item.startsWith('.codex/')), false);

      await run(['install', '--project', target, '--target', adapter.id, '--profile', 'core', '--write']);
      const state = JSON.parse(await readFile(path.join(target, '.cognis/install-state.json'), 'utf8'));
      assert.equal(state.adapter, adapter.id);
      assert.equal(state.files.find((file) => file.target === adapter.instruction).contentStrategy, 'managed-instruction-block');
      const installed = await readFile(path.join(target, adapter.instruction), 'utf8');
      assert.match(installed, /# Local instructions/u);
      assert.match(installed, /<!-- COGNIS:START -->/u);
      const validation = await run(['validate', '--project', target]);
      assert.equal(validation.status, 'ready');

      await run(['install', '--project', target, '--target', adapter.id, '--profile', 'core', '--write']);
      await run(['install', '--project', target, '--target', adapter.id, '--profile', 'core', '--write', '--upgrade']);
      const managedRule = path.join(target, 'docs/rules/coding-rules.md');
      await writeFile(managedRule, '# locally modified\n', 'utf8');
      const conflict = await fail(['install', '--project', target, '--target', adapter.id, '--profile', 'core', '--write']);
      assert.match(conflict.error.message, /overwrite existing|user-modified/iu);
      await run(['install', '--project', target, '--target', adapter.id, '--profile', 'core', '--write', '--force']);

      await run(['uninstall', '--project', target, '--target', adapter.id, '--write']);
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
      const target = await mkdtemp(path.join(tmpdir(), `cognis-${adapter}-${profile}-`));
      try {
        await run(['init', '--project', target, '--target', adapter]);
        const configPath = path.join(target, 'cognis.config.json');
        const config = JSON.parse(await readFile(configPath, 'utf8'));
        config.profile = profile;
        config.governance.mode = profile === 'minimal' ? 'off' : 'basic';
        await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

        const installed = await run(['install', '--project', target, '--target', adapter, '--profile', profile, '--write']);
        assert.equal(installed.status, 'ready');
        assert.equal(await exists(path.join(target, adapter === 'claude' ? 'CLAUDE.md' : 'GEMINI.md')), true);
        assert.equal((await run(['validate', '--project', target])).status, 'ready');
        await run(['uninstall', '--project', target, '--target', adapter, '--write']);
      } finally {
        await rm(target, { force: true, recursive: true });
      }
    });
  }
}

for (const adapter of [
  { id: 'claude', skills: '.claude/skills' },
  { id: 'gemini', skills: '.gemini/skills' },
]) {
  test(`${adapter.id} full preview installs seven native Skills without Codex metadata or hooks`, async () => {
    const target = await mkdtemp(path.join(tmpdir(), `cognis-${adapter.id}-full-`));
    try {
      await run(['init', '--project', target, '--target', adapter.id, '--profile', 'full']);
      await run(['install', '--project', target, '--target', adapter.id, '--profile', 'full', '--allow-preview', '--write']);
      const validation = await run(['validate', '--project', target]);
      const doctor = await run(['doctor', '--project', target]);
      assert.equal(validation.status, 'ready');
      assert.equal(doctor.status, 'ready');
      for (const skill of ['clarify-requirements', 'systematic-debugging', 'eval-driven-development', 'security-and-hardening', 'api-and-interface-design', 'frontend-design', 'runtime-cross-repo-rollout']) {
        assert.equal(await exists(path.join(target, adapter.skills, skill, 'SKILL.md')), true);
        assert.equal(await exists(path.join(target, adapter.skills, skill, 'agents/openai.yaml')), false);
      }
      assert.equal(await exists(path.join(target, '.codex/hooks.json')), false);
    } finally {
      await rm(target, { force: true, recursive: true });
    }
  });
}

test('adapter catalog gates preview profiles and rejects target mismatch', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-adapter-errors-'));
  try {
    await run(['init', '--project', target, '--target', 'claude']);
    const unsupported = await fail(['install', '--project', target, '--target', 'claude', '--profile', 'full', '--dry-run']);
    assert.match(unsupported.error.message, /claude.*profile full.*preview.*allow-preview/iu);
    const preview = await run([
      'install', '--project', target, '--target', 'claude', '--profile', 'full', '--dry-run', '--allow-preview',
    ]);
    assert.equal(preview.previewCapabilities.includes('hooks'), true);
    assert.equal(preview.previewCapabilities.includes('mcp'), true);
    assert.equal(preview.missingCapabilities.includes('plugin'), true);
    const mismatch = await fail(['install', '--project', target, '--target', 'gemini', '--profile', 'core', '--dry-run']);
    assert.match(mismatch.error.message, /target.*does not match/iu);
    const legacy = await fail(['install', '--target', 'claude', '--profile', 'core', '--dry-run']);
    assert.match(legacy.error.message, /--project.*--apply|removed/iu);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('adapter capability v2 uses explicit support levels for every governed surface', async () => {
  const catalog = JSON.parse(await readFile(path.join(rootDir, 'manifests/adapters.json'), 'utf8'));
  const capabilityNames = ['instructions', 'skills', 'hooks', 'policy', 'mcp', 'sandbox', 'memory', 'plugin'];
  assert.equal(catalog.schemaVersion, 2);
  for (const adapter of catalog.items) {
    assert.deepEqual(Object.keys(adapter.capabilities).sort(), [...capabilityNames].sort());
    assert.equal(
      Object.values(adapter.capabilities).every((status) => ['unsupported', 'preview', 'stable'].includes(status)),
      true,
    );
  }
});

test('install and upgrade reject an adapter that differs from install state', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-adapter-state-'));
  try {
    await run(['init', '--project', target, '--target', 'claude']);
    await run(['install', '--project', target, '--target', 'claude', '--profile', 'core', '--write']);
    const configPath = path.join(target, 'cognis.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    await writeFile(configPath, `${JSON.stringify({ ...config, target: 'gemini' }, null, 2)}\n`, 'utf8');

    for (const extraArgs of [[], ['--upgrade']]) {
      const report = await fail(['install', '--project', target, '--target', 'gemini', '--profile', 'core', '--write', ...extraArgs]);
      assert.match(report.error.message, /Installed adapter claude does not match install target gemini/iu);
    }
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('shared install map declares explicit portable content strategies', async () => {
  const installMap = JSON.parse(await readFile(path.join(rootDir, 'adapters/codex/install-map.json'), 'utf8'));
  const allowed = new Set(['managed-instruction-block', 'managed-toml-block', 'replace']);
  assert.equal(installMap.entries.every((entry) => allowed.has(entry.contentStrategy)), true);
});

test('managed instruction helpers are platform-neutral and preserve local content', () => {
  const merged = mergeManagedInstructionBlock('# Local\n', '# Managed\n');
  assert.equal(extractManagedInstructionBlock(merged)?.includes('# Managed'), true);
  assert.equal(removeManagedInstructionBlock(merged), '# Local\n');
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
    source: 'rules/git-rules.md',
    target: '.secure/policy.md',
  });
  assert.equal(resolved.redZone, true);
});

test('all platform instruction entrypoints stay below ninety lines', async () => {
  for (const [adapter, filename] of [['codex', 'AGENTS'], ['claude', 'CLAUDE'], ['gemini', 'GEMINI']]) {
    const content = await readFile(path.join(rootDir, 'adapters', adapter, `${filename}.template.md`), 'utf8');
    assert.equal(content.split(/\r?\n/u).length <= 90, true, `${filename}.md exceeds the resident line budget`);
  }
});

test('adapter profile file sets match the reviewed snapshots', async () => {
  const snapshots = {
    'claude:core': [34, 'b7ada2376dd30fc00959a5a0f60f8796615d7be393390468117af45f829606d1'],
    'claude:docs-only': [29, '66b1c875eed445824b30d7f6d7ae001107f5d4f197e181ba865096794925724f'],
    'claude:minimal': [7, 'de8bef97b2444d03ddb8077a187a05e0dc1d976f97cfce2daf87d77262d5c9ba'],
    'codex:core': [38, 'ce39431a705060cab04f650bfcf06ca13d884dca412f5fb3fce14b300045e348'],
    'codex:full': [61, '26b231d6ebcc1a6c0e3f38fb54fecb2f41554d959c74545d70750a3555f7664b'],
    'codex:minimal': [7, 'acf92f049c50289f3eec6136e888f50b32b389d8a80e75a8b344a20ad37d6789'],
    'gemini:core': [34, 'cbd5827e4346d57e8062aae868c940a9cd4e314c2dd53c67c29e3b4c34dd5f98'],
    'gemini:docs-only': [29, '428c26d9f51fe99cfa520cb63f4b2aa8cfb7bfdd8b605a927cc0352af6ca2b89'],
    'gemini:minimal': [7, '8e6fc02f1c019b5cea55ac49567af9bd4b2b75ed62f97731e0dbcd962293eb4a'],
  };

  for (const [key, [count, digest]] of Object.entries(snapshots)) {
    const [adapterId, profile] = key.split(':');
    const plan = await createInstallPlan({
      adapterId,
      dryRun: true,
      managedAgentsBlock: true,
      profile,
      rootDir,
      targetDir: path.join(rootDir, '.tmp-adapter-snapshot'),
    });
    const targets = plan.actions.map((action) => action.relativeTarget).sort();
    assert.equal(targets.length, count, `${key} file count changed`);
    assert.equal(createHash('sha256').update(JSON.stringify(targets)).digest('hex'), digest, `${key} file set changed`);
  }
});

test('README platform support matches the adapter catalog', async () => {
  const [catalog, readme, localizedReadme] = await Promise.all([
    readFile(path.join(rootDir, 'manifests/adapters.json'), 'utf8').then(JSON.parse),
    readFile(path.join(rootDir, 'README.md'), 'utf8'),
    readFile(path.join(rootDir, 'README.zh-CN.md'), 'utf8'),
  ]);
  for (const adapter of catalog.items) {
    for (const profile of adapter.supportedProfiles.filter((item) => ['minimal', 'core', 'full', 'docs-only'].includes(item))) {
      assert.equal(readme.includes(profile), true, `README omits ${adapter.id}:${profile}`);
      assert.equal(localizedReadme.includes(profile), true, `README.zh-CN omits ${adapter.id}:${profile}`);
    }
  }
  assert.doesNotMatch(readme, /非 Codex adapter.*后续路线/u);
  assert.doesNotMatch(localizedReadme, /非 Codex adapter.*后续路线/u);
});
