import './helpers/offline-tools.js';

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve('.');
const cliPath = path.join(rootDir, 'scripts/loopengine.js');

async function run(args) {
  return execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: rootDir,
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function fail(args) {
  try {
    await run(args);
  } catch (error) {
    return { code: error.code, report: JSON.parse(error.stderr) };
  }
  assert.fail('Expected command to fail');
}

test('default dry-run is compact while verbose retains rendered content', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-output-'));
  try {
    await run(['init', '--project', target]);
    const compact = await run(['install', '--project', target, '--target', 'codex', '--profile', 'core', '--dry-run']);
    const compactReport = JSON.parse(compact.stdout);

    assert.equal(Buffer.byteLength(compact.stdout) < 15 * 1024, true);
    assert.equal(compactReport.previewFiles.some((file) => Object.hasOwn(file, 'content')), false);
    assert.equal(compactReport.actions.some((action) => Object.hasOwn(action, 'source') || Object.hasOwn(action, 'target')), false);

    const verbose = await run(['install', '--project', target, '--target', 'codex', '--profile', 'core', '--dry-run', '--verbose']);
    const verboseReport = JSON.parse(verbose.stdout);
    assert.equal(verboseReport.previewFiles.some((file) => typeof file.content === 'string'), true);
    assert.equal(verboseReport.actions.some((action) => typeof action.source === 'string'), true);

    const summary = await run(['install', '--project', target, '--target', 'codex', '--profile', 'core', '--dry-run', '--output', 'summary']);
    assert.match(summary.stdout, /status: ready/u);
    assert.match(summary.stdout, /profile: core/u);
    assert.doesNotMatch(summary.stdout, /^\s*\{/u);

    await run(['install', '--project', target, '--target', 'codex', '--profile', 'core', '--write']);
    const doctor = await run(['doctor', '--target', target, '--profile', 'core']);
    assert.equal(Buffer.byteLength(doctor.stdout) < 20 * 1024, true);
    const doctorReport = JSON.parse(doctor.stdout);
    assert.equal(Object.hasOwn(doctorReport.target, 'expected'), false);
    assert.equal(Object.hasOwn(doctorReport.target, 'same'), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('validate and command errors use the shared health contract', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-output-invalid-'));
  try {
    const missingConfig = await fail(['validate', '--project', target]);
    assert.equal(missingConfig.code, 1);
    assert.equal(missingConfig.report.ok, false);
    assert.equal(missingConfig.report.status, 'invalid');
    assert.deepEqual(missingConfig.report.warnings, []);
    assert.equal(Array.isArray(missingConfig.report.recommendations), true);

    const pack = JSON.parse((await run(['validate'])).stdout);
    assert.equal(pack.status, 'ready');
    assert.equal(pack.ok, true);
    assert.deepEqual(pack.warnings, []);
    assert.deepEqual(pack.recommendations, []);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
