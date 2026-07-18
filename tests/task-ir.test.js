import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeTaskDocument,
  parseTaskMarkdown,
  renderTaskDocumentMarkdown,
  validateTaskDocument,
} from '../runtime/governance/lib/task-validation.mjs';

const markdown = `# T-IR 语言无关任务

- 工作流档位：快速
- 当前阶段：执行
- 当前状态：进行中
- 处理结果：开放

## 目标

建立 TaskDocument IR。

## 约束

不得写入全局配置。

## 写入范围

runtime/governance

## 验收标准

| AC-ID | 标准 |
| --- | --- |
| AC-1 | IR 字段稳定 |

## 验证计划

运行 task IR 测试。

## 下一步动作

实现解析与验证分层。
`;

test('Markdown tasks normalize into a language-neutral TaskDocument IR', () => {
  const parsed = parseTaskMarkdown('docs/tasks/T-IR.md', markdown);
  const document = normalizeTaskDocument(parsed);

  assert.equal(document.schemaVersion, 1);
  assert.equal(document.id, 'T-IR');
  assert.equal(document.title, '语言无关任务');
  assert.equal(document.status, 'in_progress');
  assert.equal(document.goal, '建立 TaskDocument IR。');
  assert.equal(document.scope.write, 'runtime/governance');
  assert.deepEqual(document.constraints, ['不得写入全局配置。']);
  assert.deepEqual(document.acceptanceCriteria, [{ id: 'AC-1', standard: 'IR 字段稳定' }]);
  assert.equal(document.verification, '运行 task IR 测试。');
  assert.deepEqual(document.evidence, []);
  assert.deepEqual(validateTaskDocument({ document, root: process.cwd(), schema: {} }), []);

  const english = normalizeTaskDocument(parseTaskMarkdown(
    'docs/tasks/T-IR.en.md',
    renderTaskDocumentMarkdown(document, { language: 'en-US' }),
  ));
  assert.deepEqual(
    {
      acceptanceCriteria: english.acceptanceCriteria,
      goal: english.goal,
      id: english.id,
      status: english.status,
      title: english.title,
      verification: english.verification,
    },
    {
      acceptanceCriteria: document.acceptanceCriteria,
      goal: document.goal,
      id: document.id,
      status: document.status,
      title: document.title,
      verification: document.verification,
    },
  );
});
