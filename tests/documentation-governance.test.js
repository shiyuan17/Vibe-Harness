import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { pathExists, readJson } from '../scripts/lib/manifest.js';

const rootDir = path.resolve('.');
const validatorPath = path.join(rootDir, 'scripts/lib/docs-validation.js');

async function loadValidator() {
  assert.equal(await pathExists(validatorPath), true, 'documentation validator is missing');
  return import('../scripts/lib/docs-validation.js');
}

test('repository declares the documentation governance contract', async () => {
  for (const file of [
    'CONTRIBUTING.md',
    'docs/README.md',
    'docs/catalog.json',
    'schemas/docs-catalog.schema.json',
    'scripts/docs-audit.js',
    'scripts/lib/docs-validation.js',
    '.github/pull_request_template.md',
  ]) {
    assert.equal(await pathExists(path.join(rootDir, file)), true, `${file} is missing`);
  }
});

test('repository ignores canonical and legacy project-local runtime state', async () => {
  const gitignore = await readFile(path.join(rootDir, '.gitignore'), 'utf8');
  assert.match(gitignore, /^\.cognis\/$/mu);
  assert.match(gitignore, /^\.loopengine\/$/mu);
});

test('legacy product names are rejected outside the compatibility allowlist', async () => {
  const { validateLegacyBrandUsage } = await loadValidator();
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'cognis-brand-audit-'));
  try {
    await writeFile(path.join(fixture, 'active.js'), "export const product = 'LoopEngine';\n", 'utf8');
    await mkdir(path.join(fixture, 'scripts'));
    await writeFile(path.join(fixture, 'scripts', 'cognis.js'), [
      "console.log('Cognis still ships as LoopEngine');",
      'const product = "loopengine";',
      '',
    ].join('\n'), 'utf8');
    const errors = await validateLegacyBrandUsage({ rootDir: fixture });
    assert.deepEqual(errors, [
      'active.js contains legacy product identity outside the compatibility allowlist',
      'scripts/cognis.js contains legacy product identity outside the compatibility allowlist',
    ]);
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});

test('current release notes use Cognis names for current interfaces', async () => {
  const changelog = await readFile(path.join(rootDir, 'CHANGELOG.md'), 'utf8');
  const currentRelease = changelog.split(/^## 0\.3\.0$/mu, 1)[0];
  assert.doesNotMatch(currentRelease, /using-loopengine|新增 `loopengine (?:verify|baseline)/u);
});

test('governance documentation defines a vendor-neutral prompt cache contract', async () => {
  const [kernel, spec, template, architecture, index] = await Promise.all([
    readFile(path.join(rootDir, 'rules/governance-core.md'), 'utf8'),
    readFile(path.join(rootDir, 'docs/specs/cognis-v0.7-adaptive-orchestration-spec.md'), 'utf8'),
    readFile(path.join(rootDir, 'templates/task.md'), 'utf8'),
    readFile(path.join(rootDir, 'docs/architecture.md'), 'utf8'),
    readFile(path.join(rootDir, 'docs/README.md'), 'utf8'),
  ]);

  assert.match(kernel, /Prompt Cache/iu);
  assert.match(kernel, /稳定前缀[\s\S]*动态后缀/iu);
  assert.match(kernel, /指纹/iu);
  assert.match(kernel, /敏感[^\n]*(?:不得|不应)[^\n]*(?:持久化|缓存)/iu);
  const stablePrefix = kernel.match(/#### 稳定前缀([\s\S]*?)#### 动态后缀/iu)?.[1] ?? '';
  assert.notEqual(stablePrefix, '');
  assert.doesNotMatch(stablePrefix, /时间戳|随机 ID|实时日志|未排序集合/iu);

  assert.match(spec, /Prompt Cache/iu);
  assert.match(spec, /child[\s\S]*(?:最小|稳定)[^\n]*上下文/iu);
  assert.match(spec, /fan-in[\s\S]*(?:刷新|复验)[^\n]*动态/iu);
  assert.match(spec, /governanceHash[\s\S]*(?:不变|语义)/iu);
  assert.match(spec, /任务切换|规范变更|adapter 变更/iu);
  assert.match(template, /上下文缓存边界/iu);
  assert.match(template, /稳定前缀/iu);
  assert.match(architecture, /Prompt Cache/iu);
  assert.match(architecture, /无法提供 prefix cache[\s\S]*(?:完整|原有)[^\n]*提示/iu);
  assert.match(index, /Prompt Cache|缓存分层/iu);
});

test('current docs describe all managed tools as explicit plugins', async () => {
  const [english, chinese, architecture, toolingSpec, changelog, capabilities] = await Promise.all([
    readFile(path.join(rootDir, 'README.md'), 'utf8'),
    readFile(path.join(rootDir, 'README.zh-CN.md'), 'utf8'),
    readFile(path.join(rootDir, 'docs/architecture.md'), 'utf8'),
    readFile(path.join(rootDir, 'docs/specs/cognis-tooling-modules-spec.md'), 'utf8'),
    readFile(path.join(rootDir, 'CHANGELOG.md'), 'utf8'),
    readJson(path.join(rootDir, 'manifests/capabilities.json')),
  ]);

  assert.match(english, /No profile installs external tool plugins by default/u);
  assert.match(english, /`chrome-devtools-mcp`/u);
  assert.match(english, /`playwright-cli`.*`open-code-review`/u);
  assert.match(chinese, /所有 profile 默认都不安装外部工具插件/u);
  assert.match(chinese, /`chrome-devtools-mcp`/u);
  assert.match(chinese, /`playwright-cli`.*`open-code-review`/u);
  assert.match(architecture, /显式工具插件规格/u);
  assert.match(toolingSpec, /Chrome DevTools MCP[\s\S]*1\.6\.0/u);
  assert.match(changelog, /Chrome DevTools MCP[\s\S]*项目内/u);
  assert.doesNotMatch(changelog, /DevTools MCP fallback 已退役/u);
  assert.ok(capabilities.items.some((item) => item.id === 'chrome-devtools-mcp'));
});

test('source mapping points only at current governance assets', async () => {
  const mapping = await readFile(path.join(rootDir, 'docs/inventory/source-rules-mapping.md'), 'utf8');
  for (const retired of ['rules/workflow.md', 'rules/dynamic-workflow.md', 'rules/task-lifecycle.md']) {
    assert.equal(mapping.includes(retired), false, `retired source mapping remains: ${retired}`);
  }
  for (const current of [
    'rules/governance-core.md',
    'templates/task.md',
    'rules/agent-skill-routing.md',
  ]) {
    assert.equal(mapping.includes(current), true, `current source mapping is missing: ${current}`);
    assert.equal(await pathExists(path.join(rootDir, current)), true, `mapped target is missing: ${current}`);
  }
});

test('documentation catalog covers the governed knowledge base and passes policy checks', async () => {
  const { validateDocumentation } = await loadValidator();
  const report = await validateDocumentation({ rootDir });
  assert.deepEqual(report.errors, [], JSON.stringify(report, null, 2));
  assert.equal(report.counts.cataloged > 0, true);
  assert.equal(report.counts.governed, report.counts.cataloged);
});

test('documentation catalog rejects duplicates and invalid historical relationships', async () => {
  const { validateDocumentation } = await loadValidator();
  const catalog = await readJson(path.join(rootDir, 'docs/catalog.json'));
  const duplicate = { ...catalog, items: [...catalog.items, catalog.items[0]] };
  const duplicateReport = await validateDocumentation({ catalog: duplicate, rootDir });
  assert.match(duplicateReport.errors.join('\n'), /duplicate documentation path/iu);

  const missingEntry = { ...catalog, items: catalog.items.slice(1) };
  const missingEntryReport = await validateDocumentation({ catalog: missingEntry, rootDir });
  assert.match(missingEntryReport.errors.join('\n'), /missing from catalog/iu);

  const invalidStatus = {
    ...catalog,
    items: catalog.items.map((item, index) => index === 0 ? { ...item, status: 'stale' } : item),
  };
  const invalidStatusReport = await validateDocumentation({ catalog: invalidStatus, rootDir });
  assert.match(invalidStatusReport.errors.join('\n'), /status must be one of/iu);

  const superseded = catalog.items.find((item) => item.status === 'superseded');
  assert.ok(superseded, 'fixture requires one superseded document');
  const missingReplacement = {
    ...catalog,
    items: catalog.items.map((item) => item.path === superseded.path
      ? { ...item, supersededBy: 'docs/missing.md' }
      : item),
  };
  const replacementReport = await validateDocumentation({ catalog: missingReplacement, rootDir });
  assert.match(replacementReport.errors.join('\n'), /supersededBy/iu);

  const misplaced = {
    ...catalog,
    items: catalog.items.map((item) => item.path === superseded.path
      ? { ...item, path: 'docs/not-archived.md' }
      : item),
  };
  const misplacedReport = await validateDocumentation({ catalog: misplaced, rootDir });
  assert.match(misplacedReport.errors.join('\n'), /must be under docs\/archive/iu);

  const archiveMarkedCurrent = {
    ...catalog,
    items: catalog.items.map((item) => item.path === superseded.path
      ? Object.fromEntries(Object.entries({ ...item, status: 'current' }).filter(([key]) => key !== 'supersededBy'))
      : item),
  };
  const archiveStatusReport = await validateDocumentation({ catalog: archiveMarkedCurrent, rootDir });
  assert.match(archiveStatusReport.errors.join('\n'), /archived document must use completed or superseded status/iu);

  const malformedReport = await validateDocumentation({
    catalog: { schemaVersion: 1, items: 'invalid' },
    rootDir,
  });
  assert.match(malformedReport.errors.join('\n'), /docs catalog\.items must be array/iu);
});

test('documentation policy detects broken links, mixed lifecycle flags, relative time, and stale open items', async () => {
  const { validateCurrentDocumentContent } = await loadValidator();
  const errors = await validateCurrentDocumentContent({
    content: [
      '[broken](missing.md)',
      'pnpm cognis install `',
      '  --project ../app `',
      '  --apply',
      '最近需要复核。',
      '待办：',
      '- 截止 2026-01-01，仍需处理。',
      '- [ ] 复核 2026-01-02 的结论。',
      '当前仍使用九阶段治理。',
    ].join('\n'),
    file: 'docs/example.md',
    rootDir,
    today: new Date('2026-07-15T00:00:00.000Z'),
  });
  assert.match(errors.join('\n'), /broken relative link/iu);
  assert.match(errors.join('\n'), /mixes --project with legacy --apply/iu);
  assert.match(errors.join('\n'), /relative time/iu);
  assert.match(errors.join('\n'), /stale open item/iu);
  assert.match(errors.join('\n'), /nine-stage governance/iu);
});

test('documentation policy rejects duplicate Cognis commands within one README', async () => {
  const { validateCurrentDocumentContent } = await loadValidator();
  const command = 'pnpm cognis validate --project ../example';
  const errors = await validateCurrentDocumentContent({
    content: ['# Example', '', command, '', 'More guidance.', '', command].join('\n'),
    file: 'README.md',
    rootDir,
  });
  assert.match(errors.join('\n'), /duplicate Cognis command/iu);
});

test('resident adapter instructions keep detailed governance in the kernel only', async () => {
  const [kernel, rootAgents, ...templates] = await Promise.all([
    readFile(path.join(rootDir, 'rules/governance-core.md'), 'utf8'),
    readFile(path.join(rootDir, 'AGENTS.md'), 'utf8'),
    readFile(path.join(rootDir, 'adapters/codex/AGENTS.template.md'), 'utf8'),
    readFile(path.join(rootDir, 'adapters/claude/CLAUDE.template.md'), 'utf8'),
    readFile(path.join(rootDir, 'adapters/gemini/GEMINI.template.md'), 'utf8'),
  ]);

  assert.match(kernel, /## 五条硬约束/u);
  for (const template of templates) {
    assert.doesNotMatch(template, /## 五条硬约束/u);
    assert.doesNotMatch(template, /主张 → 证据 → 反例 → 剩余风险/u);
    assert.match(template, /治理内核/u);
  }
  assert.match(rootAgents, /`rules\/governance-core\.md`/u);
  assert.match(rootAgents, /`templates\/delivery\.md`/u);
});

test('RTK documentation assigns hook, usage, entry, version, and status contracts to one owner', async () => {
  const files = Object.fromEntries(await Promise.all([
    ['readme', 'README.md'],
    ['readmeZh', 'README.zh-CN.md'],
    ['architecture', 'docs/architecture.md'],
    ['hooks', 'docs/hooks.md'],
    ['rule', 'rules/rtk.md'],
    ['spec', 'docs/specs/cognis-tooling-modules-spec.md'],
  ].map(async ([name, file]) => [name, await readFile(path.join(rootDir, file), 'utf8')])));

  assert.match(files.hooks, /--rtk-hooks/u);
  assert.match(files.hooks, /observe[\s\S]*guarded[\s\S]*strict/iu);
  assert.match(files.rule, /rtk init -g/u);
  assert.match(files.rule, /`proxy` 子命令显式 bypass/u);
  assert.match(files.spec, /tools\/rtk\/run\.mjs proxy/u);
  assert.match(files.spec, /v0\.43\.0/u);
  assert.match(files.spec, /工具状态为 `pending`、`ready`、`degraded` 或 `unsupported`/u);

  for (const name of ['readme', 'readmeZh', 'architecture', 'rule']) {
    assert.doesNotMatch(files[name], /--rtk-hooks/u, `${name} duplicates the RTK hook contract`);
  }
  for (const name of ['readme', 'readmeZh', 'architecture', 'hooks']) {
    assert.doesNotMatch(files[name], /rtk init -g/u, `${name} duplicates the RTK global-install boundary`);
  }
  for (const name of ['readme', 'readmeZh', 'architecture', 'hooks', 'rule']) {
    assert.doesNotMatch(files[name], /tools\/rtk\/run\.mjs/u, `${name} duplicates the RTK entry contract`);
  }
  for (const name of ['readme', 'readmeZh', 'architecture', 'hooks', 'rule']) {
    assert.doesNotMatch(files[name], /v0\.43\.0/u, `${name} duplicates the RTK version contract`);
  }
  for (const name of ['readme', 'readmeZh', 'hooks', 'rule']) {
    assert.doesNotMatch(files[name], /工具状态为|Individual tools additionally report/u, `${name} duplicates the tool status contract`);
  }
});

test('documentation coverage includes every root Markdown knowledge file', async () => {
  const { collectGovernedPaths } = await loadValidator();
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'cognis-docs-coverage-'));
  try {
    await writeFile(path.join(fixture, 'README.md'), '# README\n', 'utf8');
    await writeFile(path.join(fixture, 'ROOT-NOTES.md'), '# Notes\n', 'utf8');
    assert.deepEqual(await collectGovernedPaths(fixture), ['README.md', 'ROOT-NOTES.md']);
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});

test('documentation policy validates inline images and reference-style links', async () => {
  const { validateCurrentDocumentContent } = await loadValidator();
  const errors = await validateCurrentDocumentContent({
    content: [
      '![missing image](missing.png)',
      '[missing reference][guide]',
      '[guide]: missing-guide.md',
      '[undefined reference][not-declared]',
    ].join('\n'),
    file: 'docs/example.md',
    rootDir,
  });
  assert.match(errors.join('\n'), /missing\.png/iu);
  assert.match(errors.join('\n'), /missing-guide\.md/iu);
  assert.match(errors.join('\n'), /undefined reference: not-declared/iu);
});

test('completed task-list siblings do not inherit an open item stale date', async () => {
  const { validateCurrentDocumentContent } = await loadValidator();
  const errors = await validateCurrentDocumentContent({
    content: [
      '- [ ] Review by 2027-01-01',
      '- [x] Migrated on 2025-01-01',
    ].join('\n'),
    file: 'docs/example.md',
    rootDir,
    today: new Date('2026-07-15T00:00:00.000Z'),
  });
  assert.deepEqual(errors, []);
});

test('English and Chinese README command and JSON examples remain equivalent', async () => {
  const { validateReadmeParity } = await loadValidator();
  const [english, chinese] = await Promise.all([
    readFile(path.join(rootDir, 'README.md'), 'utf8'),
    readFile(path.join(rootDir, 'README.zh-CN.md'), 'utf8'),
  ]);
  assert.deepEqual(validateReadmeParity(english, chinese), []);
  assert.match(
    validateReadmeParity(english, chinese.replace('--profile core --write', '--profile full --write')).join('\n'),
    /command examples differ/iu,
  );
  assert.deepEqual(validateReadmeParity(
    '```json\n{"outer":{"b":2,"a":1}}\n```',
    '```json\n{"outer":{"a":1,"b":2}}\n```',
  ), []);
  assert.match(validateReadmeParity(
    'pnpm cognis install \\\n  --project app \\\n  --write',
    'pnpm cognis install \\\n  --project app \\\n  --dry-run',
  ).join('\n'), /command examples differ/iu);
});
