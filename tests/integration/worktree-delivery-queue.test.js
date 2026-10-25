import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { verifyProject } from '../../runtime/lib/verification-command.mjs';
import {
  acquireDeliveryTurn,
  DELIVERY_QUEUE_DIR,
  inspectDeliveryQueue,
  reconcileDeliveryQueue,
  releaseDeliveryTurn,
} from '../../runtime/lib/worktree-delivery-queue.mjs';

const execute = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '../..');
const queueModuleUrl = pathToFileURL(path.join(rootDir, 'runtime/lib/worktree-delivery-queue.mjs')).href;

async function git(cwd, args) {
  const { stdout } = await execute('git', [
    '-c', 'user.email=fixture@example.invalid',
    '-c', 'user.name=Fixture',
    ...args,
  ], { cwd, windowsHide: true, timeout: 30_000 });
  return stdout.trim();
}

async function makeRepository() {
  const project = await mkdtemp(path.join(tmpdir(), 'vibe-harness-delivery-queue-'));
  await git(project, ['init', '--quiet']);
  await writeFile(path.join(project, 'owned.txt'), 'initial\n');
  await git(project, ['add', 'owned.txt']);
  await git(project, ['commit', '-qm', 'fixture']);
  return project;
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function runHolder(project, events, delayMs) {
  const source = `
import { appendFileSync } from 'node:fs';
import { acquireDeliveryTurn, releaseDeliveryTurn } from ${JSON.stringify(queueModuleUrl)};
const progress = [];
const handle = await acquireDeliveryTurn(process.cwd(), {
  operation: 'verify',
  timeoutMs: 5000,
  retryMs: 20,
  onProgress: (event) => progress.push(event),
});
if (!handle.ok) {
  console.log(JSON.stringify({ ok: false, handle, progress }));
  process.exit(2);
}
appendFileSync(${JSON.stringify(events)}, 'start:' + handle.report.ticketId + '\\n');
await new Promise((resolve) => setTimeout(resolve, ${Math.max(1, delayMs)}));
appendFileSync(${JSON.stringify(events)}, 'end:' + handle.report.ticketId + '\\n');
const released = await releaseDeliveryTurn(handle, 'completed');
console.log(JSON.stringify({ ok: true, report: handle.report, progress, released }));
`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: project,
    env: { ...process.env, VIBE_HARNESS_REPO_QUEUE_TIMEOUT_MS: '5000' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`queue holder exited ${code}: ${stderr || stdout}`));
        return;
      }
      resolve(JSON.parse(stdout.trim()));
    });
  });
  return { child, done };
}

test('delivery queue serializes independent processes in ticket order and reports the holder', { timeout: 30_000 }, async () => {
  const project = await makeRepository();
  const events = path.join(project, 'events.txt');
  const worktrees = [1, 2, 3].map((index) => path.join(
    path.dirname(project),
    `${path.basename(project)}-delivery-${index}`,
  ));
  try {
    for (const [index, worktree] of worktrees.entries()) {
      await git(project, ['worktree', 'add', '-q', '-b', `queue/${index + 1}`, worktree]);
    }
    const first = runHolder(worktrees[0], events, 3000);
    assert.equal(await waitFor(async () => existsSync(events)), true);
    const second = runHolder(worktrees[1], events, 100);
    assert.equal(await waitFor(async () => (await inspectDeliveryQueue(project)).active.length === 2), true);
    const third = runHolder(worktrees[2], events, 50);
    assert.equal(await waitFor(async () => (await inspectDeliveryQueue(project)).active.length === 3), true);

    const [firstResult, secondResult, thirdResult] = await Promise.all([first.done, second.done, third.done]);
    assert.equal(first.child.exitCode ?? 0, 0);
    assert.equal(second.child.exitCode ?? 0, 0);
    assert.equal(third.child.exitCode ?? 0, 0);
    const lines = (await readFile(events, 'utf8')).trim().split(/\r?\n/u);
    assert.deepEqual(lines.map((line) => line.split(':')[0]), ['start', 'end', 'start', 'end', 'start', 'end']);
    const ticketIds = lines.map((line) => line.split(':')[1]);
    assert.deepEqual([ticketIds[0], ticketIds[2], ticketIds[4]], [
      firstResult.report.ticketId,
      secondResult.report.ticketId,
      thirdResult.report.ticketId,
    ]);
    const secondWait = secondResult.progress.find((event) => event.phase === 'queue-wait');
    assert.equal(secondWait.queue.position, 2);
    assert.equal(secondWait.queue.ahead, 1);
    assert.equal(secondWait.queue.owner?.pid > 0, true);
    assert.equal(secondResult.report.ahead, 0);
    assert.equal(thirdResult.report.ahead, 0);
  } finally {
    for (const worktree of worktrees) await rm(worktree, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test('delivery queue timeout preserves a cancelled ticket and the active holder', async () => {
  const project = await makeRepository();
  try {
    const holder = await acquireDeliveryTurn(project, { operation: 'land', timeoutMs: 1000 });
    assert.equal(holder.ok, true, JSON.stringify(holder));
    const blocked = await acquireDeliveryTurn(project, {
      operation: 'publish',
      timeoutMs: 150,
      retryMs: 20,
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'WORKTREE_QUEUE_TIMEOUT');
    assert.equal(blocked.queue.owner.operation, 'land');
    let queue = await inspectDeliveryQueue(project);
    assert.equal(queue.active.length, 1);
    assert.equal(queue.tickets.some((ticket) => ticket.id === blocked.queue.ticketId && ticket.state === 'cancelled'), true);
    await releaseDeliveryTurn(holder, 'completed');
    queue = await inspectDeliveryQueue(project);
    assert.equal(queue.active.length, 0);
    assert.equal(queue.tickets.find((ticket) => ticket.id === holder.report.ticketId)?.state, 'completed');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('dead tickets are ignored, reported stale, and reconciled without touching live tickets', async () => {
  const project = await makeRepository();
  try {
    const common = path.resolve(project, await git(project, ['rev-parse', '--git-common-dir']));
    const queueRoot = path.join(common, DELIVERY_QUEUE_DIR);
    await mkdir(queueRoot, { recursive: true });
    const deadId = '00000000-0000-4000-8000-000000000010';
    await writeFile(path.join(queueRoot, `000000000001-${deadId}.json`), `${JSON.stringify({
      schemaVersion: 1,
      id: deadId,
      sequence: 1,
      operation: 'land',
      batchId: null,
      state: 'running',
      requestedAt: new Date(Date.now() - 60_000).toISOString(),
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
      leaseMs: 5_000,
      pid: 99_999_999,
      hostname: 'fixture',
      metadata: {},
    }, null, 2)}\n`);

    let queue = await inspectDeliveryQueue(project);
    assert.equal(queue.active.length, 0);
    assert.equal(queue.stale[0].id, deadId);
    const reconciled = await reconcileDeliveryQueue(project, { write: true });
    assert.equal(reconciled.expired.some((ticket) => ticket.id === deadId), true);
    const holder = await acquireDeliveryTurn(project, { operation: 'verify', timeoutMs: 1000 });
    assert.equal(holder.ok, true, JSON.stringify(holder));
    queue = await inspectDeliveryQueue(project);
    assert.equal(queue.tickets.find((ticket) => ticket.id === deadId)?.state, 'expired');
    assert.equal(queue.tickets.find((ticket) => ticket.id === holder.report.ticketId)?.state, 'running');
    await releaseDeliveryTurn(holder, 'completed');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('resourceClass repo-heavy makes a quick verification participate in the repository FIFO', { timeout: 30_000 }, async () => {
  const project = await makeRepository();
  const previous = process.env.VIBE_HARNESS_REPO_QUEUE_TIMEOUT_MS;
  let holder = null;
  try {
    await writeFile(path.join(project, 'vibe-harness.config.json'), `${JSON.stringify({
      profile: 'core',
      validationCommands: {
        checks: [{
          id: 'heavy',
          command: 'node --version',
          layer: 'heavy',
          costTier: 'quick',
          resourceClass: 'repo-heavy',
        }],
        tiers: { quick: ['node --version'] },
      },
      verification: { timeoutMs: 30_000 },
    }, null, 2)}\n`);
    holder = await acquireDeliveryTurn(project, { operation: 'land', timeoutMs: 1000 });
    assert.equal(holder.ok, true, JSON.stringify(holder));
    process.env.VIBE_HARNESS_REPO_QUEUE_TIMEOUT_MS = '150';
    const blocked = await verifyProject(project, {
      tier: 'quick',
      only: ['heavy'],
      reuse: false,
      allowManual: false,
      task: [],
    });
    assert.equal(blocked.status, 'blocked', JSON.stringify(blocked));
    assert.equal(blocked.code, 'WORKTREE_QUEUE_TIMEOUT');
    assert.equal(blocked.queue.owner.operation, 'land');
    await releaseDeliveryTurn(holder, 'completed');
    holder = null;
    delete process.env.VIBE_HARNESS_REPO_QUEUE_TIMEOUT_MS;
    const passed = await verifyProject(project, {
      tier: 'quick',
      only: ['heavy'],
      reuse: false,
      allowManual: false,
      task: [],
    });
    assert.equal(passed.status, 'passed', JSON.stringify(passed));
    assert.equal(passed.queue.state, 'completed');
    assert.equal(passed.checks.heavy.status, 'passed', JSON.stringify(passed));
  } finally {
    if (previous === undefined) delete process.env.VIBE_HARNESS_REPO_QUEUE_TIMEOUT_MS;
    else process.env.VIBE_HARNESS_REPO_QUEUE_TIMEOUT_MS = previous;
    if (holder) await releaseDeliveryTurn(holder, 'cancelled');
    await rm(project, { recursive: true, force: true });
  }
});
