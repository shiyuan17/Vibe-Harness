import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkTestEnumeration } from '../scripts/lib/test-enumeration.js';

const rootDir = path.resolve(import.meta.dirname, '..');

test('test enumeration covers every on-disk test file exactly once', async () => {
  const report = await checkTestEnumeration(rootDir);
  assert.deepEqual(report.findings, []);
  assert.equal(report.status, 'clean');
  assert.equal(report.counts.onDisk, report.counts.registered);
  assert.equal(report.counts.scripts, 3);
});

test('test enumeration reports an unregistered test file', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-test-enum-'));
  try {
    await setupFixture(target, {
      scripts: {
        'test:unit': 'node --test tests/registered.test.js',
        'test:eval': 'node --test tests/other.test.js',
        'test:integration': 'node --test',
      },
      testFiles: ['other.test.js', 'registered.test.js', 'forgotten.test.js'],
    });
    const report = await checkTestEnumeration(target);
    assert.equal(report.status, 'drift');
    assert.deepEqual(report.findings.map((finding) => finding.kind), ['unregistered-test-file']);
    assert.equal(report.findings[0].file, 'tests/forgotten.test.js');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('test enumeration reports stale and duplicate registrations', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-test-enum-'));
  try {
    await setupFixture(target, {
      scripts: {
        'test:unit': 'node --test tests/shared.test.js',
        'test:eval': 'node --test tests/shared.test.js tests/removed.test.js',
        'test:integration': 'node --test tests/present.test.js',
      },
      testFiles: ['present.test.js', 'shared.test.js'],
    });
    const report = await checkTestEnumeration(target);
    assert.deepEqual(
      report.findings.map((finding) => finding.kind).sort(),
      ['duplicate-registration', 'stale-test-registration'],
    );
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('test enumeration reports a missing test script', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-test-enum-'));
  try {
    await setupFixture(target, {
      scripts: { 'test:unit': 'node --test tests/registered.test.js' },
      testFiles: ['registered.test.js'],
      dropScripts: ['test:eval', 'test:integration'],
    });
    const report = await checkTestEnumeration(target);
    assert.deepEqual(
      report.findings.map((finding) => finding.kind).sort(),
      ['missing-test-script', 'missing-test-script'],
    );
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

async function setupFixture(target, { scripts, testFiles, dropScripts = [] }) {
  await mkdir(path.join(target, 'tests'), { recursive: true });
  const packageJson = { scripts: Object.fromEntries(Object.entries(scripts).filter(([key]) => !dropScripts.includes(key))) };
  await writeFile(path.join(target, 'package.json'), JSON.stringify(packageJson), 'utf8');
  for (const file of testFiles) {
    await writeFile(path.join(target, 'tests', file), 'import test from "node:test";\n', 'utf8');
  }
}
