import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createInstalledSurface } from '../../scripts/lib/install-planner.js';
import { existingRuleSources, loadRuleIndex, renderRuleIndexLine, ruleGroupLabel } from '../../scripts/lib/rules-index.js';
import { renderTemplate, withDefaultTemplateData } from '../../scripts/lib/template-renderer.js';

const rootDir = path.resolve(import.meta.dirname, '../..');

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
  const line = renderRuleIndexLine(index);
  assert.match(line, /^治理 governance-core（Vibe-Harness 执行内核）/u);
  assert.match(line, /；工程 [^；]*coding-rules（编码规则）[^；]*/u);
  assert.match(line, /；工具与集成 [^；]*rtk（RTK 命令输出压缩规则）、ast-grep（ast-grep 结构化搜索规则）/u);
  assert.match(line, /；发布与排障 release-rules（发布规则）、troubleshooting（排障规则）$/u);
});

test('every packaged rule has an explicit routing group', async () => {
  const index = await loadRuleIndex(rootDir);
  const ungrouped = index.filter((item) => ruleGroupLabel(item.id) === '其他');
  assert.deepEqual(ungrouped.map((item) => item.id), []);
  assert.equal(renderRuleIndexLine(index).includes('其他 '), false);
  assert.equal(ruleGroupLabel('a-rule-the-pack-does-not-ship'), '其他');
});

test('adapter instruction templates render without blank placeholder lines', async () => {
  const templates = ['codex/AGENTS', 'claude/CLAUDE', 'gemini/GEMINI', 'opencode/AGENTS', 'antigravity/RULES'];
  const rulesLine = '- 规则位于 `docs/rules/`。命中索引：治理 git-rules（Git 规则）。';
  for (const name of templates) {
    const template = await readFile(path.join(rootDir, `adapters/${name}.template.md`), 'utf8');
    const rendered = renderTemplate(template, { installedSurface: { rulesLine } });
    assert.equal(rendered.includes('{{'), false, `${name} left a placeholder unresolved`);
    assert.equal(/\n[ \t]*\n[ \t]*\n/u.test(rendered), false, `${name} rendered a blank line`);
    assert.ok(rendered.split('- 规则位于').length - 1 <= 1, `${name} repeated the rules line`);
    assert.equal(rendered.includes('工程专项规则'), false, `${name} kept the synonymous rule lines`);
    if (name !== 'antigravity/RULES') assert.equal(rendered.includes(rulesLine), true, `${name} dropped the rules index`);
  }
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
  assert.equal(installed.rulesLine, '- 规则位于 `docs/rules/`。命中索引：治理 git-rules（Git 规则）。');
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
  assert.equal(installed.rulesLine, '- 规则位于 `docs/rules/`。命中索引：治理 governance-core（Vibe-Harness 执行内核）、git-rules（Git 规则）。');
  // A rule the selected profile, module or plugin did not install must not be
  // advertised: the host would route to a file that is not in the project.
  assert.equal(installed.rulesLine.includes('codebase-memory-mcp'), false);
});

test('既有规则源遵循安装状态所有权台账', async () => {
  const ruleIndex = [
    { id: 'git-rules', source: 'docs/rules/git-rules.md', title: 'Git 规则' },
    { id: 'rtk', source: 'docs/rules/rtk.md', title: 'RTK 命令输出压缩规则' },
    { id: 'ast-grep', source: 'docs/rules/ast-grep.md', title: 'ast-grep 结构化搜索规则' },
  ];
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-rules-owned-'));
  try {
    await mkdir(path.join(target, 'docs/rules'), { recursive: true });
    await mkdir(path.join(target, '.vibe-harness'), { recursive: true });
    for (const item of ruleIndex) {
      await writeFile(path.join(target, item.source), `# ${item.title}\n`, 'utf8');
    }
    await writeFile(path.join(target, '.vibe-harness/install-state.json'), JSON.stringify({
      files: [
        { created: true, group: 'rules', redZone: false, source: 'docs/rules/git-rules.md', sourceHash: '0', target: 'docs/rules/git-rules.md', targetHash: '0' },
        { created: true, group: 'rules', redZone: false, source: 'docs/rules/rtk.md', sourceHash: '0', target: 'docs/rules/rtk.md', targetHash: '0' },
      ],
      profile: 'core',
      version: '0.3.0',
    }), 'utf8');

    // On disk but never installed (the pack-repository situation for the
    // optional plugin rules): present without ownership, so not advertised.
    const sources = await existingRuleSources(target, ruleIndex);
    assert.deepEqual(sources, ['docs/rules/git-rules.md', 'docs/rules/rtk.md']);

    // A partial write set keeps the resident index complete: every owned rule
    // stays listed even when this run rewrites only a subset of them.
    const plan = createInstalledSurface({
      profile: 'core',
      projectRuleSources: sources,
      ruleIndex,
      targets: ['docs/rules/git-rules.md'],
    });
    assert.equal(plan.rulesLine.includes('rtk（RTK 命令输出压缩规则）'), true);
    assert.equal(plan.rulesLine.includes('ast-grep'), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('a project that never installed a rule file is not advertised to it', async () => {
  const ruleIndex = [
    { id: 'git-rules', source: 'docs/rules/git-rules.md', title: 'Git 规则' },
    { id: 'rtk', source: 'docs/rules/rtk.md', title: 'RTK 命令输出压缩规则' },
  ];
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-rules-existing-'));
  try {
    await mkdir(path.join(target, 'docs/rules'), { recursive: true });
    await writeFile(path.join(target, 'docs/rules/rtk.md'), '# RTK\n', 'utf8');

    // Without an install state nothing is owned, so the on-disk file is not
    // advertised even though it exists.
    assert.deepEqual(await existingRuleSources(target, ruleIndex), []);

    await mkdir(path.join(target, '.vibe-harness'), { recursive: true });
    await writeFile(path.join(target, '.vibe-harness/install-state.json'), JSON.stringify({
      files: [
        { created: true, group: 'rules', redZone: false, source: 'docs/rules/rtk.md', sourceHash: '0', target: 'docs/rules/rtk.md', targetHash: '0' },
      ],
      profile: 'core',
      version: '0.3.0',
    }), 'utf8');

    const sources = await existingRuleSources(target, ruleIndex);
    assert.deepEqual(sources, ['docs/rules/rtk.md']);

    const installed = createInstalledSurface({
      profile: 'core',
      projectRuleSources: sources,
      ruleIndex,
      targets: ['docs/rules/git-rules.md'],
    });
    assert.equal(installed.rulesLine, '- 规则位于 `docs/rules/`。命中索引：治理 git-rules（Git 规则）；工具与集成 rtk（RTK 命令输出压缩规则）。');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('安装了项目脚本时启动锚点点名运行时任务入口', async () => {
  const surface = createInstalledSurface({
    profile: 'core',
    ruleIndex: [],
    targets: ['.agents/runtime/commands/run.mjs', 'docs/rules/git-rules.md'],
  });
  const data = withDefaultTemplateData({ installedSurface: surface });
  assert.match(data.installedSurface.startupLines, /run\.mjs task init --project <path> --write/u);
  assert.match(data.installedSurface.startupLines, /\.vibe-harness\/tasks\//u);
  assert.match(data.installedSurface.startupLines, /verify --reuse/u);
  const bare = withDefaultTemplateData({});
  assert.doesNotMatch(bare.installedSurface.startupLines, /task init/u);
  assert.match(bare.installedSurface.startupLines, /先建立状态锚点/u);
});

test('existing rule sources are empty without a target project', async () => {
  assert.deepEqual(await existingRuleSources('', [{ id: 'git-rules', source: 'docs/rules/git-rules.md', title: 'Git 规则' }]), []);
});
