import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { removeTemporaryDirectory } from '../../scripts/lib/temp-cleanup.js';
import { runCommand } from '../../runtime/commands/run.mjs';

// `slice` and `patch` replace the inline `node -e` snippets and one-off scripts
// an Agent used to write into a project. Both stay read-only unless `--write`
// is passed, and `patch` only writes after every guard passed in memory.

async function tempProject() {
  return mkdtemp(path.join(tmpdir(), 'vibe-harness-file-edit-'));
}

async function writeSpec(project, spec, name = 'spec.json') {
  await writeFile(path.join(project, name), `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
  return path.join(project, name);
}

async function writeFragment(project, text, name = 'fragment.txt') {
  await writeFile(path.join(project, name), text, 'utf8');
  return name;
}

test('slice prints a numbered range and can drop the numbers', async () => {
  const project = await tempProject();
  try {
    await writeFile(path.join(project, 'sample.txt'), 'alpha\nbeta\ngamma\ndelta\n', 'utf8');

    const numbered = await runCommand(['slice', '--project', '.', '--file', 'sample.txt', '--from', '2', '--to', '3', '--json'], { cwd: project });
    assert.equal(numbered.exitCode, 0);
    assert.equal(numbered.report.status, 'ready');
    assert.deepEqual(numbered.report.lines, ['2 | beta', '3 | gamma']);
    assert.equal(numbered.report.eol, 'lf');
    assert.equal(numbered.report.totalLines, 4);

    // Without --to the range runs to the end of the file.
    const openEnded = await runCommand(['slice', '--project', '.', '--file', 'sample.txt', '--from', '3'], { cwd: project });
    assert.deepEqual(openEnded.report.lines, ['3 | gamma', '4 | delta']);

    const bare = await runCommand(['slice', '--project', '.', '--file', 'sample.txt', '--from', '2', '--to', '2', '--no-numbers', '--json'], { cwd: project });
    assert.equal(bare.report.numbered, false);
    assert.deepEqual(bare.report.lines, ['beta']);

    const outside = await runCommand(['slice', '--project', '.', '--file', 'sample.txt', '--from', '9', '--json'], { cwd: project });
    assert.equal(outside.exitCode, 1);
    assert.equal(outside.report.status, 'failed');

    const missing = await runCommand(['slice', '--project', '.', '--file', 'absent.txt', '--json'], { cwd: project });
    assert.equal(missing.exitCode, 1);
  } finally {
    await removeTemporaryDirectory(project);
  }
});

test('patch applies a guarded range and a unique sequence in memory', async () => {
  const project = await tempProject();
  const target = path.join(project, 'sample.txt');
  try {
    await writeFile(target, 'alpha\nbeta\ngamma\ndelta\neps\n', 'utf8');
    await writeFragment(project, 'GAMMA2\nDELTA2\n');
    await writeSpec(project, {
      file: 'sample.txt',
      ops: [
        // Range ops are ordered from the highest start line down, so the
        // earlier replacement cannot shift the later range.
        { endLine: 4, expectEnd: 'delta', expectStart: 'gamma', kind: 'range', replaceFrom: 'fragment.txt', startLine: 3 },
        { kind: 'sequence', match: ['eps'], replace: ['EPSILON'] },
      ],
    });

    const dryRun = await runCommand(['patch', '--project', '.', '--spec', 'spec.json', '--json'], { cwd: project });
    assert.equal(dryRun.exitCode, 0);
    assert.equal(dryRun.report.status, 'planned');
    assert.equal(dryRun.report.dryRun, true);
    assert.equal(dryRun.report.written, false);
    assert.equal(await readFile(target, 'utf8'), 'alpha\nbeta\ngamma\ndelta\neps\n');

    const written = await runCommand(['patch', '--project', '.', '--spec', 'spec.json', '--write', '--json'], { cwd: project });
    assert.equal(written.exitCode, 0);
    assert.equal(written.report.status, 'passed');
    assert.equal(written.report.written, true);
    assert.equal(written.report.ops.length, 2);
    assert.equal(await readFile(target, 'utf8'), 'alpha\nbeta\nGAMMA2\nDELTA2\nEPSILON\n');
  } finally {
    await removeTemporaryDirectory(project);
  }
});

test('patch aborts the whole spec when a guard or a match fails', async () => {
  const project = await tempProject();
  const target = path.join(project, 'sample.txt');
  const original = 'alpha\nbeta\ngamma\n';
  try {
    await writeFile(target, original, 'utf8');
    await writeFragment(project, 'BETA2\n');

    // A start-line guard that does not match must stop the run before writing.
    await writeSpec(project, {
      file: 'sample.txt',
      ops: [{ endLine: 2, expectEnd: 'beta', expectStart: 'not-beta', kind: 'range', replaceFrom: 'fragment.txt', startLine: 2 }],
    });
    const guard = await runCommand(['patch', '--project', '.', '--spec', 'spec.json', '--write', '--json'], { cwd: project });
    assert.equal(guard.exitCode, 1);
    assert.equal(guard.report.status, 'failed');
    assert.equal(guard.report.code, 'PATCH_GUARD_FAILED');
    assert.equal(guard.report.written, false);
    assert.equal(await readFile(target, 'utf8'), original);

    // An out-of-file range is rejected as well.
    await writeSpec(project, {
      file: 'sample.txt',
      ops: [{ endLine: 900, expectEnd: 'x', expectStart: 'x', kind: 'range', replaceFrom: 'fragment.txt', startLine: 899 }],
    });
    const bounds = await runCommand(['patch', '--project', '.', '--spec', 'spec.json', '--write', '--json'], { cwd: project });
    assert.equal(bounds.report.code, 'PATCH_RANGE_OUT_OF_BOUNDS');
    assert.equal(await readFile(target, 'utf8'), original);

    // A sequence that matches zero or several times is ambiguous, so the whole
    // spec is rejected instead of guessing one of the sites.
    await writeSpec(project, { file: 'sample.txt', ops: [{ kind: 'sequence', match: ['absent'], replace: ['x'] }] });
    const absent = await runCommand(['patch', '--project', '.', '--spec', 'spec.json', '--write', '--json'], { cwd: project });
    assert.equal(absent.report.code, 'PATCH_MATCH_NOT_UNIQUE');

    await writeFile(target, 'dup\ndup\n', 'utf8');
    await writeSpec(project, { file: 'sample.txt', ops: [{ kind: 'sequence', match: ['dup'], replace: ['x'] }] });
    const duplicated = await runCommand(['patch', '--project', '.', '--spec', 'spec.json', '--write', '--json'], { cwd: project });
    assert.equal(duplicated.report.code, 'PATCH_MATCH_NOT_UNIQUE');
    assert.equal(await readFile(target, 'utf8'), 'dup\ndup\n');
  } finally {
    await removeTemporaryDirectory(project);
  }
});

test('patch keeps the file line endings and rejects a malformed spec', async () => {
  const project = await tempProject();
  const target = path.join(project, 'crlf.txt');
  try {
    await writeFile(target, 'alpha\r\nbeta\r\n', 'utf8');
    await writeFragment(project, 'BETA2\n');
    await writeSpec(project, {
      file: 'crlf.txt',
      ops: [{ endLine: 2, expectEnd: 'beta', expectStart: 'beta', kind: 'range', replaceFrom: 'fragment.txt', startLine: 2 }],
    });

    const result = await runCommand(['patch', '--project', '.', '--spec', 'spec.json', '--write', '--json'], { cwd: project });
    assert.equal(result.report.status, 'passed');
    assert.equal(result.report.eol, 'crlf');
    assert.equal(await readFile(target, 'utf8'), 'alpha\r\nBETA2\r\n');

    await writeSpec(project, { file: 'crlf.txt' });
    const malformed = await runCommand(['patch', '--project', '.', '--spec', 'spec.json', '--json'], { cwd: project });
    assert.equal(malformed.exitCode, 1);
    assert.match(malformed.report.error, /"file"/u);

    const absent = await runCommand(['patch', '--project', '.', '--spec', 'absent.json', '--json'], { cwd: project });
    assert.equal(absent.exitCode, 1);
    assert.equal(absent.report.status, 'failed');
  } finally {
    await removeTemporaryDirectory(project);
  }
});
