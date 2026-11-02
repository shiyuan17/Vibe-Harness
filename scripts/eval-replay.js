#!/usr/bin/env node
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEvalAssets, validateEvalAssets } from './lib/eval-contract.js';
import { evaluateCurrentEvalInputs } from './lib/eval-replay.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => ['--help', '-h'].includes(arg))) {
    console.log('Usage: node scripts/eval-replay.js [--write] [--json]\nEvaluate current inputs under approved criteria; --write saves a NEW run in .vibe-harness/evals/. Historical run/reference are never overwritten. Offline replay is not Agent behavior evidence.');
    return;
  }
  if (args.some((arg) => !['--write', '--json'].includes(arg))) {
    console.error('eval-replay: unknown argument');
    process.exitCode = 1;
    return;
  }
  const assets = await loadEvalAssets(rootDir);
  const errors = validateEvalAssets(assets, { historicalInputs: true });
  if (errors.length) {
    console.error(JSON.stringify({ status: 'failed', category: 'asset-contract', errors, ok: false }, null, 2));
    process.exitCode = 1;
    return;
  }
  const result = await evaluateCurrentEvalInputs({ rootDir, suite: assets.suite, reference: assets.reference });
  let artifact = null;
  if (args.includes('--write') && result.run) {
    artifact = path.join(rootDir, '.vibe-harness/evals', `core-${randomUUID()}.json`);
    await mkdir(path.dirname(artifact), { recursive: true });
    await writeFile(artifact, `${JSON.stringify(result.run, null, 2)}\n`, { flag: 'wx' });
  }
  const report = { ok: result.status === 'passed', status: result.status, criteria: result.criteria,
    proof: result.proof, fingerprint: result.run?.fingerprint ?? null, artifact,
    overallScore: result.run?.overallScore ?? null, criticalPassRate: result.run?.criticalPassRate ?? null,
    agentBehavior: 'unverified; requires a real Agent run', historicalArtifacts: 'preserved',
    nextAction: result.status === 'blocked' ? 'Restore the approved suite for comparison or obtain protected approval for changed criteria; do not re-record the reference to remove a failure.' : null };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
