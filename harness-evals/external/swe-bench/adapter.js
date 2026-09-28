import path from 'node:path';

import {
  createCommandPlan,
  createRunIdentity,
  discoverFromManifest,
  normalizeExternalResult,
} from '../adapter-contract.js';

function materialize(task, { predictionsPath, patchHash, verifierRevision }) {
  if (!path.isAbsolute(predictionsPath)) throw new Error('predictionsPath must be absolute');
  return {
    task,
    prediction: { instanceId: task.id, path: predictionsPath },
    runIdentity: createRunIdentity({
      benchmark: task.benchmark,
      datasetRevision: task.datasetRevision,
      taskId: task.id,
      patchHash,
      verifierRevision,
    }),
  };
}

function sweBenchEvaluate(materialized, { cwd, outputDir, python = 'python' }) {
  const { task, prediction, runIdentity } = materialized;
  return createCommandPlan({
    program: python,
    args: [
      '-m', 'swebench.harness.run_evaluation',
      '--dataset_name', task.dataset,
      '--split', task.metadata.split ?? 'test',
      '--instance_ids', task.id,
      '--predictions_path', prediction.path,
      '--max_workers', '1',
      '--run_id', runIdentity.runId,
    ],
    cwd,
    outputDir,
    runIdentity,
  });
}

function sweBenchLiveEvaluate(materialized, { cwd, outputDir, python = 'python' }) {
  const { task, prediction, runIdentity } = materialized;
  return createCommandPlan({
    program: python,
    args: [
      '-m', 'evaluation.evaluation',
      '--dataset', task.dataset,
      '--split', task.metadata.split ?? 'test',
      '--platform', task.metadata.platform ?? 'linux',
      '--patch_dir', prediction.path,
      '--output_dir', outputDir,
      '--workers', '1',
      '--overwrite', '0',
      '--instance_ids', task.id,
    ],
    cwd,
    outputDir,
    runIdentity,
  });
}

function normalizeSweBench(task, run, officialResult, trace) {
  const resolved = Array.isArray(officialResult.resolved_ids)
    ? officialResult.resolved_ids.includes(task.id)
    : (Array.isArray(officialResult.success_ids)
        ? officialResult.success_ids.includes(task.id)
        : (officialResult.resolved ?? false));
  const errored = officialResult.error_ids?.includes(task.id) ?? officialResult.error === true;
  const completed = Array.isArray(officialResult.completed_ids)
    ? officialResult.completed_ids.includes(task.id)
    : (Array.isArray(officialResult.incomplete_ids)
        ? !officialResult.incomplete_ids.includes(task.id)
        : (officialResult.completed ?? true));
  const outcome = errored ? 'error' : (completed ? (resolved ? 'passed' : 'failed') : 'blocked');
  return normalizeExternalResult({
    benchmark: task.benchmark,
    task,
    run,
    outcome,
    metrics: { resolved: { value: resolved ? 1 : 0, unit: 'ratio', numerator: resolved ? 1 : 0, denominator: 1, coverage: 1 } },
    official: { completed, errored, resolved, raw: officialResult },
    trace,
  });
}

function makeAdapter({ id, evaluate }) {
  return Object.freeze({
    id,
    capabilities: Object.freeze({ docker: true, trace: false, maxConcurrency: 1 }),
    discover: (manifest) => discoverFromManifest(manifest, id),
    materialize,
    evaluate,
    normalize: normalizeSweBench,
  });
}

export const sweBenchAdapter = makeAdapter({ id: 'swe-bench', evaluate: sweBenchEvaluate });
export const sweBenchLiveAdapter = makeAdapter({ id: 'swe-bench-live', evaluate: sweBenchLiveEvaluate });
