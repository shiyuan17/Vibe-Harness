import assert from 'node:assert/strict';
import test from 'node:test';

import { assessRiskEvidence, classifyChangedPaths } from '../scripts/lib/risk-evidence.js';

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
  assert.deepEqual(result, { level: 'ordinary', highRiskPaths: [], missing: [], ok: true });
});
