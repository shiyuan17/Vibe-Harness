import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runEvaluationCase } from '../../scripts/lib/eval-runner.js';
import { readJson } from '../../scripts/lib/manifest.js';

const rootDir = path.resolve(import.meta.dirname, '../..');

test('split scenarios distinguish small compatible changes from actual concurrent ownership', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/vibe-harness-online-canary.json'));
  const cases = suite.cases.filter((item) => item.id.startsWith('EVAL-SPLIT-'));
  assert.equal(cases.length, 3);
  assert.match(cases[1].input.scenario, /optional field.*compatible.*no data migration/u);
  assert.match(cases[2].input.scenario, /parallel implementation by independent writers/u);
  for (const item of cases) {
    assert.equal(item.repetitions, 3);
    assert.deepEqual(item.oracle.requiredOutputFragments, []);
    assert.equal(item.oracle.exactOutput, undefined);
    assert.doesNotMatch(item.input.scenario, /Return |EXECUTION_DISPOSITION|SPLIT_HARD_TRIGGER/u);
    assert.ok(item.oracle.forbiddenEvents.some((event) => event.value === 'workspace-write-invoked' && event.critical));
    assert.ok(item.oracle.llmRubrics.every((rubric) => rubric.critical));
  }
});

test('online split request expands real governance without leaking scoring answers into the prompt', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/vibe-harness-online-canary.json'));
  const definition = suite.cases.find((item) => item.id === 'EVAL-SPLIT-002');
  const temp = await mkdtemp(path.join(tmpdir(), 'vibe-split-request-'));
  const capture = path.join(temp, 'capture.json');
  const runner = path.join(temp, 'runner.mjs');
  try {
    await writeFile(runner, `import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
let input='';for await(const chunk of process.stdin) input+=chunk;
const r=JSON.parse(input);
await writeFile(${JSON.stringify(capture)},JSON.stringify({prompt:r.case.input.scenario,rules:await readFile(path.join(r.workspace,'AGENTS.md'),'utf8')}));
console.log(JSON.stringify({schemaVersion:1,caseId:r.case.id,configHash:r.configHash,runner:'contract-probe',model:'stub',agentVersion:'1',output:'Bounded implementation with compatibility verification.',events:[],artifacts:[],diagnostics:[],exitCode:0}));
`);
    const result = await runEvaluationCase({
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(runner)}`,
      definition,
      sourceRoot: rootDir,
      judge: { judgeRubric: async () => ({ score: 1, rationale: 'Contract plumbing only.', judgeModel: 'stub' }) },
    });
    assert.equal(result.status, 'ready');
    const captured = JSON.parse(await readFile(capture, 'utf8'));
    assert.equal(captured.prompt, definition.input.scenario);
    assert.equal(captured.rules, await readFile(path.join(rootDir, 'docs/rules/governance-core.md'), 'utf8'));
    assert.doesNotMatch(captured.prompt, /Evaluator contract|DIRECT_IMPLEMENTATION|SPLIT_IMPLEMENTATION/u);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
