# External benchmark adapters

This directory adapts official benchmark runners to the Harness Eval result model. It does not vendor benchmark code, replace official verifiers, or execute commands itself.

Every adapter exposes `discover`, `materialize`, `evaluate`, and `normalize`. `evaluate` returns an immutable dry-run command plan with `shell: false` and concurrency fixed at one. The Harness Runner is responsible for checking prerequisites, executing the plan, collecting the official output and trace, and calling `normalize`.

Sample manifests pin both the upstream implementation and dataset revision. A run ID includes a digest of the benchmark, task, dataset revision, verifier revision, and prediction patch. This is required because some official runners cache by run ID and task ID without including the patch.

The checked-in official-output fixtures are reduced examples for offline contract tests. They are not claimed as benchmark runs or baselines.

## Contract

```js
const tasks = adapter.discover(manifest);
const materialized = adapter.materialize(tasks[0], {
  patchHash,
  verifierRevision: manifest.upstream.revision,
  // predictionsPath for SWE-bench; setting for CooperBench
});
const plan = adapter.evaluate(materialized, {
  cwd,
  outputDir,
  model: 'provider/model',
});
// A trusted runner executes plan.program with plan.args and shell:false.
const result = adapter.normalize(tasks[0], plan, officialOutput);
```

Paths passed to adapters must be absolute. Credentials are never placed in command plans. Missing official scores and traces are recorded as unavailable or blocked rather than as zero-valued evidence.
