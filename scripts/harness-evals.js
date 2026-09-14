#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  analyzeTrace,
  buildReport,
  buildResultV3,
  compareResults,
  createBaseline,
  createCodexCliBackend,
  ADVANCED_CODEX_CAPABILITIES,
  DEFAULT_CODEX_CAPABILITIES,
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
import { canonicalAssetBytes } from './lib/eval-assets.js';
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

function scenarioWallTimeMs(scenario, args) {
  if (args['wall-time-ms'] !== undefined) {
    const value = Number(args['wall-time-ms']);
    if (!Number.isInteger(value) || value <= 0) throw new Error('--wall-time-ms must be a positive integer');
    return value;
  }
  return ['H16', 'H18'].includes(scenario.id) ? 1_200_000 : 600_000;
}

async function hashPaths(baseDir, relativePaths) {
  const hash = createHash('sha256');
  async function visit(relative) {
    const absolute = path.join(baseDir, relative);
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) {
        hash.update(child.replaceAll('\\', '/'));
        hash.update('\0');
        hash.update(canonicalAssetBytes(await readFile(path.join(baseDir, child))));
        hash.update('\0');
      }
    }
  }
  for (const relative of relativePaths) await visit(relative);
  return hash.digest('hex');
}

async function resolveHarnessExperiment(args) {
  const phase = args.phase ?? 'regression';
  if (!['red', 'green', 'pressure', 'regression'].includes(phase)) {
    throw new Error('--phase must be red, green, pressure, or regression');
  }
  if (phase === 'red' && typeof args['harness-ref'] !== 'string') {
    throw new Error('--harness-ref is required for a RED run');
  }
  const harnessRef = args['harness-ref'] ?? 'HEAD';
  const [harnessRevision, currentRevision] = await Promise.all([
    execute('git', ['rev-parse', `${harnessRef}^{commit}`], rootDir).then((result) => result.output.trim()),
    execute('git', ['rev-parse', 'HEAD'], rootDir).then((result) => result.output.trim()),
  ]);
  if (phase === 'red' && harnessRevision === currentRevision) {
    throw new Error('--harness-ref for a RED run must resolve to a pre-change revision, not HEAD');
  }
  return { phase, harnessRef, harnessRevision, currentRevision };
}

async function prepareHarnessSource(experiment) {
  if (experiment.harnessRevision === experiment.currentRevision) {
    return { root: rootDir, async cleanup() {} };
  }
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'vibe-harness-eval-source-'));
  const checkout = path.join(temporaryRoot, 'checkout');
  let added = false;
  try {
    await execute('git', ['worktree', 'add', '--detach', checkout, experiment.harnessRevision], rootDir);
    added = true;
    const modules = path.join(rootDir, 'node_modules');
    await access(modules);
    await symlink(modules, path.join(checkout, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    return {
      root: checkout,
      async cleanup() {
        try {
          await execute('git', ['worktree', 'remove', '--force', checkout], rootDir);
        } finally {
          await rm(temporaryRoot, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    if (added) {
      try { await execute('git', ['worktree', 'remove', '--force', checkout], rootDir); } catch {}
    }
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

async function externalContractCheck() {
  /** @type {Array<[string, {discover: (manifest: any) => any[]}]>} */
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

function blockedResult(scenario, entry, fingerprint, phase, code = 'BACKEND_CAPABILITY_UNAVAILABLE') {
  return buildResultV3({
    scenario,
    attempts: [{ id: 'attempt-1', phase, status: 'blocked' }],
    checks: [{
      id: `${scenario.id}-preflight`, category: 'infrastructure', severity: 'critical', status: 'blocked', code,
      evidence: { missingCapabilities: entry.missingCapabilities },
    }],
    fingerprint,
    failures: [{ taxonomy: 'Infrastructure Failure', code }],
  });
}

async function projectHarness(harnessRoot, { fixture }) {
  await execute(process.execPath, [path.join(harnessRoot, 'scripts/vibe-harness.js'), 'init', '--project', fixture.agent.workspace, '--target', 'codex', '--profile', 'full', '--force'], harnessRoot);
  await execute(process.execPath, [
    path.join(harnessRoot, 'scripts/vibe-harness.js'), 'install', '--project', fixture.agent.workspace,
    '--target', 'codex', '--profile', 'full', '--write', '--allow-degraded', '--confirm-red-zone',
  ], harnessRoot);
}

async function runCommand(args) {
  const experiment = await resolveHarnessExperiment(args);
  let runtime;
  let runtimeError;
  try {
    runtime = await resolveEvalRuntime({ needsWrite: true, repetitions: Number(args.attempts ?? 1) });
  } catch (error) {
    runtimeError = error;
  }
  const linuxCodex = runtime?.backend === 'wsl'
    && !String(runtime.environment.VIBE_HARNESS_WSL_CODEX_COMMAND ?? '').toLowerCase().endsWith('.exe');
  const backend = createCodexCliBackend({
    rootDir,
    capabilities: linuxCodex
      ? [...DEFAULT_CODEX_CAPABILITIES, ...ADVANCED_CODEX_CAPABILITIES]
      : DEFAULT_CODEX_CAPABILITIES,
    resolveRuntime: async () => {
      if (runtimeError) throw runtimeError;
      return runtime;
    },
  });
  const plan = await planCommand(args, backend.capabilities);
  if (args['dry-run']) {
    console.log(JSON.stringify({ ...plan, experiment }, null, 2));
    return;
  }
  const harnessSource = await prepareHarnessSource(experiment);
  try {
  const catalog = await loadHarnessEvalCatalog(rootDir);
  const byId = new Map(catalog.scenarios.map((scenario) => [scenario.id, scenario]));
  const runId = `run-${new Date().toISOString().replace(/[^0-9A-Za-z]/gu, '-')}`;
  const outputDir = path.resolve(args['output-dir'] ?? path.join(rootDir, 'harness-evals/reports/generated', runId));
  const traceRoot = path.join(rootDir, 'harness-evals/traces/runs', runId);
  const harnessHash = await hashPaths(harnessSource.root, ['docs/rules', 'skills/core', 'templates', 'adapters']);
  const results = [];
  for (const entry of plan.entries) {
    const scenario = byId.get(entry.scenarioId);
    const requestedPressure = experiment.phase === 'pressure'
      ? scenario.phase.pressure.find((candidate) => candidate.id === args.pressure)
        ?? (args.pressure ? null : scenario.phase.pressure[0])
      : null;
    if (experiment.phase !== 'pressure' && args.pressure) throw new Error('--pressure requires --phase pressure');
    if (experiment.phase === 'pressure' && !requestedPressure) {
      throw new Error(`unknown pressure id for ${scenario.id}: ${args.pressure}`);
    }
    const fixtureManifest = await readFile(path.resolve(path.join(rootDir, 'harness-evals/scenarios'), scenario.fixture.ref), 'utf8');
    const wallTimeMs = scenarioWallTimeMs(scenario, args);
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
        phase: experiment.phase,
        pressureId: requestedPressure?.id ?? null,
        wallTimeMs,
      },
      harness: {
        aggregateHash: harnessHash,
        ref: experiment.harnessRef,
        revision: experiment.harnessRevision,
      },
    };
    if (entry.status === 'blocked' || entry.scheduledAttempts === 0) {
      results.push(blockedResult(
        scenario,
        entry,
        fingerprint,
        experiment.phase,
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
        fixtureManager: createFixtureManager({
          scenariosDir: catalog.scenariosDir,
          projectHarness: (context) => projectHarness(harnessSource.root, /** @type {{fixture: any}} */ (context)),
        }),
        verifier: createScenarioVerifier(),
        traceStore: createFileTraceStore(traceRoot),
      });
      let execution;
      try {
        execution = await runner.prepare({ scenario, fingerprint, condition: { tier: plan.tier, pressure: requestedPressure }, budget: { attemptLimit: 1, wallTimeMs } });
        await runner.run(execution.executionId, { phase: experiment.phase, pressure: requestedPressure });
        const collected = await runner.collect(execution.executionId);
        const attemptId = `attempt-${repetition}`;
        attempts.push(...collected.attempts.map((attempt) => ({ ...attempt, id: attemptId })));
        checks.push(...collected.checks);
        traceRefs.push(...collected.evidence.trace.refs.map((ref) => ({ ...ref, attemptId })));
      } catch (error) {
        attempts.push({ id: `attempt-${repetition}`, phase: experiment.phase, status: 'degraded', diagnostics: [error.message] });
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
  } finally {
    await harnessSource.cleanup();
  }
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
