import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  collectGovernedPaths,
  validateDocumentation,
  validateLegacyBrandUsage,
  validateReadmeParity,
  validateRulesParity,
  validateSchemaParity,
} from '../scripts/lib/docs-validation.js';

const rootDir = path.resolve(import.meta.dirname, '..');

test('documentation catalog covers current and archived Markdown', async () => {
  const report = await validateDocumentation({ rootDir });
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
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

test('rules parity holds for the governed repository', async () => {
  const { errors, warnings } = await validateRulesParity(rootDir);
  assert.deepEqual(errors, [], JSON.stringify({ errors, warnings }, null, 2));
  assert.deepEqual(warnings, []);
});

test('schema parity holds for the governed repository', async () => {
  const errors = await validateSchemaParity(rootDir);
  assert.deepEqual(errors, [], JSON.stringify(errors, null, 2));
});

test('rules parity reports drift between paired rule files', async () => {
  const tmp = await mkdtemp(path.join(import.meta.dirname, 'tmp-rules-parity-'));
  try {
    await mkdir(path.join(tmp, 'rules'), { recursive: true });
    await mkdir(path.join(tmp, 'docs/rules'), { recursive: true });
    await writeFile(path.join(tmp, 'rules', 'git-rules.md'), '# Git rules\n', 'utf8');
    await writeFile(path.join(tmp, 'docs/rules', 'git-rules.md'), '# Git rules (drifted)\n', 'utf8');
    const { errors, warnings } = await validateRulesParity(tmp);
    assert.deepEqual(warnings, []);
    assert.deepEqual(errors, ['docs/rules/git-rules.md drifted from rules/git-rules.md']);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('rules parity pairs files with different casing and separators', async () => {
  const tmp = await mkdtemp(path.join(import.meta.dirname, 'tmp-rules-case-'));
  try {
    await mkdir(path.join(tmp, 'rules'), { recursive: true });
    await mkdir(path.join(tmp, 'docs/rules'), { recursive: true });
    const body = '# Agent skill routing\n';
    await writeFile(path.join(tmp, 'rules', 'agent-skill-routing.md'), body, 'utf8');
    await writeFile(path.join(tmp, 'docs/rules', 'AGENT_SKILL_ROUTING.md'), body, 'utf8');
    const { errors, warnings } = await validateRulesParity(tmp);
    assert.deepEqual(errors, [], JSON.stringify({ errors, warnings }, null, 2));
    assert.deepEqual(warnings, []);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('rules parity warns for rules-only files and errors for docs-only files', async () => {
  const tmp = await mkdtemp(path.join(import.meta.dirname, 'tmp-rules-only-'));
  try {
    await mkdir(path.join(tmp, 'rules'), { recursive: true });
    await mkdir(path.join(tmp, 'docs/rules'), { recursive: true });
    await writeFile(path.join(tmp, 'rules', 'ast-grep.md'), '# ast-grep\n', 'utf8');
    await writeFile(path.join(tmp, 'docs/rules', 'orphan-rules.md'), '# orphan\n', 'utf8');
    const { errors, warnings } = await validateRulesParity(tmp);
    assert.deepEqual(warnings, ['rules/ast-grep.md has no docs/rules counterpart; consider documenting it']);
    assert.deepEqual(errors, ['docs/rules/orphan-rules.md has no rules/ source counterpart']);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('rules parity excludes project-specific-rules.md from comparison', async () => {
  const tmp = await mkdtemp(path.join(import.meta.dirname, 'tmp-rules-exclude-'));
  try {
    await mkdir(path.join(tmp, 'rules'), { recursive: true });
    await mkdir(path.join(tmp, 'docs/rules'), { recursive: true });
    await writeFile(path.join(tmp, 'rules', 'project-specific-rules.md'), '{{placeholder}}\n', 'utf8');
    await writeFile(path.join(tmp, 'docs/rules', 'project-specific-rules.md'), 'rendered\n', 'utf8');
    const { errors, warnings } = await validateRulesParity(tmp);
    assert.deepEqual(errors, [], JSON.stringify({ errors, warnings }, null, 2));
    assert.deepEqual(warnings, []);
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
