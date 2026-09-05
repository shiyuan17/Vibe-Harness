import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

import { redactTraceValue } from '../traces/atif.js';

const OUTPUT_LIMIT = 1024 * 1024;

export async function executeOfficialPlan(plan, { timeoutMs = 60 * 60_000, environment = process.env } = {}) {
  if (!plan || plan.dryRun !== true || plan.shell !== false || plan.maxConcurrency !== 1) {
    throw new Error('official plan must be a validated one-concurrency, shell-free dry-run plan');
  }
  await mkdir(plan.outputDir, { recursive: true });
  const started = process.hrtime.bigint();
  return new Promise((resolve) => {
    const child = spawn(plan.program, plan.args, {
      cwd: plan.cwd,
      env: { ...environment, ...plan.env },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let settled = false;
    const append = (current, chunk) => Buffer.concat([current, chunk]).subarray(0, OUTPUT_LIMIT);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const finish = (exitCode, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(redactTraceValue({
        schemaVersion: 1,
        runId: plan.runId,
        cacheKey: plan.cacheKey,
        status: timedOut ? 'timed-out' : exitCode === 0 ? 'completed' : 'failed',
        exitCode: timedOut ? 124 : exitCode,
        durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
        stdout: stdout.toString('utf8'),
        stderr: spawnError?.message ?? stderr.toString('utf8'),
      }));
    };
    child.once('error', (error) => finish(null, error));
    child.once('close', (code) => finish(code ?? 1));
  });
}
