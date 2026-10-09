import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createEvalAssetFingerprint } from './eval-assets.js';
import { aggregateCaseScores, scoreCase } from './eval-scoring.js';
import { backupFile, createBackupId } from './install-state.js';
import { pathExists } from './manifest.js';

// The checked-in offline run is the deterministic replay of the core suite. It
// embeds the same asset fingerprint as the approved reference, so regenerating
// it is part of the documented reference update flow instead of a hand-run
// replay of buildOfflineRun().
export const OFFLINE_RESULT_PATH = 'evals/results/vibe-harness-core.offline.json';

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function suiteHash(suite) {
  return createHash('sha256').update(stableJson(suite)).digest('hex');
}

export async function buildOfflineRun(suite, {
  assetRoot = path.resolve(import.meta.dirname, '../..'),
  generatedAt = '1970-01-01T00:00:00.000Z',
  id = `${suite.id}-offline`,
  suitePath = `evals/suites/${suite.id}.json`,
} = {}) {
  const assets = await createEvalAssetFingerprint(assetRoot);
  const cases = await Promise.all(suite.cases.map((definition) => scoreCase({
    definition,
    observation: definition.input.replay,
  })));
  const aggregate = aggregateCaseScores(cases);
  const fingerprint = {
    suiteHash: suiteHash(suite),
    runner: 'offline-replay@1',
    model: 'fixture',
    agent: 'offline',
    configHash: 'fixture-v1',
    assets,
  };
  return {
    schemaVersion: 2,
    id,
    generatedAt,
    suite: { id: suite.id, version: suite.version, hash: fingerprint.suiteHash, path: suitePath },
    mode: 'offline',
    proof: 'contract-replay',
    status: cases.every((item) => item.passed) ? 'passed' : 'failed',
    fingerprint,
    caseRepetitions: suite.cases.map((item) => ({ id: item.id, count: 1 })),
    cases,
    capabilities: aggregate.capabilities,
    overallScore: aggregate.overallScore,
    criticalPassRate: aggregate.criticalPassRate,
    diagnostics: [],
  };
}

/**
 * @param {any} before
 * @param {any} after
 */
export function fingerprintChanges(before, after) {
  if (!before) {
    return [{
      field: 'fingerprint',
      from: null,
      to: after?.assets?.aggregateHash ?? null,
    }];
  }
  const changes = [];
  const record = (field, previous, next) => {
    const from = previous ?? null;
    const to = next ?? null;
    if (from !== to) changes.push({ field, from, to });
  };
  for (const key of ['suiteHash', 'runner', 'model', 'agent', 'configHash']) {
    record(`fingerprint.${key}`, before[key], after?.[key]);
  }
  record('fingerprint.assets.aggregateHash', before.assets?.aggregateHash, after?.assets?.aggregateHash);
  const groups = [...new Set([
    ...Object.keys(before.assets?.groups ?? {}),
    ...Object.keys(after?.assets?.groups ?? {}),
  ])].sort();
  for (const group of groups) {
    const previous = before.assets?.groups?.[group];
    const next = after?.assets?.groups?.[group];
    record(`fingerprint.assets.groups.${group}.hash`, previous?.hash, next?.hash);
    record(`fingerprint.assets.groups.${group}.fileCount`, previous?.fileCount, next?.fileCount);
  }
  return changes;
}

/**
 * Regenerate the checked-in offline replay artifact from the deterministic
 * replay of the suite. Read-only callers get the drift diagnosis; `--write`
 * backs the previous file up under the state directory before replacing it.
 *
 * @param {{ now?: Date, rootDir: string, suite: any, write?: boolean }} options
 */
export async function syncOfflineRunArtifact({ now = new Date(), rootDir, suite, write = false }) {
  const run = await buildOfflineRun(suite, { assetRoot: rootDir });
  const target = path.join(rootDir, OFFLINE_RESULT_PATH);
  const exists = await pathExists(target);
  const currentText = exists ? await readFile(target, 'utf8') : null;
  let current = null;
  let changes = [];
  if (exists) {
    try {
      current = JSON.parse(currentText ?? '');
      changes = fingerprintChanges(current?.fingerprint, run.fingerprint);
    } catch {
      changes = [{ field: 'artifact', from: 'unparsable', to: 'deterministic replay output' }];
    }
  } else {
    changes = fingerprintChanges(null, run.fingerprint);
  }
  const changed = current === null || stableJson(current) !== stableJson(run);
  const backups = [];
  if (write && changed) {
    if (exists) {
      backups.push({
        backup: await backupFile({
          backupId: createBackupId(now),
          target,
          targetDir: rootDir,
        }),
        target: OFFLINE_RESULT_PATH,
      });
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  }
  return {
    backups,
    changed,
    changes: changed ? changes : [],
    dryRun: !write,
    path: OFFLINE_RESULT_PATH,
    run,
    status: changed ? (write ? 'updated' : 'drifted') : 'current',
    written: write && changed ? [OFFLINE_RESULT_PATH] : [],
  };
}
