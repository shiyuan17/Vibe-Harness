import './helpers/offline-tools.js';

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '..');
const cliPath = path.join(rootDir, 'scripts/vibe-harness.js');

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
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-output-'));
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
    const doctor = await run(['doctor', '--project', target, '--profile', 'core']);
    assert.equal(Buffer.byteLength(doctor.stdout) < 20 * 1024, true);
    const doctorReport = JSON.parse(doctor.stdout);
    assert.equal(Object.hasOwn(doctorReport.target, 'expected'), false);
    assert.equal(Object.hasOwn(doctorReport.target, 'same'), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('validate and command errors use the shared health contract', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-output-invalid-'));
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

test('legacy CLI options and profile names are rejected with migration guidance', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-legacy-rejected-'));
  try {
    await run(['init', '--project', target]);

    for (const args of [
      ['install', '--project', target, '--apply'],
      ['install', '--target', target, '--profile', 'full', '--dry-run'],
      ['install', '--project', target, '--target', 'codex', '--profile', 'codex-internal', '--dry-run'],
      ['doctor', '--project', target, '--profile', 'codex-minimal'],
      ['diff', '--project', target, '--profile', 'codex-internal'],
      ['doctor', '--project', target, '--target', target],
    ]) {
      const result = await fail(args);
      assert.equal(result.code, 1);
      assert.match(result.report.error.message, /--project[\s\S]*--write|legacy[\s\S]*removed|profile[\s\S]*removed|--target[\s\S]*adapter/iu);
    }
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('project commands reject adapter targets that conflict with project state', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-target-mismatch-'));
  try {
    await run(['init', '--project', target, '--target', 'codex']);

    for (const command of ['validate', 'verify', 'doctor', 'diff']) {
      const result = await fail([command, '--project', target, '--target', 'claude']);
      assert.match(result.report.error.message, /target claude is not configured or installed/iu);
    }

    await run(['install', '--project', target, '--target', 'codex', '--profile', 'core', '--write']);
    const rollback = await fail(['rollback', '--project', target, '--target', 'claude']);
    assert.match(rollback.report.error.message, /target claude is not present in installed targets: codex/iu);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('init and upgrade normalize legacy install state to a canonical profile', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-legacy-state-'));
  try {
    await mkdir(path.join(target, '.vibe-harness'), { recursive: true });
    await writeFile(path.join(target, '.vibe-harness/install-state.json'), `${JSON.stringify({
      adapter: 'codex',
      files: [],
      generatedDirectories: [],
      profile: 'codex-internal',
      stateVersion: 2,
      version: '0.3.0',
    }, null, 2)}\n`, 'utf8');

    await run(['init', '--project', target]);
    const config = JSON.parse(await readFile(path.join(target, 'vibe-harness.config.json'), 'utf8'));
    assert.equal(config.profile, 'full');

    await run([
      'install', '--project', target, '--target', 'codex', '--profile', 'full', '--upgrade', '--write',
      '--confirm-red-zone', '--allow-degraded',
    ]);
    const state = JSON.parse(await readFile(path.join(target, '.vibe-harness/install-state.json'), 'utf8'));
    assert.equal(state.profile, 'full');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
