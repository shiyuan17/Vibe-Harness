import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { scoreCase } from '../../scripts/lib/eval-scoring.js';
import { readJson, validateJsonAgainstSchema } from '../../scripts/lib/manifest.js';

const rootDir = path.resolve(import.meta.dirname, '../..');

test('深审 Eval 使用原始合成业务输入并覆盖七类缺陷及两个反例', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/vibe-harness-find-question.json'));
  const schema = await readJson(path.join(rootDir, 'schemas/eval-suite.schema.json'));
  assert.deepEqual(validateJsonAgainstSchema(suite, schema, 'find-question suite'), []);
  assert.deepEqual(suite.cases.map((item) => item.capability), [
    'find-question-field-conflict', 'find-question-null-reference', 'find-question-unused-config',
    'find-question-data-consistency', 'find-question-configuration', 'find-question-authorization',
    'find-question-lifecycle', 'find-question-disproof', 'find-question-blocked',
  ]);
  for (const definition of suite.cases) {
    assert.deepEqual(definition.input.fixture.allowedWritePaths, []);
    assert.equal(definition.repetitions, 3);
    const skill = definition.input.fixture.files.find((item) => item.path.endsWith('/SKILL.md'));
    assert.equal(skill.content, '{{SKILL:find-question}}');
    assert.ok(definition.input.fixture.files.some((item) => item.path === 'source.js'));
    assert.ok(definition.input.fixture.files.some((item) => item.path === 'CONTRACT.md'));
    assert.equal(definition.input.scenario.includes(definition.input.replay.output), false);
  }
});

test('深审 oracle 正控通过而遗漏证据和虚构复现的负控失败', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/vibe-harness-find-question.json'));
  for (const definition of suite.cases) {
    const observation = definition.input.replay;
    assert.equal((await scoreCase({ definition, observation })).passed, true, definition.id);
    assert.equal((await scoreCase({ definition, observation: { ...observation, output: '' } })).passed, false, definition.id);
    assert.equal((await scoreCase({ definition, observation: { ...observation, output: observation.output + '\n已复现' } })).passed, false, definition.id);
    assert.equal((await scoreCase({ definition, observation: { ...observation, events: ['undeclared-workspace-write'] } })).passed, false, definition.id);
    if (definition.kind === 'adversarial') {
      assert.equal((await scoreCase({ definition, observation: { ...observation, output: observation.output + '\nSYN-F01' } })).passed, false, definition.id);
    }
  }
});
