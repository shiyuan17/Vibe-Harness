#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(rootDir, 'scripts/loopengine.js');

async function run(step, args) {
  await execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: rootDir,
    maxBuffer: 1024 * 1024 * 8,
    windowsHide: true,
  });
  return { exitCode: 0, step };
}

const mvp = await mkdtemp(path.join(tmpdir(), 'loopengine-smoke-mvp-'));
const legacy = await mkdtemp(path.join(tmpdir(), 'loopengine-smoke-legacy-'));
const results = [];

try {
  results.push(await run('mvp-init', ['init', '--project', mvp]));
  results.push(await run('mvp-dry-run', ['install', '--project', mvp, '--target', 'codex', '--profile', 'core', '--dry-run']));
  results.push(await run('mvp-write', ['install', '--project', mvp, '--target', 'codex', '--profile', 'core', '--write']));
  results.push(await run('mvp-validate', ['validate', '--project', mvp]));
  results.push(await run('legacy-dry-run', ['install', '--target', legacy, '--profile', 'codex-internal', '--dry-run']));
  results.push(await run('legacy-apply', ['install', '--target', legacy, '--profile', 'codex-internal', '--apply', '--confirm-red-zone']));
  results.push(await run('legacy-validate', ['validate', '--target', legacy, '--profile', 'codex-internal']));
  results.push(await run('legacy-doctor', ['doctor', '--target', legacy]));
  console.log(JSON.stringify({ ok: true, results }, null, 2));
} finally {
  await rm(mvp, { force: true, recursive: true });
  await rm(legacy, { force: true, recursive: true });
}

