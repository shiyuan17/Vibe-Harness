import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createInstalledSurface } from '../scripts/lib/install-planner.js';
import { loadRuleIndex, renderRuleIndexLine } from '../scripts/lib/rules-index.js';

const rootDir = path.resolve(import.meta.dirname, '..');

async function withTemporaryPack(manifest, rules, run) {
  const packDir = await mkdtemp(path.join(tmpdir(), 'vibe-rules-index-'));
  try {
    await mkdir(path.join(packDir, 'manifests'), { recursive: true });
    await mkdir(path.join(packDir, 'docs/rules'), { recursive: true });
    await writeFile(path.join(packDir, 'manifests/rules.json'), JSON.stringify(manifest, null, 2), 'utf8');
    for (const [name, content] of Object.entries(rules)) {
      await writeFile(path.join(packDir, 'docs/rules', name), content, 'utf8');
    }
    return await run(packDir);
  } finally {
    await rm(packDir, { force: true, recursive: true });
  }
}

test('the rule index is derived from the rule manifest and each rule heading', async () => {
  const manifest = JSON.parse(await readFile(path.join(rootDir, 'manifests/rules.json'), 'utf8'));
  const index = await loadRuleIndex(rootDir);
  assert.equal(index.length, manifest.items.length);
  assert.deepEqual(index.map((item) => item.id), manifest.items.map((item) => item.id));
  for (const item of index) {
    const heading = String(await readFile(path.join(rootDir, item.source), 'utf8')).match(/^#[ \t]+(.+?)[ \t]*$/mu)[1].trim();
    assert.equal(item.title, heading);
  }
  assert.match(renderRuleIndexLine(index), /^governance-core（.+）[、\s\S]*ast-grep（.+）$/u);
});

test('a manifest entry without a matching rule file or heading fails closed', async () => {
  await withTemporaryPack(
    { schemaVersion: 1, items: [{ id: 'missing', source: 'docs/rules/missing.md' }] },
    {},
    async (packDir) => {
      await assert.rejects(loadRuleIndex(packDir), /ENOENT/u);
    },
  );
  await withTemporaryPack(
    { schemaVersion: 1, items: [{ id: 'headingless', source: 'docs/rules/headingless.md' }] },
    { 'headingless.md': 'no heading here\n' },
    async (packDir) => {
      await assert.rejects(loadRuleIndex(packDir), /has no first heading/u);
    },
  );
  await withTemporaryPack(
    { schemaVersion: 1, items: [{ id: '', source: 'docs/rules/git-rules.md' }] },
    { 'git-rules.md': '# Git 规则\n' },
    async (packDir) => {
      await assert.rejects(loadRuleIndex(packDir), /non-empty id and source/u);
    },
  );
  await withTemporaryPack(
    { schemaVersion: 2, items: [] },
    {},
    async (packDir) => {
      await assert.rejects(loadRuleIndex(packDir), /schemaVersion 1/u);
    },
  );
});

test('the installed surface carries the index only when docs/rules is installed', () => {
  const ruleIndex = [{ id: 'git-rules', source: 'docs/rules/git-rules.md', title: 'Git 规则' }];
  const installed = createInstalledSurface({
    profile: 'core',
    ruleIndex,
    targets: ['docs/rules/git-rules.md', 'docs/rules/coding-rules.md'],
  });
  assert.equal(installed.rulesLine, '- 规则位于 `docs/rules/`。命中索引：git-rules（Git 规则）。');
  const withoutRules = createInstalledSurface({ profile: 'core', ruleIndex, targets: ['AGENTS.md'] });
  assert.equal(withoutRules.rulesLine, '');
});

test('the installed surface lists only the rules the plan installs', () => {
  const ruleIndex = [
    { id: 'governance-core', source: 'docs/rules/governance-core.md', title: 'Vibe-Harness 执行内核' },
    { id: 'git-rules', source: 'docs/rules/git-rules.md', title: 'Git 规则' },
    { id: 'codebase-memory-mcp', source: 'docs/rules/codebase-memory-mcp.md', title: 'codebase-memory-mcp' },
  ];
  const installed = createInstalledSurface({
    profile: 'minimal',
    ruleIndex,
    targets: ['docs/rules/governance-core.md', 'docs/rules/git-rules.md'],
  });
  assert.equal(installed.rulesLine, '- 规则位于 `docs/rules/`。命中索引：governance-core（Vibe-Harness 执行内核）、git-rules（Git 规则）。');
  // A rule the selected profile, module or plugin did not install must not be
  // advertised: the host would route to a file that is not in the project.
  assert.equal(installed.rulesLine.includes('codebase-memory-mcp'), false);
});
