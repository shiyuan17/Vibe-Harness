#!/usr/bin/env node
import { access, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readWorkflowBenchmark,
  selectWorkflowBenchmarkCases,
  validateWorkflowBenchmarkRun,
  workflowBenchmarkSuitePath,
} from './lib/workflow-benchmark.js';
import { runWorkflowAttempt, writeJsonAtomic } from './lib/workflow-benchmark-runner.js';

function argsFrom(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    if (!values[index].startsWith('--')) continue;
    result[values[index].slice(2)] = values[index + 1]?.startsWith('--') ? true : (values[index + 1] ?? true);
  }
  return result;
}

function positiveInteger(value, fallback, name) {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

async function readAttempts(file) {
  try {
    return (JSON.parse(await readFile(file, 'utf8')).attempts ?? []).map((attempt) => ({
      ...attempt,
      infrastructureFailure: attempt.infrastructureFailure === true
        || attempt.diagnostic === 'timeout'
        || (attempt.totalTokens === 0 && attempt.validation?.testsPassed !== true),
    }));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

const args = argsFrom(process.argv.slice(2));
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suiteName = String(args.suite ?? 'v1');
const suite = await readWorkflowBenchmark(workflowBenchmarkSuitePath(rootDir, suiteName));
const model = String(args.model ?? process.env.CODEX_MODEL ?? 'gpt-5.6-sol');
const reasoningEffort = String(args.reasoning ?? process.env.CODEX_REASONING_EFFORT ?? 'medium');
const agentVersion = String(args['agent-version'] ?? process.env.CODEX_CLI_VERSION ?? 'codex-cli');
const concurrency = positiveInteger(args.concurrency, 4, 'concurrency');
const timeoutMs = positiveInteger(args['timeout-ms'], 10 * 60 * 1000, 'timeout-ms');
const repetitions = args.smoke ? 1 : suite.repetitions;
const selected = selectWorkflowBenchmarkCases(suite, { smoke: Boolean(args.smoke) });
const configuredAuth = args['auth-file'] ?? process.env.COGNIS_EVAL_AUTH_FILE;
const sourceAuth = configuredAuth ? path.resolve(String(configuredAuth)) : null;
if (!sourceAuth && !process.env.OPENAI_API_KEY) {
  throw new Error('--auth-file, COGNIS_EVAL_AUTH_FILE, or OPENAI_API_KEY is required');
}
if (sourceAuth) await access(sourceAuth);
const runId = String(args['run-id'] ?? new Date().toISOString().replaceAll(/[:.]/gu, '-'));
const outputDir = path.resolve(args['output-dir'] ?? path.join(rootDir, '.cognis/evals/workflow-benchmark', runId));
await mkdir(outputDir, { recursive: true });
const authFile = sourceAuth;
const environment = {
  agent: agentVersion,
  model,
  multiTurn: suite.schemaVersion === 2,
  oneShotProject: true,
  reasoningEffort,
  runner: `cognis-workflow@${suite.schemaVersion}`,
  suite: suite.id,
  timeoutMs,
  tokenBudget: 'provider-default',
  tools: ['shell', 'apply_patch', 'hooks', 'multi-agent'],
};
const workflows = ['strict', 'adaptive'];
const files = Object.fromEntries(workflows.map((workflow) => [workflow, path.join(outputDir, `${workflow}.json`)]));
const runs = {};
for (const workflow of workflows) {
  runs[workflow] = {
    attempts: await readAttempts(files[workflow]),
    environment,
    ...(suite.schemaVersion === 2 ? { mode: args.smoke ? 'smoke' : 'full' } : {}),
    schemaVersion: suite.schemaVersion,
    workflow,
  };
}
const completed = new Set(workflows.flatMap((workflow) => runs[workflow].attempts
  .filter((attempt) => !attempt.infrastructureFailure)
  .map((attempt) => `${workflow}:${attempt.caseId}:${attempt.repetition}`)));
const jobs = [];
for (const item of selected) {
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const order = (selected.indexOf(item) + repetition) % 2 ? workflows : [...workflows].reverse();
    for (const workflow of order) {
      const key = `${workflow}:${item.id}:${repetition}`;
      if (!completed.has(key)) jobs.push({ item, repetition, workflow });
    }
  }
}
let cursor = 0;
let finished = completed.size;
let infrastructureStreak = 0;
let circuitOpen = false;
const total = selected.length * repetitions * workflows.length;
async function worker() {
  while (cursor < jobs.length && !circuitOpen) {
    const job = jobs[cursor];
    cursor += 1;
    const attempt = await runWorkflowAttempt({
      authFile,
      ...job,
      maxTurns: suite.maxTurns ?? 1,
      model,
      reasoningEffort,
      rootDir,
      suiteVersion: suite.schemaVersion,
      timeoutMs,
    });
    runs[job.workflow].attempts = runs[job.workflow].attempts.filter((existing) => (
      existing.caseId !== attempt.caseId || existing.repetition !== attempt.repetition
    ));
    runs[job.workflow].attempts.push(attempt);
    runs[job.workflow].attempts.sort((left, right) => left.caseId.localeCompare(right.caseId) || left.repetition - right.repetition);
    await writeJsonAtomic(files[job.workflow], runs[job.workflow]);
    if (attempt.infrastructureFailure) {
      infrastructureStreak += 1;
      if (infrastructureStreak >= concurrency) circuitOpen = true;
    } else {
      infrastructureStreak = 0;
      finished += 1;
    }
    const outcome = attempt.infrastructureFailure ? 'degraded' : (attempt.passed ? 'passed' : 'failed');
    process.stdout.write(`[${finished}/${total}] ${job.workflow} ${job.item.id}#${job.repetition} ${outcome} ${attempt.wallTimeMs}ms\n`);
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length || 1) }, () => worker()));
const infrastructureFailures = workflows.flatMap((workflow) => runs[workflow].attempts.filter((attempt) => attempt.infrastructureFailure));
if (infrastructureFailures.length > 0) {
  throw new Error(`Workflow benchmark has ${infrastructureFailures.length} infrastructure failure(s); resume the same run id.`);
}
if (!args.smoke) {
  for (const workflow of workflows) validateWorkflowBenchmarkRun(runs[workflow], suite);
}
await writeJsonAtomic(path.join(outputDir, 'run.json'), {
  adaptive: path.basename(files.adaptive),
  completedAt: new Date().toISOString(),
  mode: args.smoke ? 'smoke' : 'full',
  suite: suite.id,
  strict: path.basename(files.strict),
});
process.stdout.write(`${JSON.stringify({
  adaptive: files.adaptive,
  mode: args.smoke ? 'smoke' : 'full',
  outputDir,
  strict: files.strict,
  suite: suite.id,
})}\n`);
