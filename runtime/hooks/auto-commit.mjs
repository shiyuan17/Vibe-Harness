#!/usr/bin/env node
// Stop-event hook: auto-commit complete, independently-rollbackable work on
// task branches. Designed for ZCode, Claude Code, and Codex, which share a
// near-identical Stop hook model. Cursor, Qoder, and Antigravity do not support
// hooks and are out of scope.
//
// Completeness guarantee: nothing is committed unless it passes the safety
// scan, a syntax check, and the project's lint+test validation commands. Each
// Stop fires at most one commit (one logical snapshot), so every commit is
// independently revertible (`git reset --soft HEAD~1` unpushed, `git revert`
// once pushed). The hook never pushes and never uses `--no-verify`.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { findProjectRoot, readHookSettings, readProjectConfig } from './lib/context.mjs';
import { runCommand, scanStagedDiff } from './git-hook.mjs';

const execFileAsync = promisify(execFile);
const MAX_INPUT_BYTES = 1024 * 1024;

const protectedBranches = new Set(['main', 'master', 'develop']);
const protectedBranchPrefixes = ['release/', 'releases/'];

const syntaxCheckableExtensions = new Set(['.js', '.mjs', '.cjs', '.json']);

async function git(rootDir, args, { maxBuffer } = {}) {
  const { stdout } = await execFileAsync('git', args, {
    cwd: rootDir,
    maxBuffer: maxBuffer ?? 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

function isProtectedBranch(branch) {
  if (protectedBranches.has(branch)) return true;
  return protectedBranchPrefixes.some((prefix) => branch.startsWith(prefix));
}

function classifyChange(files) {
  if (files.length === 0) return { type: 'chore', scope: '' };
  if (files.every((file) => file.startsWith('tests/') || file.startsWith('test/'))) return { type: 'test', scope: '' };
  if (files.every((file) => file.startsWith('docs/') || file.endsWith('.md'))) return { type: 'docs', scope: '' };
  if (files.every((file) => file.startsWith('rules/') || file.includes('/rules/'))) return { type: 'docs', scope: 'rules' };
  if (files.some((file) => /\.(?:js|mjs|cjs|ts|tsx)$/u.test(file))) return { type: 'feat', scope: '' };
  return { type: 'chore', scope: '' };
}

function buildCommitMessage(files, validationStatus) {
  const { type, scope } = classifyChange(files);
  const summary = files.length === 1
    ? path.basename(files[0])
    : `${files.length} files`;
  const scopeSuffix = scope ? `(${scope})` : '';
  const headline = `${type}${scopeSuffix}: auto-commit ${summary}`;
  const body = [
    'Auto-committed by Vibe-Harness Stop hook.',
    '',
    'Files:',
    ...files.slice(0, 20).map((file) => `- ${file}`),
    ...(files.length > 20 ? [`... and ${files.length - 20} more`] : []),
    '',
    `Validation: ${validationStatus}`,
    `Timestamp: ${new Date().toISOString()}`,
    '',
    'Rollback: git reset --soft HEAD~1 (unpushed) or git revert (pushed).',
  ].join('\n');
  return { headline, body };
}

async function checkSyntax(rootDir, files) {
  const checkable = files.filter((file) => syntaxCheckableExtensions.has(path.extname(file)));
  for (const file of checkable) {
    const absolute = path.resolve(rootDir, file);
    if (path.extname(file) === '.json') {
      const content = await import('node:fs/promises').then((fs) => fs.readFile(absolute, 'utf8'));
      JSON.parse(content);
      continue;
    }
    // node --check exits non-zero on a syntax error; the execFile rejection
    // surfaces the parser diagnostics.
    await execFileAsync(process.execPath, ['--check', absolute], { windowsHide: true });
  }
}

async function runValidation(rootDir, config) {
  const commands = ['lint', 'test']
    .map((name) => config.validationCommands?.[name])
    .filter((command) => typeof command === 'string' && command.trim().length > 0);
  if (commands.length === 0) return 'no validation commands configured';
  const results = [];
  for (const command of commands) {
    try {
      await runCommand(command, rootDir, { timeout: 25000, stdio: 'pipe' });
      results.push(`${command}: pass`);
    } catch (error) {
      results.push(`${command}: fail (${error.message})`);
      throw new Error(`Validation failed: ${command} - ${error.message}`);
    }
  }
  return results.join('; ');
}

async function stagedFiles(rootDir) {
  const stdout = await git(rootDir, ['diff', '--cached', '--name-only']);
  return stdout.split('\n').filter(Boolean);
}

async function stagedDiff(rootDir) {
  return git(rootDir, ['diff', '--cached', '--no-ext-diff', '--unified=0', '--', '.'], { maxBuffer: 8 * 1024 * 1024 });
}

async function resetStaging(rootDir) {
  // Unstage without touching working-tree contents, so a failed gate leaves
  // the user's changes intact for inspection.
  await git(rootDir, ['reset', '--quiet', 'HEAD']);
}

export async function autoCommit({ cwd, rootDir, stopHookActive } = {}) {
  // 1. Anti-loop: when the host re-enters Stop because of this hook's own
  //    continuation output, stop_hook_active is true and we must bail out.
  if (stopHookActive) return {};
  if (!rootDir) rootDir = await findProjectRoot(cwd ?? process.cwd());

  // 2. Only operate inside a git work tree.
  try {
    await git(rootDir, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return {};
  }

  // 3. Never auto-commit on main/develop/release branches.
  const branch = (await git(rootDir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (!branch || isProtectedBranch(branch)) return {};

  // 4. Nothing to do if the working tree is clean.
  const status = (await git(rootDir, ['status', '--porcelain'])).trim();
  if (!status) return {};

  // 5. Stage everything so a single snapshot captures the logical change.
  await git(rootDir, ['add', '-A']);
  const files = await stagedFiles(rootDir);
  if (files.length === 0) return {};

  let validationStatus = 'skipped';
  try {
    // 6a. Safety scan: secrets, red-zone, forbidden paths, focused test markers.
    const settings = await readHookSettings(rootDir);
    const diff = await stagedDiff(rootDir);
    scanStagedDiff(diff, { redZonePaths: settings.redZonePaths });

    // 6b. Syntax check on .js/.mjs/.cjs/.json before anything heavier.
    await checkSyntax(rootDir, files);

    // 6c. Validation gate (lint + test from validationCommands).
    let config;
    try {
      config = await readProjectConfig(rootDir);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      config = {};
    }
    validationStatus = await runValidation(rootDir, config);
  } catch (error) {
    await resetStaging(rootDir);
    return {
      additionalContext: `Vibe-Harness auto-commit skipped on ${branch}: ${error.message}. Changes left unstaged; rollback not needed.`,
    };
  }

  // 7. Commit. husky pre-commit (git diff --cached --check) and commit-msg
  //    (commitlint) run automatically; we never pass --no-verify.
  const { headline, body } = buildCommitMessage(files, validationStatus);
  try {
    await execFileAsync('git', ['commit', '-m', headline, '-m', body], {
      cwd: rootDir,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    await resetStaging(rootDir);
    return {
      additionalContext: `Vibe-Harness auto-commit failed on ${branch}: ${error.message}. Changes left unstaged.`,
    };
  }

  return {
    additionalContext: `Auto-committed on ${branch}: ${headline}. ${validationStatus}. Rollback: git reset --soft HEAD~1`,
  };
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) throw new Error('Hook input exceeds 1 MiB.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function hostFromArgs(argv) {
  const index = argv.indexOf('--host');
  if (index === -1) return 'codex';
  const host = argv[index + 1];
  if (!['codex', 'zcode', 'claude'].includes(host)) {
    throw new Error(`Unsupported auto-commit host: ${String(host)}`);
  }
  return host;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  try {
    const input = await readStdin();
    const cwd = input.cwd ?? input.workspaceRoot ?? input.project_root ?? process.cwd();
    const result = await autoCommit({
      cwd,
      stopHookActive: Boolean(input.stop_hook_active ?? input.stopHookActive),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    // A Stop hook must never block the session; report and pass through.
    process.stdout.write(`${JSON.stringify({ additionalContext: `Vibe-Harness auto-commit error: ${error.message}` })}\n`);
  }
}
