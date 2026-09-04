import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { inspectMemory, inspectRuntimeHooks, runtimeHookWarnings } from '../scripts/lib/runtime-diagnostics.js';

const execFileAsync = promisify(execFile);
const runtimeTarget = '.agents/memory/CURRENT.md';
const durableTarget = 'docs/memory/PROJECT_STATE.md';

function config(enabled = true) {
  return { memory: { enabled, path: '.agents/memory' } };
}

function state(...targets) {
  return { files: targets.map((target) => ({ target })) };
}

function dateOffset(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function runtimeContent(date) {
  return '# Current\n\n- 目标: verify memory\n- 当前状态: active\n- 已验证证据: tests\n- 未完成事项: none\n- 下一步最小动作: finish\n- 最后更新: ' + date + '\n- 最后验证: ' + date + '\n';
}

function durableContent(date) {
  return '# Project state\n\n- 最后更新: ' + date + '\n- 当前阶段: implementation\n- 当前重点: diagnostics\n- 下一步动作: verify\n- 恢复提示: rerun tests\n';
}

async function writeMemories(target, runtime, durable) {
  await mkdir(path.join(target, '.agents/memory'), { recursive: true });
  await mkdir(path.join(target, 'docs/memory'), { recursive: true });
  await writeFile(path.join(target, runtimeTarget), runtime, 'utf8');
  await writeFile(path.join(target, durableTarget), durable, 'utf8');
}

test('memory diagnostics distinguish disabled, not-installed, missing, and empty', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-memory-basic-'));
  try {
    assert.deepEqual(await inspectMemory(config(false), null, target), {
      runtime: { path: runtimeTarget, status: 'disabled' },
      durable: { path: durableTarget, status: 'disabled' },
    });
    const absent = await inspectMemory(config(), null, target);
    assert.equal(absent.runtime.status, 'not-installed');
    assert.equal(absent.durable.status, 'not-installed');
    const missing = await inspectMemory(config(), state(runtimeTarget, durableTarget), target);
    assert.equal(missing.runtime.status, 'missing');
    assert.equal(missing.durable.status, 'missing');
    await writeMemories(target, '# Current\n- 最后验证: (YYYY-MM-DD)\n', '# State\n- 最后更新: (YYYY-MM-DD)\n');
    const empty = await inspectMemory(config(), state(runtimeTarget, durableTarget), target);
    assert.equal(empty.runtime.status, 'empty');
    assert.equal(empty.durable.status, 'empty');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('memory diagnostics distinguish invalid, stale, and current without writing files', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-memory-freshness-'));
  try {
    await writeMemories(target, runtimeContent('2026-99-99'), durableContent('not-a-date'));
    const invalid = await inspectMemory(config(), state(runtimeTarget, durableTarget), target);
    assert.equal(invalid.runtime.status, 'invalid');
    assert.equal(invalid.durable.status, 'invalid');

    await writeMemories(target, runtimeContent(dateOffset(-2)), durableContent(dateOffset(-31)));
    const stale = await inspectMemory(config(), state(runtimeTarget, durableTarget), target);
    assert.equal(stale.runtime.status, 'stale');
    assert.equal(stale.durable.status, 'stale');

    const today = dateOffset(0);
    await writeMemories(target, runtimeContent(today), durableContent(today));
    const before = createHash('sha256').update(await readFile(path.join(target, runtimeTarget))).digest('hex');
    const current = await inspectMemory(config(), state(runtimeTarget, durableTarget), target);
    const after = createHash('sha256').update(await readFile(path.join(target, runtimeTarget))).digest('hex');
    assert.equal(current.runtime.status, 'current');
    assert.equal(current.durable.status, 'current');
    assert.equal(after, before);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('runtime memory becomes stale when its verification date predates HEAD', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-memory-head-'));
  try {
    const today = dateOffset(0);
    const tomorrow = dateOffset(1) + 'T12:00:00Z';
    await writeMemories(target, runtimeContent(today), durableContent(today));
    await writeFile(path.join(target, 'tracked.txt'), 'tracked\n', 'utf8');
    await execFileAsync('git', ['init'], { cwd: target });
    await execFileAsync('git', ['config', 'user.email', 'memory-test@example.invalid'], { cwd: target });
    await execFileAsync('git', ['config', 'user.name', 'Memory Test'], { cwd: target });
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: target });
    await execFileAsync('git', ['commit', '-m', 'test: future head'], {
      cwd: target,
      env: { ...process.env, GIT_AUTHOR_DATE: tomorrow, GIT_COMMITTER_DATE: tomorrow },
    });
    const report = await inspectMemory(config(), state(runtimeTarget, durableTarget), target);
    assert.equal(report.runtime.status, 'stale');
    assert.equal(report.durable.status, 'current');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('runtime Hook enforcement requires independent host evidence', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-hook-evidence-'));
  try {
    const adapters = JSON.parse(await readFile(path.resolve('manifests/adapters.json'), 'utf8'));
    const adapter = adapters.items.find((item) => item.id === 'codex');
    await mkdir(path.join(target, '.codex'), { recursive: true });
    await writeFile(path.join(target, '.codex', 'hooks.json'), '{}\n', 'utf8');

    const unverified = await inspectRuntimeHooks(adapter, target);
    assert.equal(unverified.enforced, false);
    assert.equal(unverified.executionAuthority.envelopeRequired, false);
    assert.equal(unverified.executionAuthority.hostContextVerified, false);
    assert.equal(runtimeHookWarnings(unverified).some((warning) => warning.code === 'HOOK_ENFORCEMENT_UNVERIFIED'), true);

    const enforced = await inspectRuntimeHooks(adapter, target, {
      hostEvidence: {
        activated: true,
        approval: true,
        envelopeRequired: true,
        network: true,
        process: true,
        sandbox: true,
      },
    });
    assert.equal(enforced.enforced, true);
    assert.equal(enforced.status, 'enforced');
    assert.equal(enforced.activation.status, 'verified');
    assert.deepEqual(runtimeHookWarnings(enforced), []);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
