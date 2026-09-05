import {
  createCommandPlan,
  createRunIdentity,
  discoverFromManifest,
  normalizeExternalResult,
  scoreToOutcome,
} from '../adapter-contract.js';

const SETTINGS = new Set(['solo', 'coop', 'team']);

export const cooperBenchAdapter = Object.freeze({
  id: 'cooperbench',
  capabilities: Object.freeze({ docker: true, trace: 'native', settings: Object.freeze([...SETTINGS]), maxConcurrency: 1 }),
  discover(manifest) {
    return discoverFromManifest(manifest, this.id);
  },
  materialize(task, { patchHash, verifierRevision, setting }) {
    if (!SETTINGS.has(setting)) throw new Error(`setting must be one of: ${[...SETTINGS].join(', ')}`);
    return {
      setting,
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
  evaluate(materialized, { cwd, outputDir, model, cooperbench = 'cooperbench' }) {
    if (!model) throw new Error('model is required');
    const { setting, task, runIdentity } = materialized;
    return createCommandPlan({
      program: cooperbench,
      args: [
        'run', '-n', runIdentity.runId,
        '-r', task.id,
        '-m', model,
        '--setting', setting,
      ],
      cwd,
      outputDir,
      runIdentity,
    });
  },
  evaluationPlan(materialized, { cwd, outputDir, cooperbench = 'cooperbench' }) {
    return createCommandPlan({
      program: cooperbench,
      args: ['eval', '-n', materialized.runIdentity.runId],
      cwd,
      outputDir,
      runIdentity: materialized.runIdentity,
    });
  },
  normalize(task, run, officialResult) {
    const featureScores = officialResult.features ?? officialResult.feature_results ?? [];
    const values = featureScores.map((item) => Number(item.score ?? item.passed)).filter(Number.isFinite);
    const score = officialResult.score ?? (values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
    const errored = Boolean(officialResult.error || officialResult.status === 'error');
    return normalizeExternalResult({
      benchmark: this.id,
      task,
      run,
      outcome: scoreToOutcome(score, errored),
      metrics: {
        featureSuccess: {
          value: score,
          unit: 'ratio',
          numerator: values.filter((value) => value >= 1).length,
          denominator: values.length || null,
          coverage: values.length > 0 ? 1 : 0,
          missingReason: values.length > 0 ? null : 'official result omitted feature scores',
        },
        coordination: officialResult.metrics ?? { status: 'unavailable' },
      },
      official: { setting: officialResult.setting, raw: officialResult },
      trace: officialResult.trajectory_path
        ? { status: 'available', format: 'native', path: officialResult.trajectory_path }
        : null,
    });
  },
});
