import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { validateEvalSuiteSemantics } from './eval-contract.js';
import { buildOfflineRun, suiteHash } from './eval-replay.js';
import { aggregateCaseScores, compareFingerprints } from './eval-scoring.js';
import { runEvaluationCase } from './eval-runner.js';
import { backupFile, createBackupId } from './install-state.js';
import {
  assertInsideDir,
  assertPortableRelativePath,
  pathExists,
  readJson,
  validateJsonAgainstSchema,
} from './manifest.js';

function evalError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function resolveProjectPath(targetDir, relative, label) {
  assertPortableRelativePath(relative, label);
  const target = path.resolve(targetDir, relative);
  assertInsideDir(targetDir, target, label);
  let current = targetDir;
  for (const segment of path.relative(targetDir, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw evalError('EVAL_PATH_UNSAFE', `${label} must not traverse a symbolic link`);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
  return target;
}

function runArtifactPath(now, suffix = '') {
  const timestamp = now.toISOString().replaceAll(':', '-').replaceAll('.', '-');
  return `.loopengine/evals/runs/${timestamp}${suffix}.json`;
}

async function writeProjectJson({ targetDir, relative, label, value }) {
  const target = await resolveProjectPath(targetDir, relative, label);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const GOVERNANCE_PATHS = [
  '.agents/loopengine/evals',
  '.agents/loopengine/governance',
  '.agents/loopengine/hooks',
  '.agents/skills',
  '.codex/hooks.json',
  'adapters',
  'AGENTS.md',
  'CLAUDE.md',
  'docs/rules',
  'docs/schemas',
  'docs/templates',
  'GEMINI.md',
  'manifests',
  'rules',
  'runtime/evals',
  'runtime/hooks',
  'schemas',
  'skills/core',
  'templates',
];

async function governanceFiles(root, relative) {
  const absolute = path.join(root, relative);
  try {
    if ((await lstat(absolute)).isSymbolicLink()) {
      throw evalError('EVAL_PATH_UNSAFE', `governance hash path must not be a symbolic link: ${relative}`);
    }
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOTDIR') return [{ absolute, relative: relative.replaceAll('\\', '/') }];
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) continue;
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await governanceFiles(root, child));
    else if (entry.isFile()) files.push({ absolute: path.join(root, child), relative: child.replaceAll('\\', '/') });
  }
  return files;
}

async function governanceHash(root) {
  const files = (await Promise.all(GOVERNANCE_PATHS.map((relative) => governanceFiles(root, relative))))
    .flat()
    .sort((left, right) => left.relative.localeCompare(right.relative));
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.relative);
    hash.update('\0');
    hash.update(await readFile(file.absolute));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function loadSchemas(rootDir) {
  const [suite, run, reference] = await Promise.all([
    readJson(path.join(rootDir, 'schemas/eval-suite.schema.json')),
    readJson(path.join(rootDir, 'schemas/eval-run.schema.json')),
    readJson(path.join(rootDir, 'schemas/eval-reference.schema.json')),
  ]);
  return { suite, run, reference };
}

async function selectSuites({ config, rootDir, suiteId, targetDir }) {
  const schemas = await loadSchemas(rootDir);
  const suites = [];
  for (const relative of config.evaluations.suites) {
    const suite = await readJson(await resolveProjectPath(targetDir, relative, 'evaluation suite'));
    const errors = [
      ...validateJsonAgainstSchema(suite, schemas.suite, relative),
      ...validateEvalSuiteSemantics(suite),
    ];
    if (errors.length > 0) throw evalError('EVAL_CONTRACT_INVALID', errors.join('\n'));
    suites.push({ path: relative, suite });
  }
  const selected = suiteId ? suites.filter((item) => item.suite.id === suiteId) : suites;
  if (selected.length === 0) throw evalError('EVAL_SUITE_NOT_FOUND', `Evaluation suite not found: ${suiteId ?? '<configured>'}`);
  return { schemas, suites: selected };
}

function thresholdFailures(run, reference, thresholds) {
  const failures = [];
  if (run.criticalPassRate < thresholds.criticalPassRate) failures.push('critical pass rate is below threshold');
  if (run.overallScore < thresholds.overallScore) failures.push('overall score is below threshold');
  if (!reference) return { degraded: ['evaluation reference is missing'], failures };
  const fingerprint = compareFingerprints(run.fingerprint, reference.fingerprint);
  if (!fingerprint.match) return { degraded: fingerprint.mismatches.map((item) => `fingerprint mismatch: ${item.field}`), failures };
  const referenceCapabilities = new Map(reference.capabilities.map((item) => [item.id, item.score]));
  for (const capability of run.capabilities) {
    const previous = referenceCapabilities.get(capability.id);
    if (typeof previous === 'number' && previous - capability.score > thresholds.maxCapabilityRegression) {
      failures.push(`capability regression exceeds threshold: ${capability.id}`);
    }
  }
  return { degraded: [], failures };
}

async function buildOnlineRun({ command, config, now, suite, suitePath, targetDir }) {
  if (!command) return { degraded: ['Online evaluation runner is not configured.'], run: null };
  const runGovernanceHash = await governanceHash(targetDir);
  const results = [];
  const observations = [];
  const degraded = [];
  const caseRepetitions = [];
  for (const definition of suite.cases) {
    const repetitions = Math.min(definition.repetitions ?? config.evaluations.repetitions, config.evaluations.repetitions);
    caseRepetitions.push({ id: definition.id, count: repetitions });
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      const result = await runEvaluationCase({
        command,
        definition,
        governanceHash: runGovernanceHash,
        repetition,
        runId: `${suite.id}-${now.toISOString()}`,
      });
      if (result.status !== 'ready') {
        degraded.push(...result.diagnostics.map((item) => `${definition.id}: ${item}`));
        return { degraded, run: null };
      }
      observations.push(result.observation);
      results.push(result.caseResult);
    }
  }
  if (degraded.length > 0 || results.length === 0) return { degraded, run: null };
  const first = observations[0];
  const fingerprint = {
    suiteHash: suiteHash(suite),
    runner: first.runner,
    model: first.model,
    agent: first.agentVersion,
    governanceHash: first.governanceHash,
  };
  for (const observation of observations.slice(1)) {
    const current = {
      suiteHash: fingerprint.suiteHash,
      runner: observation.runner,
      model: observation.model,
      agent: observation.agentVersion,
      governanceHash: observation.governanceHash,
    };
    if (!compareFingerprints(current, fingerprint).match) return { degraded: ['runner fingerprint changed within the evaluation run'], run: null };
  }
  const aggregate = aggregateCaseScores(results);
  return {
    degraded: [],
    run: {
      schemaVersion: 1,
      id: `${suite.id}-online-${now.toISOString()}`,
      generatedAt: now.toISOString(),
      suite: { id: suite.id, version: suite.version, hash: fingerprint.suiteHash, path: suitePath },
      mode: 'online',
      status: results.every((item) => item.passed) ? 'passed' : 'failed',
      fingerprint,
      caseRepetitions,
      cases: results,
      capabilities: aggregate.capabilities,
      overallScore: aggregate.overallScore,
      criticalPassRate: aggregate.criticalPassRate,
      diagnostics: [],
    },
  };
}

export async function checkProjectEvaluations({ config, rootDir, suiteId, targetDir }) {
  if (!config.evaluations?.enabled) throw evalError('EVAL_DISABLED', 'Project evaluations are disabled.');
  const selected = await selectSuites({ config, rootDir, suiteId, targetDir });
  return {
    ok: true,
    status: 'ready',
    suites: selected.suites.map((item) => ({ id: item.suite.id, path: item.path, version: item.suite.version })),
  };
}

export async function runProjectEvaluations({ config, mode, now = new Date(), reference: referenceOverride, rootDir, runner, suiteId, targetDir, write = false }) {
  if (!['offline', 'online'].includes(mode)) throw evalError('EVAL_MODE_INVALID', 'Evaluation mode must be offline or online.');
  const selected = await selectSuites({ config, rootDir, suiteId, targetDir });
  if (selected.suites.length !== 1) throw evalError('EVAL_SUITE_REQUIRED', 'Select exactly one suite with --suite.');
  const { path: suitePath, suite } = selected.suites[0];
  const online = mode === 'online'
    ? await buildOnlineRun({ command: runner ?? config.evaluations.onlineRunner, config, now, suite, suitePath, targetDir })
    : null;
  if (online?.degraded.length > 0 || (mode === 'online' && !online?.run)) {
    const warnings = online?.degraded ?? ['Online evaluation runner is unavailable.'];
    const written = [];
    if (write) {
      const relative = runArtifactPath(now, '.degraded');
      await writeProjectJson({
        targetDir,
        relative,
        label: 'degraded evaluation diagnostic',
        value: { schemaVersion: 1, generatedAt: now.toISOString(), status: 'degraded', diagnostics: warnings },
      });
      written.push(relative);
    }
    return { dryRun: !write, ok: false, status: 'degraded', warnings, written };
  }
  const run = online?.run ?? buildOfflineRun(suite, {
    generatedAt: now.toISOString(),
    id: `${suite.id}-offline-${now.toISOString()}`,
    suitePath,
  });
  const referenceRelative = referenceOverride ?? config.evaluations.reference;
  const referencePath = await resolveProjectPath(targetDir, referenceRelative, 'evaluation reference');
  const reference = await pathExists(referencePath) ? await readJson(referencePath) : null;
  if (reference) {
    const referenceErrors = validateJsonAgainstSchema(reference, selected.schemas.reference, referenceRelative);
    if (referenceErrors.length > 0) throw evalError('EVAL_CONTRACT_INVALID', referenceErrors.join('\n'));
  }
  const comparison = thresholdFailures(run, reference, config.evaluations.thresholds);
  const thresholdRejected = comparison.failures.length > 0 || run.status === 'failed';
  const persistedRun = {
    ...run,
    status: thresholdRejected ? 'failed' : run.status,
    reference: {
      path: referenceRelative,
      status: !reference ? 'missing' : (comparison.degraded.length > 0 ? 'mismatched' : 'matched'),
    },
    diagnostics: [...run.diagnostics, ...comparison.failures, ...comparison.degraded],
  };
  const status = thresholdRejected ? 'invalid' : (comparison.degraded.length > 0 ? 'degraded' : 'ready');
  const written = [];
  if (write) {
    const relative = runArtifactPath(now);
    await writeProjectJson({ targetDir, relative, label: 'evaluation run', value: persistedRun });
    written.push(relative);
  }
  return {
    diagnostics: [...comparison.failures, ...comparison.degraded],
    dryRun: !write,
    ok: status === 'ready',
    run: persistedRun,
    status,
    warnings: comparison.degraded,
    written,
  };
}

function referenceFromRun(run, approvedAt) {
  return {
    schemaVersion: 1,
    id: `${run.suite.id}-${run.mode}-reference`,
    approvedAt: approvedAt.toISOString(),
    suite: { id: run.suite.id, version: run.suite.version },
    mode: run.mode,
    fingerprint: run.fingerprint,
    capabilities: run.capabilities,
    overallScore: run.overallScore,
    criticalPassRate: run.criticalPassRate,
  };
}

export async function writeProjectEvaluationReference({ config, force = false, from, now = new Date(), rootDir, targetDir, write = false }) {
  const schemas = await loadSchemas(rootDir);
  const runPath = await resolveProjectPath(targetDir, from, 'evaluation run source');
  const run = await readJson(runPath);
  const runErrors = validateJsonAgainstSchema(run, schemas.run, from);
  if (runErrors.length > 0) throw evalError('EVAL_CONTRACT_INVALID', runErrors.join('\n'));
  if (!config.evaluations.suites.includes(run.suite.path)) {
    throw evalError('EVAL_REFERENCE_REJECTED', 'Evaluation reference source must use a suite configured by this project.');
  }
  const suitePath = await resolveProjectPath(targetDir, run.suite.path, 'evaluation reference suite');
  const suite = await readJson(suitePath);
  const suiteErrors = [
    ...validateJsonAgainstSchema(suite, schemas.suite, run.suite.path),
    ...validateEvalSuiteSemantics(suite),
  ];
  const hash = suiteHash(suite);
  if (suiteErrors.length > 0
    || run.suite.id !== suite.id
    || run.suite.version !== suite.version
    || run.suite.hash !== hash
    || run.fingerprint.suiteHash !== hash) {
    throw evalError('EVAL_REFERENCE_REJECTED', 'Evaluation reference source does not match its configured suite contract.');
  }
  if (run.status !== 'passed'
    || run.criticalPassRate < config.evaluations.thresholds.criticalPassRate
    || run.overallScore < config.evaluations.thresholds.overallScore) {
    throw evalError('EVAL_REFERENCE_REJECTED', 'Evaluation reference requires a passed run that meets the configured absolute thresholds.');
  }
  const reference = referenceFromRun(run, now);
  const referenceErrors = validateJsonAgainstSchema(reference, schemas.reference, config.evaluations.reference);
  if (referenceErrors.length > 0) throw evalError('EVAL_CONTRACT_INVALID', referenceErrors.join('\n'));
  const target = await resolveProjectPath(targetDir, config.evaluations.reference, 'evaluation reference');
  const exists = await pathExists(target);
  if (write && exists && !force) throw evalError('EVAL_REFERENCE_CONFLICT', 'Evaluation reference exists; pass --force to back it up and replace it.');
  const backups = [];
  if (write) {
    if (exists) backups.push({ target: config.evaluations.reference, backup: await backupFile({ backupId: createBackupId(now), target, targetDir }) });
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(reference, null, 2)}\n`, 'utf8');
  }
  return {
    backups,
    dryRun: !write,
    ok: true,
    reference,
    status: 'ready',
    written: write ? [config.evaluations.reference] : [],
  };
}
