import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  collectGovernedPaths,
  validateDocumentation,
  validateLegacyBrandUsage,
  validateReadmeParity,
  validateCanonicalRuleLayout,
  validateSchemaParity,
} from '../scripts/lib/docs-validation.js';

const rootDir = path.resolve(import.meta.dirname, '..');

test('documentation catalog covers current and archived Markdown', async () => {
  const report = await validateDocumentation({ rootDir });
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
});

test('AGENTS validation guidance wires repository typecheck into repo check and project verify', async () => {
  const agents = await readFile(path.join(rootDir, 'AGENTS.md'), 'utf8');
  assert.match(agents, /pnpm typecheck/u);
  assert.match(agents, /已并入 `pnpm check` 与项目 verify 默认命令/u);
  assert.doesNotMatch(agents, /未接入项目 verify 默认命令/u);
  assert.match(agents, /TypeScript 配置、类型声明、JSDoc 类型契约/u);
});

test('read-only evaluation keeps Memory body access behind recovery and authorization', async () => {
  const scenario = {
    memoryBodyAuthorized: false,
    needsProjectStateRecovery: false,
    skillEvidenceBoundary: 'metadata-only',
  };
  const [agents, codexTemplate, opencodeTemplate, rule, installPlanner, renderer] = await Promise.all([
    readFile(path.join(rootDir, 'AGENTS.md'), 'utf8'),
    readFile(path.join(rootDir, 'adapters/codex/AGENTS.template.md'), 'utf8'),
    readFile(path.join(rootDir, 'adapters/opencode/AGENTS.template.md'), 'utf8'),
    readFile(path.join(rootDir, 'docs/rules/governance-core.md'), 'utf8'),
    readFile(path.join(rootDir, 'scripts/lib/install-planner.js'), 'utf8'),
    readFile(path.join(rootDir, 'scripts/lib/template-renderer.js'), 'utf8'),
  ]);
  const bodyReadAllowed = scenario.needsProjectStateRecovery
    && scenario.memoryBodyAuthorized
    && scenario.skillEvidenceBoundary !== 'metadata-only';

  assert.equal(bodyReadAllowed, false);
  assert.match(agents, /仅当任务需要恢复项目状态且当前授权允许/u);
  // The managed block is generated, so the boundary must be asserted in the
  // form createInstalledSurface emits rather than as a hand-added 硬边界 bullet.
  assert.match(agents, /当专项 Skill 限制 Memory 证据边界时，仅检查相关 Memory 路径是否存在及必要元数据、不读取其正文/u);
  assert.equal(codexTemplate, opencodeTemplate);
  assert.match(renderer, /surface\.memoryLoadLine/u);
  assert.match(rule, /仅当任务需要恢复项目状态且当前授权允许时读取 Memory body/u);
  assert.match(rule, /只检查相关 Memory 路径是否存在及必要元数据、不读取其正文/u);
  assert.match(installPlanner, /仅当任务需要恢复项目状态且当前授权允许读取 Memory body 时/u);
  assert.match(installPlanner, /当专项 Skill 限制 Memory 证据边界时，仅检查相关 Memory 路径是否存在及必要元数据、不读取其正文/u);
});

test('legacy brand audit ignores archive assets', async () => {
  const tmp = await mkdtemp(path.join(import.meta.dirname, 'tmp-legacy-archive-'));
  try {
    await writeFile(path.join(tmp, 'release.zip'), 'LoopEngine', 'utf8');
    assert.deepEqual(await validateLegacyBrandUsage({ rootDir: tmp }), []);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('execution envelope schemas are governed without Markdown false positives', async () => {
  const governedPaths = await collectGovernedPaths(rootDir);
  assert.ok(governedPaths.includes('docs/schemas/execution-envelope.schema.json'));
  assert.ok(governedPaths.includes('schemas/execution-envelope.schema.json'));

  const report = await validateDocumentation({ rootDir });
  const schemaErrors = report.errors.filter((error) => error.includes('execution-envelope.schema.json'));
  assert.deepEqual(schemaErrors, []);
});

test('cataloged non-Markdown assets must exist', async () => {
  const catalog = JSON.parse(await readFile(path.join(rootDir, 'docs/catalog.json'), 'utf8'));
  const missingPath = 'schemas/does-not-exist.schema.json';
  catalog.items.push({
    path: missingPath,
    kind: 'spec',
    status: 'current',
    language: 'en',
    audiences: ['maintainer'],
  });

  const report = await validateDocumentation({ catalog, rootDir });
  assert.ok(report.errors.includes('catalog documentation does not exist: ' + missingPath));
});

test('Primary and secondary README expose the same commands and configuration', async () => {
  const [primary, secondary] = await Promise.all([
    readFile(path.join(rootDir, 'README.md'), 'utf8'),
    readFile(path.join(rootDir, 'README.en.md'), 'utf8'),
  ]);
  assert.deepEqual(validateReadmeParity(primary, secondary), []);
});

test('README quick start exposes three profile prompts with the plugin indexing contract', async () => {
  const readmes = await Promise.all([
    readFile(path.join(rootDir, 'README.md'), 'utf8'),
    readFile(path.join(rootDir, 'README.en.md'), 'utf8'),
  ]);

  for (const readme of readmes) {
    const quickStart = readme.match(/## (?:Quick start|\u5feb\u901f\u5f00\u59cb)([\s\S]*?)\n## /u)?.[1] ?? '';
    const promptHeadings = [...quickStart.matchAll(/^### (minimal|core|full)(?:\s|\uff08|$)/gmu)]
      .map((match) => match[1]);
    assert.deepEqual(promptHeadings, ['minimal', 'core', 'full']);
    assert.doesNotMatch(quickStart, /^### docs-only/gmu);

    const minimal = quickStart.match(/^### minimal\s+ {4}([^\n]+)/mu)?.[1] ?? '';
    const core = quickStart.match(/^### core[^\n]*\s+ {4}([^\n]+)/mu)?.[1] ?? '';
    const full = quickStart.match(/^### full\s+ {4}([^\n]+)/mu)?.[1] ?? '';
    assert.doesNotMatch(minimal, /codebase-memory-mcp/u);
    for (const prompt of [core, full]) {
      assert.match(prompt, /--plugin codebase-memory-mcp/u);
      assert.match(prompt, /--confirm-red-zone/u);
      assert.match(prompt, /provision --write/u);
      assert.match(prompt, /auto_index/u);
      assert.match(prompt, /auto_watch/u);
      assert.match(prompt, /codebaseMemoryMcp/u);
      assert.match(prompt, /ready/u);
      assert.match(prompt, /doctor --project/u);
    }
  }
});

test('canonical rules live only under docs/rules', async () => {
  assert.deepEqual(await validateCanonicalRuleLayout(rootDir), []);
  assert.equal((await readFile(path.join(rootDir, 'docs/rules/project-specific-rules.md'), 'utf8')).includes('{{projectProfile.stackSummary}}'), true);
});

test('schema parity holds for the governed repository', async () => {
  const errors = await validateSchemaParity(rootDir);
  assert.deepEqual(errors, [], JSON.stringify(errors, null, 2));
});

test('canonical rules layout rejects a legacy root rules directory', async () => {
  const tmp = await mkdtemp(path.join(import.meta.dirname, 'tmp-rules-layout-'));
  try {
    await mkdir(path.join(tmp, 'rules'), { recursive: true });
    await mkdir(path.join(tmp, 'docs/rules'), { recursive: true });
    assert.deepEqual(await validateCanonicalRuleLayout(tmp), ['legacy rules/ directory must be removed; use docs/rules/']);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('canonical rules keep lowercase file names aligned with rule ids', async () => {
  const tmp = await mkdtemp(path.join(import.meta.dirname, 'tmp-rules-naming-'));
  try {
    await mkdir(path.join(tmp, 'docs/rules'), { recursive: true });
    await mkdir(path.join(tmp, 'manifests'), { recursive: true });
    await writeFile(path.join(tmp, 'docs/rules/AGENT_SKILL_ROUTING.md'), '# Legacy name\n', 'utf8');
    await writeFile(path.join(tmp, 'docs/rules/legacy-name.md'), '# Rule\n', 'utf8');
    await writeFile(
      path.join(tmp, 'manifests/rules.json'),
      JSON.stringify({ schemaVersion: 1, items: [{ id: 'renamed', source: 'docs/rules/legacy-name.md' }] }),
      'utf8',
    );

    const errors = await validateCanonicalRuleLayout(tmp);
    assert.ok(errors.includes('docs/rules/AGENT_SKILL_ROUTING.md must use lowercase kebab-case'));
    assert.ok(errors.includes('renamed rule id must match its file name: docs/rules/legacy-name.md'));
    assert.ok(errors.includes('docs/rules/AGENT_SKILL_ROUTING.md is missing from manifests/rules.json'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('schema parity reports drift between paired schema files', async () => {
  const tmp = await mkdtemp(path.join(import.meta.dirname, 'tmp-schema-parity-'));
  try {
    await mkdir(path.join(tmp, 'schemas'), { recursive: true });
    await mkdir(path.join(tmp, 'docs/schemas'), { recursive: true });
    await writeFile(path.join(tmp, 'schemas', 'eval-suite.schema.json'), '{"$schema":"x"}\n', 'utf8');
    await writeFile(path.join(tmp, 'docs/schemas', 'eval-suite.schema.json'), '{"$schema":"y"}\n', 'utf8');
    const errors = await validateSchemaParity(tmp);
    assert.deepEqual(errors, ['docs/schemas/eval-suite.schema.json drifted from schemas/eval-suite.schema.json']);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('schema parity errors for docs schema without source counterpart', async () => {
  const tmp = await mkdtemp(path.join(import.meta.dirname, 'tmp-schema-orphan-'));
  try {
    await mkdir(path.join(tmp, 'schemas'), { recursive: true });
    await mkdir(path.join(tmp, 'docs/schemas'), { recursive: true });
    await writeFile(path.join(tmp, 'docs/schemas', 'orphan.schema.json'), '{}\n', 'utf8');
    const errors = await validateSchemaParity(tmp);
    assert.deepEqual(errors, ['docs/schemas/orphan.schema.json has no schemas/ source counterpart']);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
