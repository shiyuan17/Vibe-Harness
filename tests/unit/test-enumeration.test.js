import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkTestEnumeration } from '../../scripts/lib/test-enumeration.js';

const rootDir = path.resolve(import.meta.dirname, '../..');
const idleLayers = {
  'test:unit': 'node --test',
  'test:component': 'node --test',
  'test:integration': 'node --test',
  'test:e2e': 'node --test',
  'test:matrix': 'node --test',
};

test('测试枚举覆盖每个磁盘测试文件且层级与脚本一一对应', async () => {
  const report = await checkTestEnumeration(rootDir);
  assert.deepEqual(report.findings, []);
  assert.equal(report.status, 'clean');
  assert.equal(report.counts.onDisk, report.counts.registered);
  assert.equal(report.counts.scripts, 5);
  assert.equal(report.counts.stray, 0);
});

test('测试枚举报告未登记的测试文件', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-test-enum-'));
  try {
    await setupFixture(target, {
      scripts: { ...idleLayers, 'test:unit': 'node --test tests/unit/registered.test.js' },
      testFiles: ['tests/unit/forgotten.test.js', 'tests/unit/registered.test.js'],
    });
    const report = await checkTestEnumeration(target);
    assert.equal(report.status, 'drift');
    assert.deepEqual(report.findings.map((finding) => finding.kind), ['unregistered-test-file']);
    assert.equal(report.findings[0].file, 'tests/unit/forgotten.test.js');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('测试枚举报告层级与登记脚本不一致的文件', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-test-enum-'));
  try {
    await setupFixture(target, {
      scripts: { ...idleLayers, 'test:integration': 'node --test tests/e2e/wrong-layer.test.js' },
      testFiles: ['tests/e2e/wrong-layer.test.js'],
    });
    const report = await checkTestEnumeration(target);
    assert.deepEqual(report.findings.map((finding) => finding.kind), ['layer-mismatch']);
    assert.equal(report.findings[0].expectedLayer, 'integration');
    assert.equal(report.findings[0].actualLayer, 'e2e');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('测试枚举报告落在层目录之外的测试文件', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-test-enum-'));
  try {
    await setupFixture(target, { scripts: idleLayers, testFiles: ['tests/loose.test.js'] });
    const report = await checkTestEnumeration(target);
    assert.deepEqual(report.findings.map((finding) => finding.kind), ['stray-test-file']);
    assert.equal(report.counts.stray, 1);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('测试枚举报告陈旧登记与重复登记', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-test-enum-'));
  try {
    await setupFixture(target, {
      scripts: {
        ...idleLayers,
        'test:component': 'node --test tests/unit/shared.test.js',
        'test:e2e': 'node --test tests/e2e/present.test.js',
        'test:integration': 'node --test tests/integration/removed.test.js',
        'test:unit': 'node --test tests/unit/shared.test.js',
      },
      testFiles: ['tests/e2e/present.test.js', 'tests/unit/shared.test.js'],
    });
    const report = await checkTestEnumeration(target);
    // Registering one file under two layer scripts is both a duplicate
    // registration and a layer mismatch, so both findings must be reported.
    assert.deepEqual(
      report.findings.map((finding) => finding.kind).sort(),
      ['duplicate-registration', 'layer-mismatch', 'stale-test-registration'],
    );
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('测试枚举报告缺失的层级脚本', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-test-enum-'));
  try {
    await setupFixture(target, {
      scripts: { 'test:unit': 'node --test tests/unit/registered.test.js' },
      testFiles: ['tests/unit/registered.test.js'],
    });
    const report = await checkTestEnumeration(target);
    assert.equal(report.findings.filter((finding) => finding.kind === 'missing-test-script').length, 4);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

async function setupFixture(target, { scripts, testFiles }) {
  await writeFile(path.join(target, 'package.json'), JSON.stringify({ scripts }), 'utf8');
  for (const file of testFiles) {
    const absolute = path.join(target, file);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, 'import test from "node:test";\n', 'utf8');
  }
}
