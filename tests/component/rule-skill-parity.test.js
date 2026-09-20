import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { RULE_SKILL_PARITY_PAIRS, ruleSkillParityViolations } from '../../scripts/lib/pack-validation.js';

const rootDir = path.resolve(import.meta.dirname, '../..');

async function loadPairContents() {
  const contents = new Map();
  for (const pair of RULE_SKILL_PARITY_PAIRS) {
    for (const file of [pair.rule, pair.skill]) {
      if (!contents.has(file)) {
        contents.set(file, await readFile(path.join(rootDir, file), 'utf8'));
      }
    }
  }
  return contents;
}

function findPair(skillName) {
  const pair = RULE_SKILL_PARITY_PAIRS.find((candidate) => candidate.skillName === skillName);
  assert.ok(pair, `unknown skillName: ${skillName}`);
  return pair;
}

test('规则与 Skill parity 映射表锁定五对常驻配对', () => {
  assert.deepEqual(RULE_SKILL_PARITY_PAIRS.map((pair) => pair.rule), [
    'docs/rules/api-rules.md',
    'docs/rules/eval-driven-development.md',
    'docs/rules/frontend-rules.md',
    'docs/rules/git-rules.md',
    'docs/rules/linear-workflow.md',
  ]);
  assert.deepEqual(RULE_SKILL_PARITY_PAIRS.map((pair) => pair.skill), [
    'skills/core/api-and-interface-design/SKILL.md',
    'skills/core/eval-driven-development/SKILL.md',
    'skills/core/frontend-design/SKILL.md',
    'skills/core/git-deliver/SKILL.md',
    'skills/integrations/linear-workflow/SKILL.md',
  ]);
});

test('全部配对保持双向引用、同步声明与共享措辞', async () => {
  const contents = await loadPairContents();
  for (const pair of RULE_SKILL_PARITY_PAIRS) {
    assert.deepEqual(ruleSkillParityViolations(pair, contents), [], `${pair.rule} ↔ ${pair.skill}`);
  }
});

test('负控：规则侧失去 Skill 入口引用时只报该配对的入口违规', async () => {
  const contents = await loadPairContents();
  const pair = findPair('git-deliver');
  const mutated = new Map(contents);
  mutated.set(pair.rule, contents.get(pair.rule).replaceAll('`git-deliver`', '`missing-entry`'));
  assert.deepEqual(ruleSkillParityViolations(pair, mutated), [
    `${pair.rule} must point at the installed \`${pair.skillName}\` Skill entry`,
  ]);
});

test('负控：Skill 侧失去常驻契约引用时只报该配对的契约违规', async () => {
  const contents = await loadPairContents();
  const pair = findPair('frontend-design');
  const mutated = new Map(contents);
  mutated.set(pair.skill, contents.get(pair.skill).replaceAll(pair.rule, 'docs/rules/missing-rules.md'));
  assert.deepEqual(ruleSkillParityViolations(pair, mutated), [
    `${pair.skill} must point at its resident contract ${pair.rule}`,
  ]);
});

test('负控：单侧丢失同步声明时按配对报同步违规', async () => {
  const contents = await loadPairContents();
  const pair = findPair('linear-workflow');
  const mutated = new Map(contents);
  mutated.set(pair.skill, contents.get(pair.skill).replaceAll('修改须同步', '需要一起更新'));
  assert.deepEqual(ruleSkillParityViolations(pair, mutated), [
    `${pair.rule} and ${pair.skill} must both declare: 修改须同步`,
  ]);
});

test('负控：单侧丢失共享措辞时按术语报措辞违规', async () => {
  const contents = await loadPairContents();
  const pair = findPair('api-and-interface-design');
  const mutated = new Map(contents);
  mutated.set(pair.skill, contents.get(pair.skill).replaceAll('兼容窗口', '兼容期间'));
  assert.deepEqual(ruleSkillParityViolations(pair, mutated), [
    `shared contract wording must appear in both ${pair.rule} and ${pair.skill}: 兼容窗口`,
  ]);
});
