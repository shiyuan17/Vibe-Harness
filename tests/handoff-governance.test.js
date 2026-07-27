import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { validateJsonAgainstSchema } from '../runtime/governance/lib/schema-validation.mjs';
import {
  normalizeTaskDocument,
  parseTaskMarkdown,
  validateTaskDocument,
  validateTasks,
} from '../runtime/governance/lib/task-validation.mjs';
import {
  computeWorkspaceFingerprint,
  finishSubagentReceipt,
  inspectSubagentReceipts,
  startSubagentReceipt,
  validateSubagentOutput,
  writeExclusive,
} from '../runtime/hooks/lib/subagent-receipts.mjs';
import { validateHandoffRecords } from '../runtime/governance/lib/handoff-validation.mjs';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve('.');
const fingerprint = 'a'.repeat(64);
const receiptId = 'b'.repeat(64);
const receiptPath = `.cognis/subagents/receipts/${receiptId}.json`;

function control(overrides = {}) {
  return {
    控制版本: 3,
    任务类型: '单任务',
    集成验证: ['pnpm check'],
    责任角色: '实现负责人',
    写入范围: ['src/example.js'],
    禁止动作: ['覆盖用户改动'],
    输入: ['验收标准'],
    输出格式: ['交付记录'],
    不得修改范围: ['范围外文件'],
    依赖任务: [],
    冲突任务: [],
    并行安全: '独占写入',
    时间盒分钟: 60,
    停止条件: '全部验收通过',
    回滚方案: '恢复本任务改动',
    人工确认: '不需要',
    核验者: 'cognis_tester',
    红队审查者: 'cognis_reviewer',
    红队审查包: 'docs/reviews/T-V3-red-team.md',
    红队审查结论: '待审查',
    独立核验模式: '原生子智能体',
    合并回主线状态: '不需要',
    ...overrides,
  };
}

function handoff(overrides = {}) {
  return {
    版本: 1,
    编号: 'HO-001',
    类型: '子任务回传',
    来源角色: 'cognis_tester',
    目标角色: '集成负责人',
    'Agent/运行收据': receiptPath,
    状态: '待接收',
    变更集指纹: fingerprint,
    已完成: ['运行验收测试'],
    未完成: [],
    验证证据: ['node --test: exit 0'],
    未验证项: [],
    风险: [],
    下一步: '等待父 Agent fan-in',
    恢复提示: '从最新任务合同继续',
    时间: '2026-07-26T12:00:00.000Z',
    ...overrides,
  };
}

function returnedHandoffHistory(overrides = {}) {
  const returnedTime = Date.parse(overrides.时间 ?? '2026-07-26T12:00:00.000Z');
  return [
    handoff({ ...overrides, 状态: '待接收', 时间: new Date(returnedTime - 2_000).toISOString() }),
    handoff({ ...overrides, 状态: '已接收', 时间: new Date(returnedTime - 1_000).toISOString() }),
    handoff({ ...overrides, 状态: '已返回', 时间: new Date(returnedTime).toISOString() }),
  ];
}

function markdown({ handoffs = [], result = '开放', status = '进行中', taskControl = control() } = {}) {
  return `# T-V3 v3 Handoff 合同

- 工作流档位：完整
- 当前阶段：执行
- 当前状态：${status}
- 处理结果：${result}

## 目标

验证 v3 Handoff。

## 验收标准

| AC-ID | 标准 |
| --- | --- |
| AC-01 | 合同有效。 |

## 验证计划

运行聚焦测试。

## 下一步动作

继续验证。

## 完整流程控制

\`\`\`json
${JSON.stringify(taskControl, null, 2)}
\`\`\`

## 交接记录

\`\`\`json
${JSON.stringify(handoffs, null, 2)}
\`\`\`

## 验收证据

| AC-ID | 证据类型 | 命令或产物 | 退出码 | 核验时间 | 核验者 | 实际结果 |
| --- | --- | --- | --- | --- | --- | --- |

## 剩余风险

无。
`;
}

async function receipt(root, overrides = {}) {
  const id = overrides.receiptId ?? receiptId;
  const target = path.join(root, `.cognis/subagents/receipts/${id}.json`);
  await mkdir(path.dirname(target), { recursive: true });
  const role = overrides.role ?? 'cognis_tester';
  const value = {
    schemaVersion: 2,
    receiptId,
    sessionIdHash: 'c'.repeat(64),
    agentIdHash: 'd'.repeat(64),
    turnIdHash: 'e'.repeat(64),
    role,
    status: 'sealed',
    startedAt: '2026-07-26T11:58:00.000Z',
    completedAt: '2026-07-26T11:59:00.000Z',
    startWorkspaceFingerprint: fingerprint,
    completedWorkspaceFingerprint: fingerprint,
    startEvidenceFingerprint: '9'.repeat(64),
    completedEvidenceFingerprint: '9'.repeat(64),
    attestationScope: 'project-local-tamper-evidence',
    continuationCount: 0,
    outputValidation: { status: 'valid', missing: [], conclusion: role === 'cognis_tester' ? 'passed' : 'approved' },
    ...overrides,
  };
  if (!overrides.integrityHash) {
    const stableJson = (item) => {
      if (Array.isArray(item)) return `[${item.map(stableJson).join(',')}]`;
      if (item && typeof item === 'object') return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${stableJson(item[key])}`).join(',')}}`;
      return JSON.stringify(item);
    };
    value.integrityHash = createHash('sha256').update(`cognis-subagent-receipt-integrity-v2\0${stableJson(value)}`).digest('hex');
  }
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return target;
}

test('v3 schema is accepted while v1 and v2 remain readable', async () => {
  const schema = JSON.parse(await readFile(path.join(rootDir, 'schemas/full-task-control.schema.json'), 'utf8'));
  assert.deepEqual(validateJsonAgainstSchema(control(), schema, 'v3'), []);
  const v2 = control({ 控制版本: 2 });
  delete v2.独立核验模式;
  delete v2.集成验证;
  assert.deepEqual(validateJsonAgainstSchema(v2, schema, 'v2'), []);
  assert.match(validateJsonAgainstSchema({ ...v2, 集成验证: ['pnpm check'] }, schema, 'v2').join('\n'), /集成验证|oneOf/u);
  delete v2.控制版本;
  assert.deepEqual(validateJsonAgainstSchema(v2, schema, 'v1'), []);

  const missingMode = control();
  delete missingMode.独立核验模式;
  assert.match(validateJsonAgainstSchema(missingMode, schema, 'v3').join('\n'), /独立核验模式|oneOf/u);
  const missingIntegration = control();
  delete missingIntegration.集成验证;
  assert.match(validateJsonAgainstSchema(missingIntegration, schema, 'v3').join('\n'), /集成验证|oneOf/u);

  assert.deepEqual(validateJsonAgainstSchema(control({
    独立核验模式: '人工等价',
    人工等价核验: [
      { 角色: 'cognis_tester', 核验者: '人工测试员', 证据: 'evidence/test.txt', 变更集指纹: fingerprint, 结论: '通过', 时间: '2026-07-26T12:00:00.000Z' },
      { 角色: 'cognis_reviewer', 核验者: '人工审查员', 证据: 'evidence/review.md', 变更集指纹: fingerprint, 结论: '批准', 时间: '2026-07-26T12:01:00.000Z' },
    ],
  }), schema, 'v3-manual'), []);
});

test('manual-equivalent verification requires traceable independent Tester and Reviewer Handoffs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cognis-manual-verification-'));
  try {
    await mkdir(path.join(root, 'evidence'), { recursive: true });
    await writeFile(path.join(root, 'evidence/test.txt'), 'tests passed\n', 'utf8');
    await writeFile(path.join(root, 'evidence/review.md'), '# Review\n\nApproved.\n', 'utf8');
    const manual = [
      { 角色: 'cognis_tester', 核验者: '人工测试员', 证据: 'evidence/test.txt', 变更集指纹: fingerprint, 结论: '通过', 时间: '2026-07-26T12:00:00.000Z' },
      { 角色: 'cognis_reviewer', 核验者: '人工审查员', 证据: 'evidence/review.md', 变更集指纹: fingerprint, 结论: '批准', 时间: '2026-07-26T12:01:00.000Z' },
    ];
    const handoffs = [
      ...returnedHandoffHistory({ 'Agent/运行收据': 'evidence/test.txt' }),
      ...returnedHandoffHistory({ 编号: 'HO-002', 来源角色: 'cognis_reviewer', 'Agent/运行收据': 'evidence/review.md', 时间: '2026-07-26T12:01:00.000Z' }),
    ];
    const taskControl = {
      ...control({ 独立核验模式: '人工等价', 人工等价核验: manual }),
      _taskResult: '完成',
      _taskStatus: '进行中',
    };
    assert.deepEqual(validateHandoffRecords({
      control: taskControl,
      currentFingerprint: fingerprint,
      evidence: [{ 证据类型: '命令', '命令或产物': 'pnpm check', 退出码: '0', 核验时间: '2026-07-26T12:02:00.000Z' }],
      file: 'docs/tasks/T-V3.md',
      handoffs,
      root,
    }), []);

    const selfApproved = structuredClone(taskControl);
    selfApproved.人工等价核验[1].核验者 = selfApproved.责任角色;
    assert.match(validateHandoffRecords({
      control: selfApproved, currentFingerprint: fingerprint, file: 'docs/tasks/T-V3.md', handoffs, root,
    }).join('\n'), /实现者|责任角色/u);

    const normalizedSelfApproval = structuredClone(taskControl);
    normalizedSelfApproval.责任角色 = 'Build Agent';
    normalizedSelfApproval.人工等价核验[0].核验者 = '  ｂｕｉｌｄ　ａｇｅｎｔ  ';
    assert.match(validateHandoffRecords({
      control: normalizedSelfApproval, currentFingerprint: fingerprint, file: 'docs/tasks/T-V3.md', handoffs, root,
    }).join('\n'), /实现者|责任角色/u);

    const normalizedDuplicate = structuredClone(taskControl);
    normalizedDuplicate.人工等价核验[0].核验者 = 'Alice';
    normalizedDuplicate.人工等价核验[1].核验者 = 'ＡＬＩＣＥ';
    assert.match(validateHandoffRecords({
      control: normalizedDuplicate, currentFingerprint: fingerprint, file: 'docs/tasks/T-V3.md', handoffs, root,
    }).join('\n'), /不同核验者/u);

    const blankVerifier = structuredClone(taskControl);
    blankVerifier.人工等价核验[0].核验者 = '   ';
    assert.match(validateHandoffRecords({
      control: blankVerifier, currentFingerprint: fingerprint, file: 'docs/tasks/T-V3.md', handoffs, root,
    }).join('\n'), /可追责核验者/u);

    const unicodeFoldedSelfApproval = structuredClone(taskControl);
    unicodeFoldedSelfApproval.责任角色 = 'Straße';
    unicodeFoldedSelfApproval.人工等价核验[0].核验者 = 'STRASSE';
    assert.match(validateHandoffRecords({
      control: unicodeFoldedSelfApproval, currentFingerprint: fingerprint, file: 'docs/tasks/T-V3.md', handoffs, root,
    }).join('\n'), /实现者|责任角色/u);

    const stale = structuredClone(taskControl);
    stale.人工等价核验[0].变更集指纹 = 'c'.repeat(64);
    assert.match(validateHandoffRecords({
      control: stale, currentFingerprint: fingerprint, file: 'docs/tasks/T-V3.md', handoffs, root,
    }).join('\n'), /指纹.*失效|不匹配/u);

    const escaped = structuredClone(taskControl);
    escaped.人工等价核验[0].证据 = '../outside.txt';
    assert.match(validateHandoffRecords({
      control: escaped, currentFingerprint: fingerprint, file: 'docs/tasks/T-V3.md', handoffs, root,
    }).join('\n'), /项目内相对路径/u);

    const directoryEvidence = structuredClone(taskControl);
    directoryEvidence.人工等价核验[0].证据 = 'evidence';
    const directoryHandoffs = structuredClone(handoffs);
    for (const record of directoryHandoffs.filter((item) => item.编号 === 'HO-001')) record['Agent/运行收据'] = 'evidence';
    assert.match(validateHandoffRecords({
      control: directoryEvidence, currentFingerprint: fingerprint, file: 'docs/tasks/T-V3.md', handoffs: directoryHandoffs, root,
    }).join('\n'), /常规文件/u);

    await writeFile(path.join(root, 'evidence/empty.txt'), '', 'utf8');
    const emptyEvidence = structuredClone(taskControl);
    emptyEvidence.人工等价核验[0].证据 = 'evidence/empty.txt';
    const emptyHandoffs = structuredClone(handoffs);
    for (const record of emptyHandoffs.filter((item) => item.编号 === 'HO-001')) record['Agent/运行收据'] = 'evidence/empty.txt';
    assert.match(validateHandoffRecords({
      control: emptyEvidence, currentFingerprint: fingerprint, file: 'docs/tasks/T-V3.md', handoffs: emptyHandoffs, root,
    }).join('\n'), /不得为空/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('task IR parses the same-file Handoff JSON and rejects missing fixed fields', () => {
  const valid = normalizeTaskDocument(parseTaskMarkdown('docs/tasks/T-V3.md', markdown({ handoffs: [handoff()] })));
  assert.equal(valid.controlVersion, 3);
  assert.deepEqual(valid.handoffs, [handoff()]);
  assert.deepEqual(valid._parsed.parseErrors, []);

  const invalid = handoff();
  delete invalid.恢复提示;
  const document = normalizeTaskDocument(parseTaskMarkdown('docs/tasks/T-V3.md', markdown({ handoffs: [invalid] })));
  const errors = validateTaskDocument({ document, root: rootDir, schema: {} }).join('\n');
  assert.match(errors, /交接记录.*恢复提示/u);
});

test('v3 Handoff state history rejects illegal transitions and duplicate receipt use', () => {
  const first = handoff({ 编号: 'HO-STAGE', 状态: '待接收' });
  const illegal = handoff({ 编号: 'HO-STAGE', 状态: '已返回', 时间: '2026-07-26T12:01:00.000Z' });
  const duplicate = handoff({ 编号: 'HO-OTHER', 时间: '2026-07-26T12:02:00.000Z' });
  const directReturn = handoff({ 编号: 'HO-DIRECT', 状态: '已返回', 时间: '2026-07-26T12:03:00.000Z' });
  const changedIdentity = handoff({
    编号: 'HO-STAGE', 状态: '已接收', 来源角色: 'cognis_reviewer', 时间: '2026-07-26T12:04:00.000Z',
  });
  const document = normalizeTaskDocument(parseTaskMarkdown(
    'docs/tasks/T-V3.md',
    markdown({ handoffs: [first, illegal, duplicate, directReturn, changedIdentity] }),
  ));
  const errors = validateTaskDocument({ document, root: rootDir, schema: {} }).join('\n');
  assert.match(errors, /非法.*待接收.*已返回/u);
  assert.match(errors, /运行收据.*重复/u);
  assert.match(errors, /首个状态必须为“待接收”/u);
  assert.match(errors, /身份字段“来源角色”不得改变/u);
});

test('completed v3 task requires fresh independent Tester and Reviewer receipts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cognis-v3-completion-'));
  try {
    await receipt(root);
    const tester = returnedHandoffHistory();
    const reviewer = returnedHandoffHistory({
      编号: 'HO-002',
      来源角色: 'cognis_reviewer',
      'Agent/运行收据': `.cognis/subagents/receipts/${'1'.repeat(64)}.json`,
      时间: '2026-07-26T12:01:00.000Z',
    });
    const missingReviewer = normalizeTaskDocument(parseTaskMarkdown(
      'docs/tasks/T-V3.md',
      markdown({ handoffs: tester, result: '完成', taskControl: control({ 红队审查结论: '批准' }) }),
    ));
    let errors = validateTaskDocument({ document: missingReviewer, root, schema: {} }).join('\n');
    assert.match(errors, /Reviewer.*有效回传/u);

    await receipt(root, {
      receiptId: '1'.repeat(64),
      role: 'cognis_reviewer',
      agentIdHash: '2'.repeat(64),
    });
    const stale = normalizeTaskDocument(parseTaskMarkdown(
      'docs/tasks/T-V3.md',
      markdown({
        handoffs: [...tester, ...reviewer],
        result: '完成',
        taskControl: control({ 红队审查结论: '批准' }),
      }),
    ));
    errors = validateTaskDocument({ document: stale, root, schema: {} }).join('\n');
    assert.match(errors, /变更集指纹.*失效|integrity/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('paused v3 tasks require a resume Handoff', () => {
  const document = normalizeTaskDocument(parseTaskMarkdown(
    'docs/tasks/T-V3.md',
    `${markdown({ handoffs: [], status: '等待依赖' })}\n## 恢复提示\n\n等待依赖后继续。\n`,
  ));
  assert.match(validateTaskDocument({ document, root: rootDir, schema: {} }).join('\n'), /暂停恢复/u);
});

test('workspace fingerprint ignores governance evidence but changes for implementation edits', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cognis-fingerprint-'));
  try {
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Cognis Test'], { cwd: root });
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src/example.js'), 'export const value = 1;\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: root });
    const before = await computeWorkspaceFingerprint(root);
    await mkdir(path.join(root, 'docs/tasks'), { recursive: true });
    await writeFile(path.join(root, 'docs/tasks/T.md'), '# task\n', 'utf8');
    assert.equal(await computeWorkspaceFingerprint(root), before);
    await writeFile(path.join(root, 'src/example.js'), 'export const value = 2;\n', 'utf8');
    assert.notEqual(await computeWorkspaceFingerprint(root), before);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('receipt inspection rejects symlinked roots and reports malformed or duplicate receipts', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'cognis-receipts-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'cognis-receipts-outside-'));
  try {
    await mkdir(path.join(root, '.cognis/subagents'), { recursive: true });
    try {
      await symlink(outside, path.join(root, '.cognis/subagents/receipts'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
        context.skip('Windows symlink creation is unavailable');
        return;
      }
      throw error;
    }
    const report = await inspectSubagentReceipts(root);
    assert.equal(report.status, 'invalid');
    assert.match(report.reasons.join('\n'), /symbolic link|reparse|symlink/iu);
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  }
});

test('subagent receipts continue incomplete output once and never persist raw identifiers or output', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cognis-receipt-lifecycle-'));
  try {
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Cognis Test'], { cwd: root });
    await writeFile(path.join(root, 'tracked.txt'), 'baseline\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: root });
    const input = {
      agentId: 'raw-agent-id',
      agentType: 'cognis_tester',
      lastAssistantMessage: '状态：完成',
      sessionId: 'raw-session-id',
      stopHookActive: false,
      turnId: 'raw-turn-id',
    };
    const started = await startSubagentReceipt(root, input);
    const first = await finishSubagentReceipt(root, input);
    assert.equal(first.block, true);
    assert.equal(first.receipt.continuationCount, 1);
    const second = await finishSubagentReceipt(root, input);
    assert.equal(second.block, false);
    assert.equal(second.receipt.status, 'invalid');
    const persisted = await readFile(path.join(root, started.relativePath), 'utf8');
    assert.doesNotMatch(persisted, /raw-agent-id|raw-session-id|raw-turn-id|状态：完成/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Tester receipt becomes invalid after a Git-visible mutation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cognis-receipt-mutation-'));
  try {
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Cognis Test'], { cwd: root });
    await writeFile(path.join(root, 'tracked.txt'), 'baseline\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: root });
    const output = [
      '状态：通过', '变更摘要：未修改', '变更路径：无', '验证证据：node --test 通过',
      '未验证项：无', '剩余风险：无', '下一步动作：返回父 Agent',
    ].join('\n');
    const input = {
      agentId: 'tester-mutation', agentType: 'cognis_tester', lastAssistantMessage: output,
      sessionId: 'session-mutation', stopHookActive: false, turnId: 'turn-mutation',
    };
    await startSubagentReceipt(root, input);
    await writeFile(path.join(root, 'tracked.txt'), 'changed by tester\n', 'utf8');
    const finished = await finishSubagentReceipt(root, input);
    assert.equal(finished.block, false);
    assert.equal(finished.receipt.status, 'invalid');
    assert.equal(finished.receipt.invalidReason, 'workspace-fingerprint-changed');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('complete negative role conclusions terminate without continuation or approval', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cognis-receipt-conclusions-'));
  try {
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Cognis Test'], { cwd: root });
    await writeFile(path.join(root, 'tracked.txt'), 'baseline\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: root });
    const fields = [
      '变更摘要：无', '变更路径：无', '验证证据：已检查', '未验证项：无',
      '剩余风险：存在', '下一步动作：返回父 Agent',
    ];
    const tester = {
      agentId: 'tester-failed', agentType: 'cognis_tester', sessionId: 'session-conclusions',
      stopHookActive: false, turnId: 'turn-tester', lastAssistantMessage: ['状态：阻塞', ...fields].join('\n'),
    };
    await startSubagentReceipt(root, tester);
    const testerFinished = await finishSubagentReceipt(root, tester);
    assert.equal(testerFinished.block, false);
    assert.equal(testerFinished.receipt.status, 'invalid');
    assert.equal(testerFinished.receipt.continuationCount, 0);
    assert.equal(testerFinished.receipt.outputValidation.status, 'valid');
    assert.equal(testerFinished.receipt.outputValidation.conclusion, 'blocked');

    const reviewer = {
      agentId: 'reviewer-changes', agentType: 'cognis_reviewer', sessionId: 'session-conclusions',
      stopHookActive: false, turnId: 'turn-reviewer', lastAssistantMessage: ['状态：要求修改', ...fields].join('\n'),
    };
    await startSubagentReceipt(root, reviewer);
    const reviewerFinished = await finishSubagentReceipt(root, reviewer);
    assert.equal(reviewerFinished.block, false);
    assert.equal(reviewerFinished.receipt.status, 'invalid');
    assert.equal(reviewerFinished.receipt.continuationCount, 0);
    assert.equal(reviewerFinished.receipt.outputValidation.status, 'valid');
    assert.equal(reviewerFinished.receipt.outputValidation.conclusion, 'changes-requested');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('subagent output rejects fenced, quoted, and duplicate approval fields', () => {
  const fields = [
    '变更摘要：无', '变更路径：无', '验证证据：已检查', '未验证项：无',
    '剩余风险：无', '下一步动作：返回父 Agent',
  ];
  const fenced = validateSubagentOutput('cognis_reviewer', [
    '本人未给出批准结论。',
    '```markdown',
    '状态：批准',
    ...fields,
    '```',
  ].join('\n'));
  assert.equal(fenced.status, 'invalid');
  assert.notEqual(fenced.conclusion, 'approved');

  const quoted = validateSubagentOutput('cognis_reviewer', [
    '> 状态：批准',
    ...fields,
  ].join('\n'));
  assert.equal(quoted.status, 'invalid');
  assert.notEqual(quoted.conclusion, 'approved');

  const duplicate = validateSubagentOutput('cognis_reviewer', [
    '状态：批准',
    '状态：要求修改',
    ...fields,
  ].join('\n'));
  assert.equal(duplicate.status, 'invalid');
  assert.equal(duplicate.missing.some((item) => item.includes('只能出现一次')), true);

  const falseClosingFence = validateSubagentOutput('cognis_reviewer', [
    '```markdown',
    'Reviewer has not approved this change.',
    '```not-a-valid-closing-fence',
    '状态：批准',
    ...fields,
    '```',
  ].join('\n'));
  assert.equal(falseClosingFence.status, 'invalid');
  assert.notEqual(falseClosingFence.conclusion, 'approved');

  const nestedList = validateSubagentOutput('cognis_reviewer', [
    '- 状态：批准',
    ...fields.map((field) => `  ${field}`),
  ].join('\n'));
  assert.equal(nestedList.status, 'invalid');
  assert.notEqual(nestedList.conclusion, 'approved');

  const lazyBlockquote = validateSubagentOutput('cognis_reviewer', [
    '> This quote contains the apparent approval packet.',
    '状态：批准',
    ...fields,
  ].join('\n'));
  assert.equal(lazyBlockquote.status, 'invalid');
  assert.notEqual(lazyBlockquote.conclusion, 'approved');
});

test('a governed role can start a new turn after its prior receipt became invalid', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cognis-receipt-retry-'));
  try {
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Cognis Test'], { cwd: root });
    await writeFile(path.join(root, 'tracked.txt'), 'baseline\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: root });
    const fields = [
      '变更摘要：无', '变更路径：无', '验证证据：已检查', '未验证项：无',
      '剩余风险：无', '下一步动作：返回父 Agent',
    ];
    const first = {
      agentId: 'reused-reviewer', agentType: 'cognis_reviewer', sessionId: 'session-retry',
      stopHookActive: false, turnId: 'turn-first', lastAssistantMessage: ['状态：要求修改', ...fields].join('\n'),
    };
    await startSubagentReceipt(root, first);
    const rejected = await finishSubagentReceipt(root, first);
    assert.equal(rejected.receipt.status, 'invalid');
    const duplicate = await startSubagentReceipt(root, first).then(
      () => null,
      (error) => error,
    );
    assert.match(duplicate?.message ?? '', /already exists/u);
    assert.equal(duplicate?.cause?.code, 'EEXIST');

    const second = {
      ...first,
      turnId: 'turn-second',
      lastAssistantMessage: ['状态：批准', ...fields].join('\n'),
    };
    await startSubagentReceipt(root, second);
    const approved = await finishSubagentReceipt(root, second);
    assert.equal(approved.receipt.status, 'sealed');
    assert.equal(approved.receipt.outputValidation.conclusion, 'approved');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('a subagent run uses a stable receipt key and concurrent starts are atomic', async () => {
  const roots = await Promise.all([
    mkdtemp(path.join(tmpdir(), 'cognis-receipt-key-a-')),
    mkdtemp(path.join(tmpdir(), 'cognis-receipt-key-b-')),
    mkdtemp(path.join(tmpdir(), 'cognis-receipt-key-race-')),
  ]);
  try {
    for (const root of roots) {
      await execFileAsync('git', ['init'], { cwd: root });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
      await execFileAsync('git', ['config', 'user.name', 'Cognis Test'], { cwd: root });
      await writeFile(path.join(root, 'tracked.txt'), 'baseline\n', 'utf8');
      await execFileAsync('git', ['add', '.'], { cwd: root });
      await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: root });
    }
    const input = {
      agentId: 'atomic-reviewer', agentType: 'cognis_reviewer', sessionId: 'session-atomic',
      turnId: 'turn-atomic',
    };
    const first = await startSubagentReceipt(roots[0], input, { now: new Date('2026-07-26T12:00:00.000Z') });
    const second = await startSubagentReceipt(roots[1], input, { now: new Date('2026-07-26T12:00:01.000Z') });
    assert.equal(first.receipt.receiptId, second.receipt.receiptId);

    const attempts = await Promise.allSettled([
      startSubagentReceipt(roots[2], input, { now: new Date('2026-07-26T12:00:02.000Z') }),
      startSubagentReceipt(roots[2], input, { now: new Date('2026-07-26T12:00:03.000Z') }),
    ]);
    assert.equal(attempts.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter((item) => item.status === 'rejected').length, 1);
    const rejected = attempts.find((item) => item.status === 'rejected');
    assert.equal(rejected.reason.cause?.code, 'EEXIST');
    assert.equal((await inspectSubagentReceipts(roots[2])).receipts.length, 1);
  } finally {
    await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true })));
  }
});

test('v1 receipts remain legacy-only and cannot satisfy the v3 Handoff gate', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cognis-receipt-v1-'));
  const malformedRoot = await mkdtemp(path.join(tmpdir(), 'cognis-receipt-v1-malformed-'));
  const stableJson = (item) => {
    if (Array.isArray(item)) return `[${item.map(stableJson).join(',')}]`;
    if (item && typeof item === 'object') return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${stableJson(item[key])}`).join(',')}}`;
    return JSON.stringify(item);
  };
  try {
    const legacy = {
      schemaVersion: 1,
      receiptId,
      sessionIdHash: 'c'.repeat(64),
      agentIdHash: 'd'.repeat(64),
      turnIdHash: 'e'.repeat(64),
    };
    legacy.integrityHash = createHash('sha256')
      .update(`cognis-subagent-receipt-integrity-v1\0${stableJson(legacy)}`)
      .digest('hex');
    await mkdir(path.join(root, '.cognis/subagents/receipts'), { recursive: true });
    await writeFile(path.join(root, receiptPath), `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');

    const report = await inspectSubagentReceipts(root);
    assert.equal(report.status, 'healthy');
    assert.equal(report.counts.legacy, 1);
    assert.deepEqual(report.receipts, []);

    const taskControl = { ...control(), _taskResult: '完成', _taskStatus: '进行中' };
    const errors = validateHandoffRecords({
      control: taskControl,
      currentFingerprint: fingerprint,
      evidence: [{ 证据类型: '命令', '命令或产物': 'pnpm check', 退出码: '0', 核验时间: '2026-07-26T12:02:00.000Z' }],
      file: 'docs/tasks/T-V3.md',
      handoffs: returnedHandoffHistory(),
      root,
    }).join('\n');
    assert.match(errors, /运行收据版本.*不匹配/u);

    const malformed = { ...legacy, integrityHash: 'f'.repeat(64) };
    await mkdir(path.join(malformedRoot, '.cognis/subagents/receipts'), { recursive: true });
    await writeFile(path.join(malformedRoot, receiptPath), `${JSON.stringify(malformed, null, 2)}\n`, 'utf8');
    const malformedReport = await inspectSubagentReceipts(malformedRoot);
    assert.equal(malformedReport.status, 'invalid');
    assert.match(malformedReport.reasons.join('\n'), /integrity hash mismatch/u);
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(malformedRoot, { force: true, recursive: true });
  }
});

test('exclusive receipt writes remove a newly created target after serialization failure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cognis-receipt-write-failure-'));
  const target = path.join(root, 'receipt.json');
  try {
    await assert.rejects(writeExclusive(target, { unsupported: 1n }), /BigInt|serialize/iu);
    await assert.rejects(lstat(target), { code: 'ENOENT' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Tester receipt becomes invalid when protected task evidence changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cognis-receipt-evidence-'));
  try {
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Cognis Test'], { cwd: root });
    await mkdir(path.join(root, 'docs/tasks'), { recursive: true });
    await writeFile(path.join(root, 'tracked.txt'), 'baseline\n', 'utf8');
    await writeFile(path.join(root, 'docs/tasks/T.md'), '# before\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: root });
    const output = [
      '状态：通过', '变更摘要：未修改', '变更路径：无', '验证证据：node --test 通过',
      '未验证项：无', '剩余风险：无', '下一步动作：返回父 Agent',
    ].join('\n');
    const input = {
      agentId: 'tester-evidence', agentType: 'cognis_tester', lastAssistantMessage: output,
      sessionId: 'session-evidence', stopHookActive: false, turnId: 'turn-evidence',
    };
    await startSubagentReceipt(root, input);
    await writeFile(path.join(root, 'docs/tasks/T.md'), '# changed by tester\n', 'utf8');
    const finished = await finishSubagentReceipt(root, input);
    assert.equal(finished.receipt.status, 'invalid');
    assert.equal(finished.receipt.invalidReason, 'protected-evidence-changed');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('completed v3 single task requires integration evidence after both receipts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cognis-single-integration-'));
  try {
    await receipt(root);
    await receipt(root, {
      receiptId: '1'.repeat(64),
      role: 'cognis_reviewer',
      agentIdHash: '2'.repeat(64),
    });
    const handoffs = [
      ...returnedHandoffHistory(),
      ...returnedHandoffHistory({
        编号: 'HO-002', 来源角色: 'cognis_reviewer',
        'Agent/运行收据': `.cognis/subagents/receipts/${'1'.repeat(64)}.json`,
        时间: '2026-07-26T12:01:00.000Z',
      }),
    ];
    const taskControl = { ...control(), _taskResult: '完成', _taskStatus: '进行中' };
    const stale = validateHandoffRecords({
      control: taskControl,
      currentFingerprint: fingerprint,
      evidence: [{ 证据类型: '命令', '命令或产物': 'pnpm check', 退出码: '0', 核验时间: '2026-07-26T11:58:30.000Z' }],
      file: 'docs/tasks/T-V3.md',
      handoffs,
      root,
    }).join('\n');
    assert.match(stale, /Tester\/Reviewer 回传后的本轮成功证据/u);
    const fresh = validateHandoffRecords({
      control: taskControl,
      currentFingerprint: fingerprint,
      evidence: [{ 证据类型: '命令', '命令或产物': 'pnpm check', 退出码: '0', 核验时间: '2026-07-26T12:02:00.000Z' }],
      file: 'docs/tasks/T-V3.md',
      handoffs,
      root,
    });
    assert.equal(fresh.some((error) => error.includes('集成验证缺少')), false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('completed v3 child skips parent fan-in integration evidence', () => {
  const child = {
    ...control({ 任务类型: '子任务', 父任务编号: 'T-PARENT' }),
    _taskResult: '完成',
    _taskStatus: '进行中',
  };
  delete child.集成验证;
  const errors = validateHandoffRecords({
    control: child,
    currentFingerprint: fingerprint,
    evidence: [],
    file: 'docs/tasks/T-CHILD.md',
    handoffs: [],
    root: rootDir,
  });
  assert.equal(errors.some((error) => error.includes('集成验证')), false);
});

test('v3 receipts cannot be reused across task documents', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cognis-cross-task-receipts-'));
  try {
    await mkdir(path.join(root, 'docs/tasks'), { recursive: true });
    await mkdir(path.join(root, 'docs/schemas'), { recursive: true });
    for (const name of ['full-task-control.schema.json', 'handoff-record.schema.json', 'subagent-receipt.schema.json']) {
      await copyFile(path.join(rootDir, 'schemas', name), path.join(root, 'docs/schemas', name));
    }
    const shared = returnedHandoffHistory();
    await writeFile(path.join(root, 'docs/tasks/T-ONE.md'), markdown({ handoffs: shared }), 'utf8');
    await writeFile(path.join(root, 'docs/tasks/T-TWO.md'), markdown({ handoffs: shared }), 'utf8');
    assert.match(validateTasks(root).join('\n'), /运行收据.*跨任务|跨任务.*运行收据/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
