import assert from 'node:assert/strict';
import test from 'node:test';

import { assessRiskEvidence, classifyChangedPaths } from '../scripts/lib/risk-evidence.js';
import { validatePullRequestBranches } from '../scripts/branch-policy.js';
import { hasCurrentExternalApproval } from '../scripts/check-pull-request-approval.js';

const completeBody = [
  '## 影响范围', '公共 eval schema 与发布工作流。',
  '## 关系链', '调用方、契约、测试和文档已同步。',
  '## 未验证项', 'GitHub ruleset 需仓库管理员应用。',
  '## 回滚', 'revert 本 PR；发布失败后创建新的 patch release。',
  '## Go / No-Go', 'GO：自动检查通过后可合并。',
].join('\n');

test('risk classifier treats delivery and public-contract paths as high risk', () => {
  assert.equal(classifyChangedPaths(['docs/README.md']).level, 'ordinary');
  assert.equal(classifyChangedPaths(['schemas/eval-run.schema.json']).level, 'high');
  assert.equal(classifyChangedPaths(['.github/workflows/release-please.yml']).level, 'high');
});

test('high-risk pull requests require complete human-readable evidence', () => {
  assert.equal(assessRiskEvidence({ changedPaths: ['schemas/eval-run.schema.json'], body: completeBody }).ok, true);
  const incomplete = assessRiskEvidence({ changedPaths: ['runtime/evals/codex-runner.mjs'], body: '## 影响范围\nrunner' });
  assert.equal(incomplete.ok, false);
  assert.deepEqual(incomplete.missing, ['relationship-chain', 'unverified-items', 'rollback', 'go-no-go']);
  const placeholders = ['## 影响范围', '- 目标：', '## 关系链', '- 调用方：', '## 未验证项', '- 未验证项：', '## 回滚', '- 回滚路径：', '## Go / No-Go', '- 判定：'].join('\n');
  assert.equal(assessRiskEvidence({ changedPaths: ['schemas/eval-run.schema.json'], body: placeholders }).ok, false);
});

test('ordinary pull requests do not acquire a new evidence completion gate', () => {
  const result = assessRiskEvidence({ changedPaths: ['docs/README.md'], body: '' });
  assert.equal(result.level, 'ordinary');
  assert.deepEqual(result.highRiskPaths, []);
  assert.deepEqual(result.missing, []);
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks, { docs: true, eval: false, integration: false, skills: false });
});

test('develop change matrix selects only relevant focused checks', () => {
  const docs = classifyChangedPaths(['docs/README.md']);
  assert.deepEqual(docs.checks, { docs: true, eval: false, integration: false, skills: false });
  const integration = classifyChangedPaths(['runtime/hooks/codex-hook.mjs', 'skills/core/example/SKILL.md']);
  assert.deepEqual(integration.checks, { docs: false, eval: false, integration: true, skills: true });
  assert.equal(integration.level, 'high');
});

test('branch policy protects main promotion and permits task branches into develop', () => {
  const pull = (base, head, sameRepository = true) => ({
    base: { ref: base, repo: { full_name: 'owner/repo' } },
    head: { ref: head, repo: { full_name: sameRepository ? 'owner/repo' : 'fork/repo' } },
  });
  assert.equal(validatePullRequestBranches(pull('main', 'develop')).ok, true);
  assert.equal(validatePullRequestBranches(pull('main', 'hotfix/ENG-1-recover')).ok, true);
  assert.equal(validatePullRequestBranches(pull('main', 'release-please--branches--main--components--pkg')).ok, true);
  assert.equal(validatePullRequestBranches(pull('main', 'feat/ENG-2-bypass')).ok, false);
  assert.equal(validatePullRequestBranches(pull('main', 'develop', false)).ok, false);
  assert.equal(validatePullRequestBranches(pull('develop', 'feat/ENG-2-feature')).ok, true);
  assert.equal(validatePullRequestBranches(pull('develop', 'main')).ok, true);
});

test('high-risk approval uses the latest review from a non-author', () => {
  const reviews = [
    { state: 'APPROVED', submitted_at: '2026-01-01T00:00:00Z', user: { login: 'reviewer' } },
    { state: 'CHANGES_REQUESTED', submitted_at: '2026-01-02T00:00:00Z', user: { login: 'reviewer' } },
    { state: 'APPROVED', submitted_at: '2026-01-03T00:00:00Z', user: { login: 'author' } },
  ];
  assert.equal(hasCurrentExternalApproval({ author: 'author', reviews }), false);
  reviews.push({ state: 'APPROVED', submitted_at: '2026-01-04T00:00:00Z', user: { login: 'reviewer' } });
  assert.equal(hasCurrentExternalApproval({ author: 'author', reviews }), true);
});
