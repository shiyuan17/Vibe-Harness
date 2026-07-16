#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { removeTemporaryDirectory } from './lib/temp-cleanup.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(rootDir, 'scripts/loopengine.js');

async function run(step, args) {
  console.error(`smoke: ${step}`);
  await execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: rootDir,
    env: { ...process.env, LOOPENGINE_TOOL_TIMEOUT_MS: '10000' },
    maxBuffer: 1024 * 1024 * 8,
    timeout: 180_000,
    windowsHide: true,
  });
  return { exitCode: 0, step };
}

async function runInstalledEval(step, project) {
  console.error(`smoke: ${step}`);
  await execFileAsync(process.execPath, [
    path.join(project, '.agents/loopengine/evals/run.mjs'),
    '--project', project,
    '--suite', '.agents/evals/suites/loopengine-core.json',
    '--reference', '.agents/evals/references/loopengine-core.offline.json',
  ], {
    cwd: project,
    maxBuffer: 1024 * 1024 * 8,
    timeout: 180_000,
    windowsHide: true,
  });
  return { exitCode: 0, step };
}

const core = await mkdtemp(path.join(tmpdir(), 'loopengine-smoke-core-'));
const full = await mkdtemp(path.join(tmpdir(), 'loopengine-smoke-full-'));
const results = [];

try {
  results.push(await run('core-init', ['init', '--project', core]));
  results.push(await run('core-dry-run', ['install', '--project', core, '--target', 'codex', '--profile', 'core', '--dry-run']));
  results.push(await run('core-write', ['install', '--project', core, '--target', 'codex', '--profile', 'core', '--write']));
  results.push(await run('core-validate', ['validate', '--project', core]));
  results.push(await runInstalledEval('core-eval-offline', core));
  results.push(await run('full-init', ['init', '--project', full, '--profile', 'full']));
  results.push(await run('full-dry-run', ['install', '--project', full, '--target', 'codex', '--profile', 'full', '--dry-run']));
  results.push(await run('full-write', ['install', '--project', full, '--target', 'codex', '--profile', 'full', '--write', '--confirm-red-zone', '--allow-degraded']));
  results.push(await run('full-validate', ['validate', '--project', full, '--allow-degraded']));
  results.push(await run('full-doctor', ['doctor', '--project', full, '--allow-degraded']));
  console.log(JSON.stringify({ ok: true, results }, null, 2));
} finally {
  await removeTemporaryDirectory(core);
  await removeTemporaryDirectory(full);
}

