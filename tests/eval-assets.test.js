import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalAssetBytes, createEvalAssetFingerprint } from '../scripts/lib/eval-assets.js';

async function makeTree(rootDir, { eol = '\n', binary = [1, 2, 3, 0, 255] } = {}) {
  const withEol = (text) => text.split('\n').join(eol);
  await mkdir(path.join(rootDir, 'schemas'), { recursive: true });
  await mkdir(path.join(rootDir, 'skills', 'demo'), { recursive: true });
  await writeFile(path.join(rootDir, 'schemas/demo.schema.json'), withEol('{\n  "a": 1\n}\n'), 'utf8');
  await writeFile(path.join(rootDir, 'skills/demo/SKILL.md'), withEol('---\nname: demo\n---\n'), 'utf8');
  await writeFile(path.join(rootDir, 'schemas/blob.bin'), Buffer.from(binary));
  return rootDir;
}

async function withTemporaryTree(run) {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'vibe-eval-assets-'));
  try {
    return await run(rootDir);
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
}

test('canonical asset bytes normalize CRLF text and preserve non-text content', () => {
  assert.deepEqual(canonicalAssetBytes(Buffer.from('a\r\nb\r\n', 'utf8')), Buffer.from('a\nb\n', 'utf8'));
  assert.deepEqual(canonicalAssetBytes(Buffer.from('a\nb\n', 'utf8')), Buffer.from('a\nb\n', 'utf8'));
  const binary = Buffer.from([0x61, 0x00, 0x0d, 0x0a]);
  assert.deepEqual(canonicalAssetBytes(binary), binary);
  const invalidUtf8 = Buffer.from([0xff, 0xfe, 0x0d, 0x0a]);
  assert.deepEqual(canonicalAssetBytes(invalidUtf8), invalidUtf8);
});

test('asset fingerprints match across checkout line-ending forms', async () => {
  const lf = await withTemporaryTree(async (rootDir) => createEvalAssetFingerprint(await makeTree(rootDir, { eol: '\n' })));
  const crlf = await withTemporaryTree(async (rootDir) => createEvalAssetFingerprint(await makeTree(rootDir, { eol: '\r\n' })));
  assert.deepEqual(crlf, lf);
});

test('asset fingerprints still drift on a real text content change', async () => {
  const before = await withTemporaryTree(async (rootDir) => createEvalAssetFingerprint(await makeTree(rootDir, { eol: '\n' })));
  const after = await withTemporaryTree(async (rootDir) => {
    await makeTree(rootDir, { eol: '\r\n' });
    await writeFile(path.join(rootDir, 'skills/demo/SKILL.md'), '---\r\nname: demo\r\nextra: 1\r\n---\r\n', 'utf8');
    return createEvalAssetFingerprint(rootDir);
  });
  assert.notEqual(after.groups.skills.hash, before.groups.skills.hash);
  assert.notEqual(after.aggregateHash, before.aggregateHash);
});

test('asset fingerprints stay byte-exact for binary assets', async () => {
  const before = await withTemporaryTree(async (rootDir) => createEvalAssetFingerprint(await makeTree(rootDir, { binary: [1, 2, 3, 0, 255] })));
  const after = await withTemporaryTree(async (rootDir) => createEvalAssetFingerprint(await makeTree(rootDir, { binary: [1, 2, 4, 0, 255] })));
  assert.notEqual(after.groups.config.hash, before.groups.config.hash);
});
