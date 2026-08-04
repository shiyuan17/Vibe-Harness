import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { validateEvalSuiteSemantics } from './eval-contract.js';
import { combineEvalConfigHash } from './eval-runtime-config.js';
import { summarizeTrials } from './eval-trials.js';
import { buildOfflineRun, suiteHash } from './eval-replay.js';
import { aggregateCaseScores, compareFingerprints } from './eval-scoring.js';
import { runEvaluationCase } from './eval-runner.js';
import { createJudge } from './eval-judge.js';
import { backupFile, createBackupId } from './install-state.js';
import {
  assertInsideDir,
  assertPortableRelativePath,
  assertSafePathInside,
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
  await assertSafePathInside(targetDir, target, label);
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
  return `.vibe-harness/evals/runs/${timestamp}${suffix}.json`;
}

async function writeProjectJson({ targetDir, relative, label, value }) {
  const target = await resolveProjectPath(targetDir, relative, label);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const CONFIG_PATHS = [
  '.agents/runtime/evals',
  '.agents/runtime/hooks',
  '.agents/skills',
  '.codex/hooks.json',
  '.cursor/hooks.json',
  '.cursor/mcp.json',
  '.mcp.json',
  '.qoder/settings.json',
  '.zcode/config.json',
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

async function configFiles(root, relative) {
  const absolute = path.join(root, relative);
  try {
    if ((await lstat(absolute)).isSymbolicLink()) {
      throw evalError('EVAL_PATH_UNSAFE', `config hash path must not be a symbolic link: ${relative}`);
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
    if (entry.isDirectory()) files.push(...await configFiles(root, child));
    else if (entry.isFile()) files.push({ absolute: path.join(root, child), relative: child.replaceAll('\\', '/') });
  }
  return files;
}

async function configHash(root) {
  const files = (await Promise.all(CONFIG_PATHS.map((relative) => configFiles(root, relative))))
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

async function buildOnlineRun({ campaignId, command, config, now, suite, suitePath, targetDir }) {
  if (!command) return {
    attemptSummary: { eligibleLegalWriteTrials: 0, infrastructureFailures: 1, readyTrials: 0, safetyFalsePositiveTrials: 0, startedTrials: 0 },
    degraded: ['Online evaluation runner is not configured.'],
    run: null,
  };
  const runConfigHash = combineEvalConfigHash(
    await configHash(targetDir),
    process.env.VIBE_HARNESS_EVAL_RUNTIME_HASH,
  );
  // Create a judge client only when the suite actually contains llmRubrics
  // assertions, so suites without judge assertions never require credentials.
  const needsJudge = suite.cases.some((item) => item.oracle?.llmRubrics?.length > 0);
  let judge = null;
  if (needsJudge) {
    try {
      judge = createJudge({ defaultModel: config.evaluations?.judgeModel });
    } catch (error) {
      return { degraded: [error.message], run: null };
    }
  }
  const observations = [];
  const degraded = [];
  const caseRepetitions = [];
  const trialsByCase = new Map();
  let eligibleLegalWriteTrials = 0;
  for (const definition of suite.cases) {
    const repetitions = Math.min(definition.repetitions ?? config.evaluations.repetitions, config.evaluations.repetitions);
    caseRepetitions.push({ id: definition.id, count: repetitions });
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      const legalWriteEligible = (definition.input?.fixture?.allowedWritePaths ?? []).length > 0;
      if (legalWriteEligible) eligibleLegalWriteTrials += 1;
      const result = await runEvaluationCase({
        command,
        definition,
        configHash: runConfigHash,
        repetition,
        runId: campaignId,
        judge,
      });
      if (result.status !== 'ready') {
        degraded.push(...result.diagnostics.map((item) => `${definition.id}: ${item}`));
        const safetyFalsePositive = (definition.input?.fixture?.allowedWritePaths ?? []).length > 0
          && result.diagnostics.some((item) => /sandbox-write-denied|policy-denied|workspace execution backend is unavailable/iu.test(item));
        return {
          attemptSummary: {
            eligibleLegalWriteTrials,
            infrastructureFailures: 1,
            readyTrials: observations.length,
            safetyFalsePositiveTrials: safetyFalsePositive ? 1 : 0,
            startedTrials: observations.length + 1,
          },
          degraded,
          run: null,
        };
      }
      observations.push(result.observation);
      const group = trialsByCase.get(definition.id) ?? [];
      group.push({ caseResult: result.caseResult, observation: result.observation });
      trialsByCase.set(definition.id, group);
    }
  }
  const results = suite.cases.map((definition) => trialsByCase.get(definition.id)[0].caseResult);
  if (degraded.length > 0 || results.length === 0) return { degraded, run: null };
  const first = observations[0];
  const fingerprint = {
    suiteHash: suiteHash(suite),
    runner: first.runner,
    model: first.model,
    agent: first.agentVersion,
    configHash: first.configHash,
  };
  const runtime = first.runtime;
  for (const observation of observations.slice(1)) {
    const current = {
      suiteHash: fingerprint.suiteHash,
      runner: observation.runner,
      model: observation.model,
      agent: observation.agentVersion,
      configHash: observation.configHash,
    };
    if (!compareFingerprints(current, fingerprint).match) return { degraded: ['runner fingerprint changed within the evaluation run'], run: null };
    if (JSON.stringify(observation.runtime ?? null) !== JSON.stringify(runtime ?? null)) {
      return { degraded: ['runner runtime changed within the evaluation run'], run: null };
    }
  }
  const aggregate = aggregateCaseScores(results);
  const trialSummaries = suite.cases.map((definition) => summarizeTrials(definition.id, trialsByCase.get(definition.id)));
  const reliabilityDiagnostics = trialSummaries
    .filter((item) => item.passCaretK === 0)
    .map((item) => `reliability variance: ${item.caseId} passed ${item.passedTrials}/${item.repetitions} trials`);
  return {
    attemptSummary: {
      eligibleLegalWriteTrials,
      infrastructureFailures: 0,
      readyTrials: observations.length,
      safetyFalsePositiveTrials: 0,
      startedTrials: observations.length,
    },
    degraded: [],
    run: {
      schemaVersion: 1,
      campaignId,
      id: `${suite.id}-online-${now.toISOString()}`,
      generatedAt: now.toISOString(),
      suite: { id: suite.id, version: suite.version, hash: fingerprint.suiteHash, path: suitePath },
      mode: 'online',
      status: results.every((item) => item.passed || item.flakyFailure) ? 'passed' : 'failed',
      fingerprint,
      ...(runtime ? { runtime } : {}),
      caseRepetitions,
      cases: results,
      trialSummaries,
      attemptSummary: {
        eligibleLegalWriteTrials,
        infrastructureFailures: 0,
        readyTrials: observations.length,
        safetyFalsePositiveTrials: 0,
        startedTrials: observations.length,
      },
      capabilities: aggregate.capabilities,
      overallScore: aggregate.overallScore,
      criticalPassRate: aggregate.criticalPassRate,
      diagnostics: reliabilityDiagnostics,
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

export async function runProjectEvaluations({ campaignId = `campaign-${Date.now()}`, config, mode, now = new Date(), reference: referenceOverride, rootDir, runner, suiteId, targetDir, write = false }) {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(campaignId)) throw evalError('EVAL_CAMPAIGN_INVALID', 'Evaluation campaign id must contain only portable identifier characters.');
  if (!['offline', 'online'].includes(mode)) throw evalError('EVAL_MODE_INVALID', 'Evaluation mode must be offline or online.');
  const selected = await selectSuites({ config, rootDir, suiteId, targetDir });
  if (selected.suites.length !== 1) throw evalError('EVAL_SUITE_REQUIRED', 'Select exactly one suite with --suite.');
  const { path: suitePath, suite } = selected.suites[0];
  const online = mode === 'online'
    ? await buildOnlineRun({ campaignId, command: runner ?? config.evaluations.onlineRunner, config, now, suite, suitePath, targetDir })
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
        value: {
          schemaVersion: 1,
          campaignId,
          generatedAt: now.toISOString(),
          status: 'degraded',
          suite: { id: suite.id, version: suite.version, hash: suiteHash(suite), path: suitePath },
          runtime: {
            backend: process.env.VIBE_HARNESS_EVAL_CODEX_BACKEND ?? 'native',
            provider: process.env.VIBE_HARNESS_EVAL_PROVIDER_NAME ?? 'default',
            reasoningEffort: process.env.CODEX_REASONING_EFFORT ?? 'medium',
            wireApi: process.env.VIBE_HARNESS_EVAL_PROVIDER_WIRE_API ?? 'responses',
          },
          fingerprint: {
            suiteHash: suiteHash(suite),
            runner: `codex-reference@2-${process.env.VIBE_HARNESS_EVAL_CODEX_BACKEND ?? 'native'}`,
            model: process.env.CODEX_MODEL ?? 'unavailable',
            agent: process.env.CODEX_CLI_VERSION ?? 'unavailable',
            configHash: process.env.VIBE_HARNESS_EVAL_RUNTIME_HASH ?? 'unavailable',
          },
          diagnostics: warnings,
          ...(online?.attemptSummary ? { attemptSummary: online.attemptSummary } : {}),
        },
      });
      written.push(relative);
    }
    return { dryRun: !write, ok: false, status: 'degraded', warnings, written };
  }
  const run = online?.run ?? await buildOfflineRun(suite, {
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
