import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '..');
const vibeHarnessCli = path.join(rootDir, 'scripts/vibe-harness.js');

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

test('Vibe-Harness CLI initializes only the canonical configuration', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-cli-init-'));
  try {
  const result = await execFileAsync(process.execPath, [vibeHarnessCli, 'init', '--project', target]);
    const report = JSON.parse(result.stdout);
    assert.equal(report.path, path.join(target, 'vibe-harness.config.json'));
    const config = JSON.parse(await readFile(report.path, 'utf8'));
    assert.equal(Object.hasOwn(config, 'governance'), false);
    assert.deepEqual(config.validationCommands, { lint: null, typecheck: null, test: null, eval: null });
    assert.equal(await exists(path.join(target, '.loopengine')), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('Vibe-Harness CLI rejects legacy projects before dry-run or write', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-cli-legacy-'));
  try {
    await writeFile(path.join(target, 'loopengine.config.json'), '{}\n', 'utf8');
    for (const args of [
      ['init', '--project', target],
      ['install', '--project', target, '--target', 'codex', '--profile', 'core', '--dry-run'],
    ]) {
      await assert.rejects(
      execFileAsync(process.execPath, [vibeHarnessCli, ...args]),
        (error) => JSON.parse(error.stderr).error?.code === 'VIBE_HARNESS_LEGACY_UNSUPPORTED',
      );
    }
    assert.equal(await exists(path.join(target, 'vibe-harness.config.json')), false);
    assert.equal(await exists(path.join(target, '.vibe-harness')), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
