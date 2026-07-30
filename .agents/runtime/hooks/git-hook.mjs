#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { DEFAULT_RED_ZONE_PATHS, findProjectRoot, readHookSettings, readProjectConfig } from './lib/context.mjs';
import { redZoneMatcher } from './lib/policy.mjs';

const execFileAsync = promisify(execFile);
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\b(?:OPENAI|ANTHROPIC|GITHUB|GEMINI)_[A-Z0-9_]*(?:KEY|TOKEN|SECRET)\s*=\s*[^\s"']{8,}/iu,
  /\bsk-[A-Za-z0-9_-]{16,}\b/u,
];
const forbiddenPathPattern = /^(?:node_modules|\.cognis\/backups)\//u;
// Residual focused/disabled test markers that silently skew the suite. We match
// the method-call form only (test.only/skip), so legitimate option objects
// ({ skip: ... }) and runtime context skips (t.skip/context.skip) pass through.
const focusedTestPattern = /\b(?:test|it|describe)\.only\s*\(/u;
const skippedTestPattern = /\b(?:test|it|describe)\.skip\s*\(/u;

export function scanStagedDiff(diff, { redZonePaths = DEFAULT_RED_ZONE_PATHS } = {}) {
  const added = diff.split(/\r?\n/u).filter((line) => line.startsWith('+') && !line.startsWith('+++'));
  if (secretPatterns.some((pattern) => added.some((line) => pattern.test(line)))) {
    throw new Error('Possible secret found in staged content. Remove it and rotate any exposed credential.');
  }
  const files = [...diff.matchAll(/^\+\+\+ b\/(.+)$/gmu)].map((match) => match[1]);
  const forbidden = files.find((file) => forbiddenPathPattern.test(file));
  if (forbidden) throw new Error(`Forbidden generated or backup path is staged: ${forbidden}`);
  const redZonePattern = redZoneMatcher(redZonePaths);
  if (redZonePattern) {
    const redZoneHit = files.find((file) => redZonePattern.test(file));
    if (redZoneHit) throw new Error(`Red-zone path is staged and requires explicit approval: ${redZoneHit}`);
  }
  const testFiles = files.filter((file) => /\.test\.m?js$/u.test(file));
  if (testFiles.length > 0) {
    const testLines = added.filter((line) => focusedTestPattern.test(line) || skippedTestPattern.test(line));
    if (testLines.length > 0) {
      throw new Error(
        `Focused or skipped test marker staged in ${testFiles.join(', ')}: ${testLines[0].slice(1).trim()}. Remove .only/.skip before committing.`,
      );
    }
  }
}

async function preCommit(rootDir) {
  await execFileAsync('git', ['diff', '--cached', '--check'], { cwd: rootDir, windowsHide: true });
  const { stdout } = await execFileAsync('git', ['diff', '--cached', '--no-ext-diff', '--unified=0', '--', '.'], {
    cwd: rootDir,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  const settings = await readHookSettings(rootDir);
  scanStagedDiff(stdout, { redZonePaths: settings.redZonePaths });
}

// Reject shell metacharacters so a compromised cognis.config.json cannot inject
// commands through validationCommands. We additionally tokenize and spawn with
// shell:false so even a missed metacharacter cannot reach a shell interpreter.
const shellMetacharacters = /[;|&`$()<>\\\n\r]/u;

function splitCommand(command) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|([^\s]+)/gu;
  for (const match of command.matchAll(pattern)) tokens.push(match[1] ?? match[2] ?? match[3]);
  if (tokens.length === 0) throw new Error('Validation command is empty.');
  return tokens;
}

// Resolve the executable spawn can launch under shell:false. On Windows
// npm/pnpm/yarn are .cmd shims that cannot be spawned directly (EINVAL), so we
// route them through cmd.exe; node resolves to the running executable so tests
// are not coupled to a PATH lookup. Returns the command plus any leading args
// that must precede the user-supplied arguments.
function resolveExecutable(program) {
  if (program === 'node') return { command: process.execPath, preArgs: [] };
  if (process.platform === 'win32' && ['pnpm', 'npm', 'yarn'].includes(program)) {
    return { command: 'cmd.exe', preArgs: ['/c', `${program}.cmd`] };
  }
  return { command: program, preArgs: [] };
}

function runCommand(command, cwd, { timeout = 120000, stdio = 'inherit' } = {}) {
  return new Promise((resolve, reject) => {
    if (shellMetacharacters.test(command)) {
      reject(new Error(`Validation command contains shell metacharacters and cannot be run safely: ${command}`));
      return;
    }
    const tokens = splitCommand(command);
    const [program, ...args] = tokens;
    const { command: exec, preArgs } = resolveExecutable(program);
    const child = spawn(exec, [...preArgs, ...args], { cwd, shell: false, stdio, windowsHide: true });
    let settled = false;
    let timedOut = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      // On Windows TerminateProcess is async; wait for the streams to close so
      // file handles in cwd are released before the caller cleans up the dir.
      child.once('close', () => finish(reject, new Error(`Validation command timed out: ${command}`)));
    }, timeout);
    timer.unref();
    child.on('error', (error) => finish(reject, error));
    child.on('exit', (code) => {
      // A kill from the timeout path surfaces here with code null; defer to the
      // close handler so the caller sees "timed out" rather than "exit null".
      if (timedOut) return;
      if (code === 0) finish(resolve);
      else finish(reject, new Error(`Validation command failed with exit ${code}: ${command}`));
    });
  });
}

async function prePush(rootDir) {
  let config;
  try {
    config = await readProjectConfig(rootDir);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    config = {};
  }
  const commands = ['lint', 'typecheck', 'test']
    .map((name) => config.validationCommands?.[name])
    .filter((command) => typeof command === 'string' && command.trim().length > 0);
  for (const command of commands) await runCommand(command, rootDir);
}

// Run the hook only when invoked directly as `node git-hook.mjs <hook>`, not when
// imported (e.g. by tests exercising the pure scanStagedDiff export).
const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const hook = process.argv[2];
  try {
    const rootDir = await findProjectRoot(process.cwd());
    if (hook === 'pre-commit') await preCommit(rootDir);
    else if (hook === 'pre-push') await prePush(rootDir);
    else throw new Error(`Unknown Git hook: ${String(hook)}`);
  } catch (error) {
    process.stderr.write(`Cognis ${hook ?? 'git-hook'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

export { resolveExecutable, runCommand };
