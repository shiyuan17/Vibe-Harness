import path from 'node:path';

import {
  createCommandPlan,
  createRunIdentity,
  discoverFromManifest,
  normalizeExternalResult,
  scoreToOutcome,
} from '../adapter-contract.js';

export const terminalBenchAdapter = Object.freeze({
  id: 'terminal-bench',
  capabilities: Object.freeze({ docker: true, trace: 'atif', maxConcurrency: 1 }),
  discover(manifest) {
    return discoverFromManifest(manifest, this.id);
  },
  materialize(task, { patchHash, verifierRevision }) {
    return {
      task,
      runIdentity: createRunIdentity({
        benchmark: task.benchmark,
        datasetRevision: task.datasetRevision,
        taskId: task.id,
        patchHash,
        verifierRevision,
      }),
    };
  },
  evaluate(materialized, { cwd, outputDir, model, agent = 'codex', harbor = 'harbor' }) {
    if (!path.isAbsolute(outputDir)) throw new Error('outputDir must be absolute');
    if (!model) throw new Error('model is required');
    const { task, runIdentity } = materialized;
    return createCommandPlan({
      program: harbor,
      args: [
        'run',
        '-d', `${task.dataset}@${task.datasetRevision}`,
        '--include-task-name', task.id,
        '-a', agent,
        '-m', model,
        '--job-name', runIdentity.runId,
        '--jobs-dir', outputDir,
        '--n-concurrent', '1',
        '--export-traces',
      ],
      cwd,
      outputDir,
      runIdentity,
    });
  },
  normalize(task, run, officialResult) {
    const reward = officialResult.reward ?? officialResult.metrics?.reward ?? null;
    const errored = Boolean(officialResult.error || officialResult.exception);
    return normalizeExternalResult({
      benchmark: this.id,
      task,
      run,
      outcome: scoreToOutcome(reward, errored),
      metrics: {
        reward: {
          value: reward,
          unit: 'ratio',
          numerator: reward,
          denominator: reward === null ? null : 1,
          coverage: reward === null ? 0 : 1,
          missingReason: reward === null ? 'official Harbor result omitted reward' : null,
        },
      },
      official: { raw: officialResult },
      trace: officialResult.trajectory_path
        ? { status: 'available', format: 'ATIF', path: officialResult.trajectory_path }
        : null,
    });
  },
});
