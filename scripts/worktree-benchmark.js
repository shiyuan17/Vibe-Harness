#!/usr/bin/env node
// Explicit, local-only benchmark. Never part of the default verification suite.
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { removeTemporaryDirectory } from './lib/temp-cleanup.js';

const execute = promisify(execFile);
const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, token, index, args) =>
  token.startsWith('--') ? [...pairs, [token.slice(2), args[index + 1]]] : pairs, []));
const runtime = path.resolve(options.runtime ?? 'runtime');
const repetitions = Number(options.repetitions ?? 5);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20) throw new Error('repetitions must be 1..20');
const { runCommand } = await import(pathToFileURL(path.join(runtime, 'commands/run.mjs')).href);
const git = async (cwd, args) => (await execute('git', args, { cwd, windowsHide: true })).stdout.trim();
const check = `import {appendFileSync} from 'node:fs';
const file=process.env.VIBE_BENCH_COUNTER;
const started=Date.now();
appendFileSync(file,JSON.stringify({event:'start',pid:process.pid,at:started,cwd:process.cwd()})+'\\n');
await new Promise(r=>setTimeout(r,process.env.VIBE_BENCH_BLOCK==='1'?5000:150));
appendFileSync(file,JSON.stringify({event:'end',pid:process.pid,at:Date.now(),cwd:process.cwd()})+'\\n');
`;
async function sample(scenario, iteration) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'vibe-worktree-benchmark-')));
  const repo = path.join(root, 'repo');
  const origin = path.join(root, 'origin.git');
  const counter = path.join(root, 'checks.ndjson');
  const previous = { counter: process.env.VIBE_BENCH_COUNTER, block: process.env.VIBE_BENCH_BLOCK };
  const progress = [];
  const stages = [];
  const publishes = [];
  let result;
  const run = async (args) => {
    const started = Date.now();
    const value = await runCommand(['worktree', ...args, '--project', repo, '--json'], {
      cwd: repo, onProgress: (event) => progress.push({ ...event, observedAt: Date.now() }),
    });
    let transaction = null;
    if (value.report.batchId) {
      try { transaction = JSON.parse(await readFile(path.join(repo, '.git', `vibe-harness-land-batch-${value.report.batchId}.json`), 'utf8')); }
      catch { /* Older versions remove terminal records. */ }
    }
    return { ...value.report, elapsedMs: Date.now() - started,
      measurement: { transactionVersion: transaction?.schemaVersion ?? null,
        replayCount: transaction?.replayCount ?? 0, candidateHead: transaction?.candidateHead ?? null,
        phase: transaction?.phase ?? null, resources: transaction?.resources ?? null, proofTimingsMs: transaction?.proofTimingsMs ?? null } };
  };
  try {
    await mkdir(path.join(repo, 'src'), { recursive: true });
    await git(repo, ['init', '-q', '-b', 'develop']);
    await git(repo, ['config', 'user.name', 'Benchmark']);
    await git(repo, ['config', 'user.email', 'benchmark@example.invalid']);
    await writeFile(path.join(repo, '.gitignore'), '.vibe-harness/\nnode_modules/\n');
    await writeFile(path.join(repo, 'check.mjs'), check);
    await writeFile(counter, '');
    await writeFile(path.join(repo, 'vibe-harness.config.json'), JSON.stringify({
      worktree: { baseRef: 'develop', dependencyRoots: [], root: '../worktrees' },
      validationCommands: {
        test: 'node check.mjs',
        tiers: { quick: ['node check.mjs'], standard: ['node check.mjs'], deep: [] },
        checks: [{ id: 'test', command: 'node check.mjs', deterministic: true,
          resources: scenario === 'shared-resource' ? ['benchmark-database'] : [] }],
      },
      verification: { timeoutMs: 1000 },
    }));
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-qm', 'fixture']);
    await git(root, ['init', '--bare', '-q', origin]);
    await git(repo, ['remote', 'add', 'origin', origin]);
    await git(repo, ['push', '-q', 'origin', 'develop']);
    const hook = path.join(repo, '.git/hooks/pre-push');
    await writeFile(hook, `#!/bin/sh\nexec node "${path.join(runtime, 'hooks/git-hook.mjs').replaceAll('\\', '/')}" pre-push "$@"\n`);
    await chmod(hook, 0o755);
    process.env.VIBE_BENCH_COUNTER = counter;
    delete process.env.VIBE_BENCH_BLOCK;
    const count = ['parallel', 'shared-resource'].includes(scenario) ? 2 : 1;
    for (let n = 1; n <= count; n++) {
      const boot = await run(['bootstrap', '--task', `BENCH-${n}:feat/BENCH-${n}-work`, '--write']);
      if (boot.status !== 'passed') throw new Error(JSON.stringify(boot));
      const tree = path.join(root, 'worktrees', `BENCH-${n}`);
      await mkdir(path.join(tree, 'src'), { recursive: true });
      await writeFile(path.join(tree, `src/change-${n}.txt`), 'change\n');
      await git(tree, ['add', '.']);
      await git(tree, ['commit', '-qm', 'feat: sample']);
    }
    const started = Date.now();
    stages.push(...await Promise.all(Array.from({ length: count }, (_, i) =>
      run(['stage', '--task', `BENCH-${i + 1}`, '--delivery', 'local-land', '--write']))));
    if (['baseline-advance', 'interrupted'].includes(scenario)) {
      await writeFile(path.join(repo, 'src/upstream.txt'), 'upstream\n');
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-qm', 'feat: upstream']);
      // Advance the fixture remote without invoking the measured local hook.
      const head = await git(repo, ['rev-parse', 'HEAD']);
      await git(origin, ['fetch', '-q', repo, `${head}:refs/heads/develop`]);
    }
    for (const stage of stages) {
      if (stage.integrationStatus !== 'local_staged') continue;
      const args = ['publish', '--batch', stage.batchId, '--delivery', 'local-land', '--write'];
      if (scenario === 'interrupted') {
        process.env.VIBE_BENCH_BLOCK = '1';
        publishes.push(await run(args));
        delete process.env.VIBE_BENCH_BLOCK;
      }
      publishes.push(await run(args));
    }
    const events = (await readFile(counter, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    if (stages.some((stage) => stage.integrationStatus !== 'local_staged')
      || publishes.at(-1)?.integrationStatus !== 'integrated') {
      throw new Error(`benchmark delivery failed: ${JSON.stringify({ stages, publishes })}`);
    }
    let active = 0;
    let peakChecks = 0;
    for (const event of [...events].sort((a, b) => a.at - b.at)) {
      active += event.event === 'start' ? 1 : -1;
      peakChecks = Math.max(peakChecks, active);
    }
    const holds = progress.filter((event) => event.phase === 'queue-ready').map((event) => {
      const released = progress.find((candidate) => candidate.phase === 'queue-released'
        && candidate.queue?.ticketId === event.queue?.ticketId && candidate.observedAt >= event.observedAt);
      return { started: event.observedAt, finished: released?.observedAt ?? null,
        waitMs: event.queue?.waitedMs ?? null, holdMs: released ? released.observedAt - event.observedAt : null };
    });
    const elapsedMs = Date.now() - started;
    // This retry is measured separately from the comparable stage/publish
    // workload. Old runtimes remove their terminal transaction and lack it.
    const cleanupRetries = [];
    for (const stage of stages) {
      const published = publishes.findLast((entry) => entry.batchId === stage.batchId);
      if ((published?.measurement.transactionVersion ?? 0) < 5) continue;
      const beforeRemote = await git(origin, ['rev-parse', 'develop']);
      const beforeEvents = await readFile(counter, 'utf8');
      const retry = await run(['cleanup', '--batch', stage.batchId, '--write']);
      const retryRemote = await git(origin, ['rev-parse', 'develop']);
      const unchangedChecks = beforeEvents === await readFile(counter, 'utf8');
      if (retry.integrationStatus !== 'integrated' || retry.pushed !== false
        || !unchangedChecks || beforeRemote !== retryRemote
        || retry.measurement.replayCount !== published.measurement.replayCount) {
        throw new Error(`cleanup retry changed delivery: ${JSON.stringify(retry)}`);
      }
      cleanupRetries.push({ elapsedMs: retry.elapsedMs, unchangedChecks,
        remoteHeadUnchanged: beforeRemote === retryRemote, pushed: retry.pushed,
        replayDelta: retry.measurement.replayCount - published.measurement.replayCount });
    }
    result = { scenario, iteration, elapsedMs, cleanupRetries,
      checkExecutions: events.filter((event) => event.event === 'start').length,
      checksInsideFifo: events.filter((event) => event.event === 'start'
        && holds.some((hold) => hold.finished !== null && event.at >= hold.started && event.at <= hold.finished)).length,
      holds, cleanup: publishes.at(-1)?.integrationStatus,
      peakChecks, stages, publishes, progress, events };
  } finally {
    if (previous.counter === undefined) delete process.env.VIBE_BENCH_COUNTER;
    else process.env.VIBE_BENCH_COUNTER = previous.counter;
    if (previous.block === undefined) delete process.env.VIBE_BENCH_BLOCK;
    else process.env.VIBE_BENCH_BLOCK = previous.block;
    await removeTemporaryDirectory(root);
  }
  return result;
}
const samples = [];
for (const scenario of options.scenario ? [options.scenario] : ['small', 'parallel', 'shared-resource', 'baseline-advance', 'interrupted']) {
  for (let iteration = 1; iteration <= repetitions; iteration++) {
    const result = await sample(scenario, iteration);
    samples.push(result);
    process.stderr.write(`${scenario} ${iteration}/${repetitions}: ${result.elapsedMs}ms, checks=${result.checkExecutions}\n`);
  }
}
const summary = Object.fromEntries([...new Set(samples.map((item) => item.scenario))].map((scenario) => {
  const values = samples.filter((item) => item.scenario === scenario);
  const times = values.map((item) => item.elapsedMs).sort((a, b) => a - b);
  return [scenario, { medianMs: times[Math.floor(times.length / 2)], maxMs: Math.max(...times),
    checkExecutions: values.map((item) => item.checkExecutions) }];
}));
const output = JSON.stringify({ schemaVersion: 1, runtime, node: process.version,
  platform: process.platform, repetitions, summary, samples }, null, 2) + '\n';
if (options.output) await writeFile(path.resolve(options.output), output);
else process.stdout.write(output);
