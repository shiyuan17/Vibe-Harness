import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { discoverExecutables } from '../scripts/lib/executable-discovery.js';

const rootDir = path.resolve('.');

test('executable discovery covers runtime and Skill scripts', async () => {
  const files = (await discoverExecutables(rootDir)).map((file) => path.relative(rootDir, file).replaceAll('\\', '/'));
  assert.equal(files.includes('runtime/hooks/lib/policy.mjs'), true);
  assert.equal(files.includes('runtime/evals/codex-runner.mjs'), true);
  assert.equal(files.includes('scripts/cognis.js'), true);
  assert.equal(files.every((file) => /\.(?:cjs|js|mjs)$/u.test(file)), true);
});

test('executable discovery includes cjs and skips dependency directories', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-lint-discovery-'));
  try {
    await mkdir(path.join(target, 'runtime'), { recursive: true });
    await mkdir(path.join(target, 'node_modules', 'package'), { recursive: true });
    await writeFile(path.join(target, 'runtime', 'tool.cjs'), 'module.exports = {};\n', 'utf8');
    await writeFile(path.join(target, 'node_modules', 'package', 'ignored.js'), 'broken(', 'utf8');
    const files = await discoverExecutables(target);
    assert.deepEqual(files.map((file) => path.basename(file)), ['tool.cjs']);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
