import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve('.');
const cliPath = path.join(rootDir, 'scripts', 'cognis.js');

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

test('commands reject an unsupported LoopEngine project without writing Cognis state', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-legacy-unsupported-'));
  try {
    await writeFile(path.join(target, 'loopengine.config.json'), '{}\n', 'utf8');

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'init', '--project', target]),
      (error) => /COGNIS_LEGACY_UNSUPPORTED/u.test(String(error.stderr)),
    );
    assert.equal(await exists(path.join(target, 'cognis.config.json')), false);
    assert.equal(await exists(path.join(target, '.cognis', 'install-state.json')), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
