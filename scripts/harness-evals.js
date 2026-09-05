#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  analyzeTrace,
  buildReport,
  buildResultV3,
  compareResults,
  createBaseline,
  createCodexCliBackend,
  createFileTraceStore,
  createFixtureManager,
  createHarnessRunner,
  createScenarioVerifier,
  loadHarnessEvalCatalog,
  planHarnessEval,
  readTraceBundle,
  renderHtmlReport,
  renderMarkdownReport,
  selectScenariosForChanges,
} from '../harness-evals/lib/index.js';
import { cooperBenchAdapter, sweBenchAdapter, sweBenchLiveAdapter, terminalBenchAdapter } from '../harness-evals/external/index.js';
import { resolveEvalRuntime } from './lib/eval-runtime-config.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const command = process.argv[2] ?? 'check';

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const name = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) args[name] = true;
    else {
      args[name] = next;
      index += 1;
    }
  }
  return args;
}

function execute(program, args, cwd, environment = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env: environment, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      const output = Buffer.concat(stdout).toString('utf8');
      const diagnostic = Buffer.concat(stderr).toString('utf8');
      if (code === 0) resolve({ output, diagnostic });
      else reject(new Error(diagnostic.trim() || output.trim() || `${program} exited ${code}`));
    });
  });
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function requestedScenarios(args) {
  return typeof args.scenario === 'string' ? args.scenario.split(',').map((value) => value.trim()).filter(Boolean) : [];
}

async function hashPaths(relativePaths) {
  const hash = createHash('sha256');
  async function visit(relative) {
    const absolute = path.join(rootDir, relative);
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) {
        hash.update(child.replaceAll('\\', '/'));
        hash.update('\0');
        hash.update(await readFile(path.join(rootDir, child)));
        hash.update('\0');
      }
    }
  }
  for (const relative of relativePaths) await visit(relative);
  return hash.digest('hex');
}

async function externalContractCheck() {
  const definitions = [
    ['swe-bench/sample-manifest.json', sweBenchAdapter],
    ['swe-bench/live-sample-manifest.json', sweBenchLiveAdapter],
    ['terminal-bench/sample-manifest.json', terminalBenchAdapter],
    ['cooperbench/sample-manifest.json', cooperBenchAdapter],
  ];
  const tasks = [];
  for (const [relative, adapter] of definitions) {
    const manifest = await readJson(path.join(rootDir, 'harness-evals/external', relative));
    tasks.push(...adapter.discover(manifest).map((task) => ({ benchmark: task.benchmark, id: task.id, revision: task.datasetRevision })));
  }
  return tasks;
}

async function checkCommand() {
  const catalog = await loadHarnessEvalCatalog(rootDir);
  const externalTasks = await externalContractCheck();
  const schemaNames = ['harness-eval-scenario.schema.json', 'harness-eval-fixture.schema.json', 'harness-eval-result.schema.json'];
  for (const name of schemaNames) {
    const [canonical, documented] = await Promise.all([
      readFile(path.join(rootDir, 'schemas', name), 'utf8'),
      readFile(path.join(rootDir, 'docs/schemas', name), 'utf8'),
    ]);
    if (canonical !== documented) catalog.errors.push(`${name} differs from docs/schemas copy`);
  }
  const result = {
    schemaVersion: 1,
    status: catalog.errors.length === 0 ? 'passed' : 'failed',
    internalScenarios: catalog.scenarios.length,
    externalTasks,
    errors: catalog.errors,
  };
  console.log(JSON.stringify(result, null, 2));
  if (catalog.errors.length > 0) process.exitCode = 1;
}

async function planCommand(args, backendCapabilities) {
  const catalog = await loadHarnessEvalCatalog(rootDir);
  if (catalog.errors.length > 0) throw new Error(catalog.errors.join('\n'));
  const attemptLimit = args.attempts === undefined ? Number.POSITIVE_INFINITY : Number(args.attempts);
  if (!(attemptLimit > 0)) throw new Error('--attempts must be a positive integer');
  let scenarioIds = requestedScenarios(args);
  let impact = null;
  if (scenarioIds.length === 0 && typeof args.changed === 'string') {
    impact = selectScenariosForChanges({
      changedPaths: args.changed.split(',').map((value) => value.trim()).filter(Boolean),
      impactMap: await readJson(path.join(rootDir, 'harness-evals/regressions/impact-map.json')),
      allScenarioIds: catalog.scenarios.map((scenario) => scenario.id),
    });
    scenarioIds = impact.selectedScenarioIds;
  }
  const plan = planHarnessEval({
    scenarios: catalog.scenarios,
    tier: args.tier ?? 'fast',
    scenarioIds,
    backendCapabilities,
    attemptLimit,
  });
  return impact ? { ...plan, impact } : plan;
}

function blockedResult(scenario, entry, fingerprint, code = 'BACKEND_CAPABILITY_UNAVAILABLE') {
  return buildResultV3({
    scenario,
    attempts: [{ id: 'attempt-1', phase: 'regression', status: 'blocked' }],
    checks: [{
      id: `${scenario.id}-preflight`, category: 'infrastructure', severity: 'critical', status: 'blocked', code,
      evidence: { missingCapabilities: entry.missingCapabilities },
    }],
    fingerprint,
    failures: [{ taxonomy: 'Infrastructure Failure', code }],
  });
}

async function projectHarness({ fixture }) {
  await execute(process.execPath, [path.join(rootDir, 'scripts/vibe-harness.js'), 'init', '--project', fixture.agent.workspace, '--target', 'codex', '--profile', 'full', '--force'], rootDir);
  await execute(process.execPath, [
    path.join(rootDir, 'scripts/vibe-harness.js'), 'install', '--project', fixture.agent.workspace,
    '--target', 'codex', '--profile', 'full', '--write', '--allow-degraded', '--confirm-red-zone',
  ], rootDir);
}

async function runCommand(args) {
  let runtime;
  let runtimeError;
  try {
    runtime = await resolveEvalRuntime({ needsWrite: true, repetitions: Number(args.attempts ?? 1) });
  } catch (error) {
    runtimeError = error;
  }
  const backend = createCodexCliBackend({
    rootDir,
    resolveRuntime: async () => {
      if (runtimeError) throw runtimeError;
      return runtime;
    },
  });
  const plan = await planCommand(args, backend.capabilities);
  if (args['dry-run']) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  const catalog = await loadHarnessEvalCatalog(rootDir);
  const byId = new Map(catalog.scenarios.map((scenario) => [scenario.id, scenario]));
  const runId = `run-${new Date().toISOString().replace(/[^0-9A-Za-z]/gu, '-')}`;
  const outputDir = path.resolve(args['output-dir'] ?? path.join(rootDir, 'harness-evals/reports/generated', runId));
  const traceRoot = path.join(rootDir, 'harness-evals/traces/runs', runId);
  const harnessHash = await hashPaths(['docs/rules', 'skills/core', 'templates', 'adapters']);
  const results = [];
  for (const entry of plan.entries) {
    const scenario = byId.get(entry.scenarioId);
    const fixtureManifest = await readFile(path.resolve(path.join(rootDir, 'harness-evals/scenarios'), scenario.fixture.ref), 'utf8');
    const fingerprint = {
      measurement: {
        scenarioHash: createHash('sha256').update(JSON.stringify(scenario)).digest('hex'),
        fixtureHash: createHash('sha256').update(fixtureManifest).digest('hex'),
        model: runtime?.environment.CODEX_MODEL ?? 'unavailable',
        cli: runtime?.cliVersion ?? 'unavailable',
        backend: runtime?.backend ?? 'unavailable',
        platform: process.platform,
        architecture: process.arch,
        tier: plan.tier,
        repetitions: entry.scheduledAttempts,
      },
      harness: { aggregateHash: harnessHash },
    };
    if (entry.status === 'blocked' || entry.scheduledAttempts === 0) {
      results.push(blockedResult(
        scenario,
        entry,
        fingerprint,
        entry.status === 'blocked' ? 'BACKEND_CAPABILITY_UNAVAILABLE' : 'BUDGET_EXHAUSTED',
      ));
      continue;
    }
    const attempts = [];
    const checks = [];
    const traceRefs = [];
    for (let repetition = 1; repetition <= entry.scheduledAttempts; repetition += 1) {
      const runner = createHarnessRunner({
        backend,
        fixtureManager: createFixtureManager({ scenariosDir: catalog.scenariosDir, projectHarness }),
        verifier: createScenarioVerifier(),
        traceStore: createFileTraceStore(traceRoot),
      });
      let execution;
      try {
        execution = await runner.prepare({ scenario, fingerprint, condition: { tier: plan.tier }, budget: { attemptLimit: 1, wallTimeMs: Number(args['wall-time-ms'] ?? 600_000) } });
        await runner.run(execution.executionId, { phase: args.phase ?? 'regression' });
        const collected = await runner.collect(execution.executionId);
        const attemptId = `attempt-${repetition}`;
        attempts.push(...collected.attempts.map((attempt) => ({ ...attempt, id: attemptId })));
        checks.push(...collected.checks);
        traceRefs.push(...collected.evidence.trace.refs.map((ref) => ({ ...ref, attemptId })));
      } catch (error) {
        attempts.push({ id: `attempt-${repetition}`, phase: args.phase ?? 'regression', status: 'degraded', diagnostics: [error.message] });
        checks.push({ id: `${scenario.id}-infrastructure-${repetition}`, category: 'infrastructure', severity: 'critical', status: 'blocked', code: 'RUN_PREPARE_FAILED' });
      } finally {
        if (execution) await runner.cleanup(execution.executionId);
      }
    }
    results.push(buildResultV3({ scenario, attempts, checks, traceRefs, fingerprint }));
  }
  const report = buildReport({ title: `Harness Eval ${plan.tier}`, results });
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeJson(path.join(outputDir, 'results.json'), { schemaVersion: 1, runId, plan, results }),
    writeFile(path.join(outputDir, 'report.md'), renderMarkdownReport(report), 'utf8'),
    writeFile(path.join(outputDir, 'report.html'), renderHtmlReport(report), 'utf8'),
  ]);
  console.log(JSON.stringify({ runId, outputDir, plan: plan.summary, statuses: report.statuses }, null, 2));
  if (results.some((result) => result.status === 'failed')) process.exitCode = 1;
}

function resultsFrom(document) {
  if (Array.isArray(document)) return document;
  if (Array.isArray(document.results)) return document.results;
  if (document.schemaVersion === 3) return [document];
  throw new Error('input must contain Result v3 objects');
}

async function reportCommand(args) {
  if (!args.input) throw new Error('report requires --input <results.json>');
  const results = resultsFrom(await readJson(path.resolve(args.input)));
  const comparison = args.comparison ? await readJson(path.resolve(args.comparison)) : null;
  const report = buildReport({ title: args.title ?? 'Harness Eval Report', results, comparison });
  const format = args.format ?? 'markdown';
  const output = format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : format === 'html' ? renderHtmlReport(report) : renderMarkdownReport(report);
  if (args.output) {
    await mkdir(path.dirname(path.resolve(args.output)), { recursive: true });
    await writeFile(path.resolve(args.output), output, 'utf8');
  } else process.stdout.write(output);
}

async function baselineCommand(args) {
  if (!args.input || !args.id) throw new Error('baseline requires --input <results.json> --id <baseline-id>');
  const baseline = createBaseline({ id: args.id, results: resultsFrom(await readJson(path.resolve(args.input))) });
  if (args.output) await writeJson(path.resolve(args.output), baseline);
  else console.log(JSON.stringify(baseline, null, 2));
}

async function compareCommand(args) {
  if (!args.baseline || !args.current) throw new Error('compare requires --baseline <baseline.json> --current <results.json>');
  const comparison = compareResults({
    baseline: await readJson(path.resolve(args.baseline)),
    candidateResults: resultsFrom(await readJson(path.resolve(args.current))),
  });
  if (args.output) await writeJson(path.resolve(args.output), comparison);
  else console.log(JSON.stringify(comparison, null, 2));
}

async function analyzeCommand(args) {
  if (!args.trace || !args.result) throw new Error('analyze requires --trace <bundle-dir> --result <result.json>');
  const [bundle, document] = await Promise.all([readTraceBundle(path.resolve(args.trace)), readJson(path.resolve(args.result))]);
  const result = resultsFrom(document)[0];
  const analysis = analyzeTrace(bundle.trace, result.checks);
  if (args.output) await writeJson(path.resolve(args.output), analysis);
  else console.log(JSON.stringify(analysis, null, 2));
}

const args = parseArgs(process.argv.slice(3));
try {
  if (command === 'check') await checkCommand();
  else if (command === 'plan') {
    const backend = createCodexCliBackend({ rootDir });
    console.log(JSON.stringify(await planCommand(args, backend.capabilities), null, 2));
  } else if (command === 'run') await runCommand(args);
  else if (command === 'report') await reportCommand(args);
  else if (command === 'baseline') await baselineCommand(args);
  else if (command === 'compare') await compareCommand(args);
  else if (command === 'analyze') await analyzeCommand(args);
  else throw new Error(`unknown harness eval command: ${command}`);
} catch (error) {
  console.error(`Harness eval ${command} failed: ${error.message}`);
  process.exitCode = 1;
}
