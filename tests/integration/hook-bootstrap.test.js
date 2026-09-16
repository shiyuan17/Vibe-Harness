import assert from 'node:assert/strict';
import { exec, execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { createHostHookResult } from '../../runtime/hooks/lib/policy.mjs';
import { renderTemplate } from '../../scripts/lib/template-renderer.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '../..');
const bootstrapSourcePath = path.join(rootDir, 'scripts/lib/hook-bootstrap.cjs');

// Every adapter renders the same bootstrap payload; only the host flag and the
// event name differ, so the contract test walks the real templates instead of
// rebuilding the command by hand.
const adapterCases = [
  { adapter: 'codex', event: 'PreToolUse', host: 'codex', templateEvent: 'PreToolUse', wrapped: true },
  { adapter: 'codex', event: 'PermissionRequest', host: 'codex', templateEvent: 'PermissionRequest', wrapped: true },
  { adapter: 'claude', event: 'PreToolUse', host: 'claude', templateEvent: 'PreToolUse' },
  { adapter: 'claude', event: 'PermissionRequest', host: 'claude', templateEvent: 'PermissionRequest' },
  { adapter: 'qoder', event: 'PreToolUse', host: 'qoder', templateEvent: 'PreToolUse' },
  { adapter: 'zcode', event: 'PermissionRequest', host: 'zcode', templateEvent: 'PermissionRequest' },
  { adapter: 'cursor', event: 'preToolUse', host: 'cursor', templateEvent: 'preToolUse' },
  { adapter: 'antigravity', event: 'PreToolUse', host: 'antigravity', templateEvent: 'PreToolUse' },
];

async function adapterHookCommand({ adapter, templateEvent, wrapped }) {
  const template = await readFile(path.join(rootDir, `adapters/${adapter}/hooks.template.json`), 'utf8');
  const rendered = JSON.parse(renderTemplate(template));
  const groups = wrapped ? rendered.hooks[templateEvent] : rendered[templateEvent];
  return groups[0].hooks[0].command;
}

async function bootstrapCommand() {
  return adapterHookCommand(adapterCases[0]);
}

async function seedHook(root, source = "import { fileURLToPath } from 'node:url'; process.stdout.write(fileURLToPath(import.meta.url));\n") {
  const hook = path.join(root, '.agents/runtime/hooks/codex-hook.mjs');
  await mkdir(path.dirname(hook), { recursive: true });
  await writeFile(hook, source, 'utf8');
  return hook;
}

async function initGitRepo(dir) {
  await mkdir(dir, { recursive: true });
  await execFileAsync('git', ['init'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'hook-test@example.invalid'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Hook Test'], { cwd: dir });
}

function shapeOf(value) {
  if (Array.isArray(value)) return value.map(shapeOf);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shapeOf(value[key])]));
  }
  return typeof value;
}

async function runBootstrap(command, { cwd, env } = {}) {
  try {
    const result = await execAsync(command, { cwd, env: env ? { ...process.env, ...env } : undefined, windowsHide: true });
    return { code: 0, stderr: result.stderr, stdout: result.stdout };
  } catch (error) {
    return { code: error.code ?? 1, stderr: error.stderr ?? '', stdout: error.stdout ?? '' };
  }
}

test('Hook bootstrap resolves the active Git root from root, nested directories, and worktrees', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'vibe-harness-hook-bootstrap-'));
  const main = path.join(base, 'main');
  const linked = path.join(base, 'linked');
  try {
    await mkdir(main);
    await execFileAsync('git', ['init'], { cwd: main });
    await execFileAsync('git', ['config', 'user.email', 'hook-test@example.invalid'], { cwd: main });
    await execFileAsync('git', ['config', 'user.name', 'Hook Test'], { cwd: main });
    const mainHook = await seedHook(main);
    const nested = path.join(main, 'one/two');
    await mkdir(nested, { recursive: true });
    await execFileAsync('git', ['add', '.'], { cwd: main });
    await execFileAsync('git', ['commit', '-m', 'test: seed hook fixture'], { cwd: main });
    await execFileAsync('git', ['worktree', 'add', linked, '-b', 'test/hook-bootstrap'], { cwd: main });
    const linkedNested = path.join(linked, 'three/four');
    await mkdir(linkedNested, { recursive: true });

    const command = await bootstrapCommand();
    const rootResult = await runBootstrap(command, { cwd: main });
    const nestedResult = await runBootstrap(command, { cwd: nested });
    const linkedResult = await runBootstrap(command, { cwd: linkedNested });
    assert.equal(await realpath(rootResult.stdout), await realpath(mainHook));
    assert.equal(nestedResult.stdout, rootResult.stdout);
    assert.match(path.normalize(linkedResult.stdout), /linked.*codex-hook\.mjs$/u);
  } finally {
    await rm(base, { force: true, recursive: true });
  }
});

test('Hook bootstrap denies the tool call instead of exiting non-zero when no Git root exists', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-hook-no-git-'));
  try {
    const command = await bootstrapCommand();
    const result = await runBootstrap(command, { cwd: target });
    assert.equal(result.code, 0, 'fail-closed must use the host decision channel, not an error exit code');
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /\[VIBE_HARNESS_HOOK:BOOTSTRAP_UNAVAILABLE\]/u);
    assert.match(result.stderr, /BOOTSTRAP_UNAVAILABLE/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('Hook bootstrap denies the tool call when the managed runtime is missing', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-hook-no-runtime-'));
  try {
    await initGitRepo(target);
    const command = await bootstrapCommand();
    const result = await runBootstrap(command, { cwd: target });
    assert.equal(result.code, 0);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /BOOTSTRAP_UNAVAILABLE/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('Hook bootstrap denial matches the runtime decision shape for every host and event', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-hook-shapes-'));
  try {
    for (const adapterCase of adapterCases) {
      const command = await adapterHookCommand(adapterCase);
      const result = await runBootstrap(command, { cwd: target });
      const expected = createHostHookResult(adapterCase.host, adapterCase.event, {
        action: 'deny',
        reason: '[VIBE_HARNESS_HOOK:BOOTSTRAP_UNAVAILABLE] reason',
      });
      assert.equal(result.code, 0, adapterCase.adapter + ':' + adapterCase.event);
      assert.deepEqual(shapeOf(JSON.parse(result.stdout)), shapeOf(expected), adapterCase.adapter + ':' + adapterCase.event);
    }
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('Hook bootstrap stays fail-closed for an unknown host', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-hook-unknown-host-'));
  try {
    const command = (await bootstrapCommand()) + ' --host gemini';
    const result = await runBootstrap(command, { cwd: target });
    assert.equal(result.code, 2);
    assert.equal(result.stdout.trim(), '');
    assert.match(result.stderr, /BOOTSTRAP_UNAVAILABLE/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('Hook bootstrap payload stays single-line, shell-safe, and single-sourced', async () => {
  const payload = await readFile(bootstrapSourcePath, 'utf8');
  const source = payload.replace(/\r?\n$/u, '');
  assert.equal(source.includes('\n'), false, 'the payload must be one line');
  for (const forbidden of ['"', '\\', '`', '$', '%']) {
    assert.equal(source.includes(forbidden), false, 'payload must not contain ' + JSON.stringify(forbidden));
  }
  for (const adapterCase of adapterCases) {
    const command = await adapterHookCommand(adapterCase);
    assert.match(command, /^node -e "/u, adapterCase.adapter);
    assert.match(command, /" --(?: --host [a-z]+)? --expected-event [A-Za-z]+$/u, adapterCase.adapter);
    assert.equal(command.includes(source), true, adapterCase.adapter + ' must embed the single bootstrap source');
    assert.doesNotMatch(command, /[A-Za-z]:[\\/]/u);
    assert.doesNotMatch(command, /\$\(/u);
  }
});

test('Hook bootstrap passes only the allowlisted environment to the managed runtime', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'vibe-harness-hook-env-'));
  const main = path.join(base, 'main');
  try {
    await initGitRepo(main);
    await seedHook(main, [
      'process.stdout.write(JSON.stringify({',
      "  leaked: process.env.OPENAI_API_KEY === undefined && process.env.AWS_SECRET_ACCESS_KEY === undefined ? 'none' : 'present',",
      "  root: process.env.VIBE_HARNESS_GIT_ROOT ?? null,",
      '}));',
      '',
    ].join('\n'));
    const command = await bootstrapCommand();
    const result = await runBootstrap(command, {
      cwd: main,
      env: { AWS_SECRET_ACCESS_KEY: 'probe-secret', OPENAI_API_KEY: 'probe-key' },
    });
    const report = JSON.parse(result.stdout);
    assert.equal(report.leaked, 'none');
    assert.equal(await realpath(report.root), await realpath(main));
  } finally {
    await rm(base, { force: true, recursive: true });
  }
});
