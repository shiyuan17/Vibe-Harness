import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '..');
const cliPath = path.join(rootDir, 'scripts', 'vibe-harness.js');

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

test('commands reject an unsupported Cognis project without writing Vibe-Harness state', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-legacy-unsupported-'));
  try {
    await writeFile(path.join(target, 'cognis.config.json'), '{}\n', 'utf8');

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'init', '--project', target]),
      (error) => /VIBE_HARNESS_LEGACY_UNSUPPORTED/u.test(String(error.stderr)),
    );
    assert.equal(await exists(path.join(target, 'vibe-harness.config.json')), false);
    assert.equal(await exists(path.join(target, '.vibe-harness', 'install-state.json')), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
