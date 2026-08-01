import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  validateDocumentation,
  validateReadmeParity,
  validateRulesParity,
  validateSchemaParity,
} from '../scripts/lib/docs-validation.js';

const rootDir = path.resolve(import.meta.dirname, '..');

test('documentation catalog covers current and archived Markdown', async () => {
  const report = await validateDocumentation({ rootDir });
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
});

test('English and Chinese README expose the same commands and configuration', async () => {
  const [english, chinese] = await Promise.all([
    readFile(path.join(rootDir, 'README.md'), 'utf8'),
    readFile(path.join(rootDir, 'README.zh-CN.md'), 'utf8'),
  ]);
  assert.deepEqual(validateReadmeParity(english, chinese), []);
});

test('rules parity holds for the governed repository', async () => {
  const { errors, warnings } = await validateRulesParity(rootDir);
  // Rules-only tool files are expected (warned, not errored).
  assert.deepEqual(errors, [], JSON.stringify({ errors, warnings }, null, 2));
  assert.ok(
    warnings.length > 0,
    'rules-only files should be surfaced as warnings in the governed repo',
  );
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
