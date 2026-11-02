#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DEFAULT_RED_ZONE_PATHS, findProjectRoot, readHookSettings } from './lib/context.mjs';
import { redZoneMatcher } from './lib/policy.mjs';
import { resolveGitPushTarget } from '../lib/git-delivery-target.mjs';
const execFileAsync = promisify(execFile);
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\b(?:OPENAI|ANTHROPIC|GITHUB|GEMINI)_[A-Z0-9_]*(?:KEY|TOKEN|SECRET)\s*=\s*[^\s"']{8,}/iu,
  /\bsk-[A-Za-z0-9_-]{16,}\b/u,
];
const forbiddenPathPattern = /^(?:node_modules|\.vibe-harness\/backups)\//u;
// Residual focused/disabled test markers that silently skew the suite. We match
// the method-call form only (test.only/skip), so legitimate option objects
// ({ skip: ... }) and runtime context skips (t.skip/context.skip) pass through.
const focusedTestPattern = /\b(?:test|it|describe)\.only\s*\(/u;
const skippedTestPattern = /\b(?:test|it|describe)\.skip\s*\(/u;

export function scanStagedDiff(diff, { redZoneConfirmed = false, redZonePaths = DEFAULT_RED_ZONE_PATHS } = {}) {
  const added = diff.split(/\r?\n/u).filter((line) => line.startsWith('+') && !line.startsWith('+++'));
  if (secretPatterns.some((pattern) => added.some((line) => pattern.test(line)))) {
    throw new Error('Possible secret found in staged content. Remove it and rotate any exposed credential.');
  }
  const files = [...diff.matchAll(/^\+\+\+ b\/(.+)$/gmu)].map((match) => match[1]);
  const forbidden = files.find((file) => forbiddenPathPattern.test(file));
  if (forbidden) throw new Error(`Forbidden generated or backup path is staged: ${forbidden}`);
  const redZonePattern = redZoneMatcher(redZonePaths);
  if (redZonePattern) {
    const redZoneHit = redZoneConfirmed ? null : files.find((file) => redZonePattern.test(file));
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
  try {
    await execFileAsync('git', ['diff', '--cached', '--check'], {
      cwd: rootDir, windowsHide: true, env: { ...process.env, LC_ALL: 'C' },
    });
  } catch (error) {
    // Git writes diagnostics to stdout, including the offending source line.
    // Forward only recognized location summaries, never staged code or stderr.
    const locations = String(error.stdout ?? '').split(/\r?\n/u).flatMap((line) => {
      if (line.startsWith('+')) return [];
      const match = /^(.+):(\d+): (new blank line at EOF|trailing whitespace|space before tab in indent|leftover conflict marker)\.$/u.exec(line);
      return match ? [`${match[1].replace(/\p{C}/gu, '?').slice(0, 300)}:${match[2]}: ${match[3]}.`] : [];
    }).slice(0, 20);
    throw new Error(`STAGED_DIFF_CHECK_FAILED: git diff --cached --check rejected the staged snapshot.${locations.length ? `\n${locations.join('\n')}` : '\nInspect git diff --cached --check in the repository for details.'}`);
  }
  const { stdout } = await execFileAsync('git', ['diff', '--cached', '--no-ext-diff', '--unified=0', '--', '.'], {
    cwd: rootDir,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  const settings = await readHookSettings(rootDir);
  scanStagedDiff(stdout, {
  redZoneConfirmed: process.env.VIBE_HARNESS_CONFIRM_RED_ZONE === '1',
  redZonePaths: settings.redZonePaths,
});
}

// Reject shell metacharacters so a compromised vibe-harness.config.json cannot inject
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


export function parsePushUpdates(input) {
  if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('Push updates exceed limit');
  return input.trim().split(/\r?\n/u).filter(Boolean).map((line) => {
    const [localRef, sha, ref, remoteSha, ...extra] = line.trim().split(/\s+/u);
    if (extra.length || !localRef || !/^refs\/(?:heads|tags)\/[^\s]+$/u.test(ref ?? '')
      || !/^[0-9a-f]{40,64}$/iu.test(sha ?? '') || !/^[0-9a-f]{40,64}$/iu.test(remoteSha ?? '')) {
      throw new Error('Invalid pre-push update');
    }
    return { localRef, sha, ref, remoteSha };
  });
}
async function prePush(rootDir, url, input) {
  const updates = parsePushUpdates(input);
  if (!updates.length) {
    if (process.env.VIBE_HARNESS_MANAGED_PUSH === '1') throw new Error('PUSH_PROOF_MISSING: push update is missing');
    return;
  }
  if (process.env.VIBE_HARNESS_MANAGED_PUSH === '1' || process.env.VIBE_HARNESS_PUSH_PROOF) {
    if (updates.length !== 1 || !url) throw new Error('PUSH_PROOF_TARGET_MISMATCH');
    const { inspectPushVerification } = await import('../lib/push-verification.mjs');
    const result = await inspectPushVerification(rootDir, process.env.VIBE_HARNESS_PUSH_PROOF, { ...updates[0], url });
    if (!result.ok) throw new Error(`${result.code}: ${JSON.stringify({ changed: result.changed, environmentKeys: result.environmentKeys })}`);
    return;
  }
  const target = updates.length === 1 && url
    ? resolveGitPushTarget(rootDir, ['--no-force', url, `${updates[0].sha}:${updates[0].ref}`]) : null;
  if (!target) throw new Error('PUSH_TARGET_UNVERIFIED: require one configured endpoint, current frozen HEAD and exact development ref; force/deletion/multiple/protected targets are not supported.');
  const [update] = updates;
  const git = (args) => execFileAsync('git', args, {
    cwd: rootDir, windowsHide: true, timeout: 10000, maxBuffer: 8 * 1024 * 1024,
  });
  if (!/^0+$/u.test(update.remoteSha)) {
    try { await git(['merge-base', '--is-ancestor', update.remoteSha, update.sha]); }
    catch { throw new Error('PUSH_NOT_FAST_FORWARD: fetch the exact target and reconcile before retry; unknown remote objects cannot establish push safety.'); }
  }
  const revision = /^0+$/u.test(update.remoteSha) ? update.sha : `${update.remoteSha}..${update.sha}`;
  const child = spawn('git', ['log', '--format=', '--patch', '--root', '--diff-merges=separate',
    '--no-ext-diff', '--no-textconv', revision, '--'], {
    cwd: rootDir, windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const completed = new Promise((resolve) => {
    child.once('error', (error) => resolve(error));
    child.once('close', (code, signal) => resolve(code === 0 && !signal
      ? null : new Error('PUSH_SCAN_INCOMPLETE: outgoing history scan failed or timed out.')));
  });
  child.stdout.setEncoding('utf8');
  const scanLine = (line) => {
    if (line.startsWith('+') && !line.startsWith('+++') && secretPatterns.some((pattern) => pattern.test(line))) {
      throw new Error('PUSH_SECRET_DETECTED: possible credential in outgoing history; remove it and rotate exposed credentials before pushing.');
    }
  };
  try {
    let pending = '';
    for await (const chunk of child.stdout) {
      const lines = (pending + chunk).split('\n');
      pending = lines.pop();
      for (const line of lines) scanLine(line);
    }
    scanLine(pending);
    const failure = await completed;
    if (failure) throw failure;
  } finally {
    child.kill();
    await completed;
  }
}

// Run the hook only when invoked directly as `node git-hook.mjs <hook>`, not when
// imported (e.g. by tests exercising the pure scanStagedDiff export). A Worktree
// reaches the entry through its `.agents` junction, so both sides are realpath
// normalized before the comparison.
const invokedPath = process.argv[1]
  ? await realpath(process.argv[1]).catch(() => path.resolve(process.argv[1]))
  : null;
const modulePath = await realpath(fileURLToPath(import.meta.url))
  .catch(() => fileURLToPath(import.meta.url));
const isMain = invokedPath !== null && invokedPath === modulePath;
if (isMain) {
  const hook = process.argv[2];
  try {
    const rootDir = await findProjectRoot(process.cwd());
    if (hook === 'pre-commit') await preCommit(rootDir);
    else if (hook === 'commit-msg') {
      const message = await readFile(process.argv[3], 'utf8');
      if (secretPatterns.some((pattern) => pattern.test(message))) {
        throw new Error('Possible secret found in commit message.');
      }
    }
    else if (hook === 'pre-push') {
      let input = '';
      for await (const chunk of process.stdin) {
        input += chunk;
        if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('Push updates exceed limit');
      }
      await prePush(rootDir, process.argv[4], input);
    }
    else throw new Error(`Unknown Git hook: ${String(hook)}`);
  } catch (error) {
    process.stderr.write(`Vibe-Harness ${hook ?? 'git-hook'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

export { resolveExecutable, runCommand };
