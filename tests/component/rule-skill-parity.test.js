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

test('规则与 Skill parity 映射表锁定七对常驻配对', () => {
  assert.deepEqual(RULE_SKILL_PARITY_PAIRS.map((pair) => pair.rule), [
    'docs/rules/api-rules.md',
    'docs/rules/eval-driven-development.md',
    'docs/rules/frontend-rules.md',
    'docs/rules/git-rules.md',
    'docs/rules/git-rules.md',
    'docs/rules/linear-workflow.md',
    'docs/rules/linear-workflow.md',
  ]);
  assert.deepEqual(RULE_SKILL_PARITY_PAIRS.map((pair) => pair.skill), [
    'skills/core/api-and-interface-design/SKILL.md',
    'skills/core/eval-driven-development/SKILL.md',
    'skills/core/frontend-design/SKILL.md',
    'skills/core/vb-git-split-push/SKILL.md',
    'skills/core/vb-git-develop-flow/SKILL.md',
    'skills/integrations/linear-workflow/SKILL.md',
    'skills/integrations/vb-linear-worktree-develop/SKILL.md',
  ]);
});

test('全部配对保持双向引用、同步声明与共享措辞', async () => {
  const contents = await loadPairContents();
  for (const pair of RULE_SKILL_PARITY_PAIRS) {
    assert.deepEqual(ruleSkillParityViolations(pair, contents), [], `${pair.rule} ↔ ${pair.skill}`);
  }
  for (const [skillName, term] of [['vb-git-develop-flow', '--target-mode primary'], ['vb-linear-worktree-develop', '--target-mode primary']]) {
    const pair = findPair(skillName);
    const mutated = new Map(contents);
    mutated.set(pair.skill, contents.get(pair.skill).replaceAll(term, 'missing-mode'));
    assert.ok(ruleSkillParityViolations(pair, mutated).some((message) => message.includes(term)), skillName);
  }
});

test('微型 UI 不默认升级浏览器或 E2E 验证', async () => {
  const [frontendRule, testRules, frontendSkill, browserSkill, routingRule, gitRule, gitSkill] = await Promise.all([
    readFile(path.join(rootDir, 'docs/rules/frontend-rules.md'), 'utf8'),
    readFile(path.join(rootDir, 'docs/rules/test-rules.md'), 'utf8'),
    readFile(path.join(rootDir, 'skills/core/frontend-design/SKILL.md'), 'utf8'),
    readFile(path.join(rootDir, 'skills/integrations/browser-verification/SKILL.md'), 'utf8'),
    readFile(path.join(rootDir, 'docs/rules/agent-skill-routing.md'), 'utf8'),
    readFile(path.join(rootDir, 'docs/rules/git-rules.md'), 'utf8'),
    readFile(path.join(rootDir, 'skills/core/vb-git-develop-flow/SKILL.md'), 'utf8'),
  ]);
  for (const content of [frontendRule, frontendSkill]) {
    assert.match(content, /微型 UI/u);
    assert.match(content, /微型 UI[\s\S]*(?:静态检查|组件检查)[\s\S]*(?:浏览器|E2E)/u);
  }
  assert.match(browserSkill, /不默认触发本 Skill/u);
  assert.match(browserSkill, /帮助图标、tooltip/u);
  assert.match(routingRule, /browser-verification integration Skill；.*不自动触发该 Skill/u);
  assert.match(gitRule, /local-land 不隐含浏览器验证、E2E、Eval 或全量矩阵/u);
  assert.match(gitSkill, /local-land 不隐含浏览器验证、E2E、Eval 或全量矩阵/u);
  for (const term of ['局部展示', '局部交互', '共享组件', '路由', '数据', '本地化', '可访问性']) {
    assert.match(frontendRule, new RegExp(term, 'u'));
  }
  assert.match(testRules, /测试 \/ fixture \/ 依赖配置/u);
});

test('负控：规则侧失去 Skill 入口引用时只报该配对的入口违规', async () => {
  const contents = await loadPairContents();
  const pair = findPair('vb-git-split-push');
  const mutated = new Map(contents);
  mutated.set(pair.rule, contents.get(pair.rule).replaceAll('`vb-git-split-push`', '`missing-entry`'));
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
