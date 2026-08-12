#!/usr/bin/env node
import path from 'node:path';

import { validatePackageFiles } from './lib/pack-contract.js';
import { execFileAsync, npmInvocation } from './lib/tool-provisioning/subprocess.js';

const rootDir = path.resolve('.');
async function runPack(args) {
  const invocation = await npmInvocation(args);
  return execFileAsync(invocation.command, invocation.args, {
    cwd: rootDir,
    maxBuffer: 1024 * 1024 * 8,
    windowsHide: true,
  });
}

async function runPnpmPack() {
  const windows = process.platform === 'win32';
  const command = windows ? process.env.ComSpec ?? 'cmd.exe' : 'pnpm';
  const args = windows ? ['/d', '/s', '/c', 'pnpm.cmd pack --dry-run --json'] : ['pack', '--dry-run', '--json'];
  return execFileAsync(command, args, {
    cwd: rootDir,
    env: { ...process.env, npm_config_ignore_scripts: 'true' },
    maxBuffer: 1024 * 1024 * 8,
    windowsHide: true,
  });
}

function parsePackOutput(value) {
  const objectIndex = value.indexOf('{');
  const arrayIndex = value.indexOf('[');
  const indexes = [objectIndex, arrayIndex].filter((index) => index >= 0);
  if (indexes.length === 0) throw new Error('pack command did not return JSON');
  return JSON.parse(value.slice(Math.min(...indexes)));
}

let result;
try {
  try {
    result = await runPack(['pack', '--dry-run', '--json', '--ignore-scripts']);
  } catch {
    result = await runPnpmPack();
  }
  const payload = parsePackOutput(result.stdout);
  const pack = Array.isArray(payload) ? payload[0] : payload;
  const report = validatePackageFiles(pack?.files ?? []);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
