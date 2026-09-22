import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import test from 'node:test';

import { runCommand } from '../../runtime/commands/run.mjs';

// Task anchors are the long-task state contract of runtime/commands/run.mjs:
// init/update stay dry-run until --write, receipts record the exact command
// set that produced them, and `verify --reuse` may only replay a receipt when
// neither the working-tree fingerprint nor that command set moved.

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '../..');

async function tempProject() {
  return mkdtemp(path.join(tmpdir(), 'vibe-harness-project-task-'));
}

async function writeConfig(project, validationCommands) {
  await writeFile(
    path.join(project, 'vibe-harness.config.json'),
    `${JSON.stringify({ validationCommands }, null, 2)}\n`,
    'utf8',
  );
}

// Every git fixture pins core.excludesFile to a committed empty file: whether
// the anchor directory is visible to the fingerprint must depend on the
// fixture's own .gitignore, never on the developer machine's global ignores.
async function initGitProject(project, gitignore) {
  await writeFile(path.join(project, 'empty-excludes'), '', 'utf8');
  if (gitignore !== undefined) await writeFile(path.join(project, '.gitignore'), gitignore, 'utf8');
  await execFileAsync('git', ['init', '--quiet'], { cwd: project });
  await execFileAsync('git', ['config', 'core.excludesFile', path.join(project, 'empty-excludes')], { cwd: project });
  await execFileAsync('git', ['config', 'user.email', 'fixture@example.com'], { cwd: project });
  await execFileAsync('git', ['config', 'user.name', 'Fixture'], { cwd: project });
  await execFileAsync('git', ['add', '.'], { cwd: project });
  await execFileAsync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: project });
}

function anchorPath(project, taskId) {
  return path.join(project, '.vibe-harness', 'tasks', `${taskId}.json`);
}

async function readAnchor(project, taskId) {
  return JSON.parse(await readFile(anchorPath(project, taskId), 'utf8'));
}

function receiptFixture({ fingerprint = 'fp-1', status = 'passed' } = {}) {
  return {
    command: 'verify',
    status,
    verification: {
      id: 'receipt-1',
      finishedAt: '2026-01-02T03:04:05.000Z',
      fingerprint,
      before: { head: 'head-before' },
      after: { head: 'head-after' },
    },
    checks: {
      test: { status: 'passed', command: 'test=node -e "process.exit(0)"' },
    },
  };
}

async function recordReceipt(project, taskId, unitId, report) {
  await runCommand(['task', 'init', taskId, '--title', 'Fixture', '--goal', 'Record the receipt', '--write', '--json'], { cwd: project });
  const update = await runCommand(['task', 'update', taskId, '--unit', unitId, '--verification', JSON.stringify(report), '--write', '--json'], { cwd: project });
  assert.equal(update.report.status, 'passed');
}

test('task init 在 --write 前保持 dry-run，写入后落盘锚点', async () => {
  const project = await tempProject();
  try {
    const dry = await runCommand(['task', 'init', 'alpha', '--title', 'Anchor A', '--goal', 'Ship the anchor flow', '--json'], { cwd: project });
    assert.equal(dry.exitCode, 0);
    assert.equal(dry.report.status, 'planned');
    assert.equal(dry.report.dryRun, true);
    assert.equal(dry.report.write, false);
    assert.equal(dry.report.written, false);
    assert.equal(dry.report.path, '.vibe-harness/tasks/alpha.json');
    assert.equal(dry.report.anchor.stage, 'plan');
    assert.equal(dry.report.anchor.riskLevel, 'light');
    await assert.rejects(readFile(anchorPath(project, 'alpha'), 'utf8'), { code: 'ENOENT' });

    const wet = await runCommand(['task', 'init', 'alpha', '--title', 'Anchor A', '--goal', 'Ship the anchor flow', '--write', '--json'], { cwd: project });
    assert.equal(wet.exitCode, 0);
    assert.equal(wet.report.status, 'passed');
    assert.equal(wet.report.written, true);
    assert.equal('dryRun' in wet.report, false);

    const anchor = await readAnchor(project, 'alpha');
    assert.equal(anchor.schemaVersion, 1);
    assert.equal(anchor.taskId, 'alpha');
    assert.equal(anchor.title, 'Anchor A');
    assert.equal(anchor.stage, 'plan');
    assert.equal(anchor.riskLevel, 'light');
    assert.equal(anchor.goal, 'Ship the anchor flow');
    assert.deepEqual(anchor.acceptance, []);
    assert.deepEqual(anchor.units, []);
    assert.deepEqual(anchor.decisions, []);
    assert.deepEqual(anchor.blockers, []);
    assert.deepEqual(anchor.failures, []);
    assert.equal(anchor.nextAction, null);
    assert.equal(anchor.sessions.length, 1);
    assert.equal(anchor.sessions[0].action, 'init');
    assert.equal(typeof anchor.updatedAt, 'string');
    const raw = await readFile(anchorPath(project, 'alpha'), 'utf8');
    assert.ok(raw.endsWith('\n'));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('task init 拒绝重复锚点、缺失字段与未知风险级别', async () => {
  const project = await tempProject();
  try {
    const created = await runCommand(['task', 'init', 'beta', '--title', 'B', '--goal', 'G', '--write', '--json'], { cwd: project });
    assert.equal(created.report.status, 'passed');

    const duplicate = await runCommand(['task', 'init', 'beta', '--title', 'B', '--goal', 'G', '--write', '--json'], { cwd: project });
    assert.equal(duplicate.exitCode, 1);
    assert.equal(duplicate.report.status, 'failed');
    assert.match(duplicate.report.error, /already exists/u);

    const noTitle = await runCommand(['task', 'init', 'gamma', '--goal', 'G', '--json'], { cwd: project });
    assert.equal(noTitle.report.status, 'failed');
    assert.match(noTitle.report.error, /needs --title/u);

    const noGoal = await runCommand(['task', 'init', 'gamma', '--title', 'T', '--json'], { cwd: project });
    assert.equal(noGoal.report.status, 'failed');
    assert.match(noGoal.report.error, /needs --goal/u);

    const badRisk = await runCommand(['task', 'init', 'gamma', '--title', 'T', '--goal', 'G', '--risk-level', 'extreme', '--json'], { cwd: project });
    assert.equal(badRisk.report.status, 'failed');
    assert.match(badRisk.report.error, /--risk-level must be one of/u);

    const full = await runCommand([
      'task', 'init', 'gamma', '--title', 'T', '--goal', 'G', '--risk-level', 'full',
      '--acceptance', 'first', '--acceptance', 'second', '--write', '--json',
    ], { cwd: project });
    assert.equal(full.report.status, 'passed');
    const anchor = await readAnchor(project, 'gamma');
    assert.equal(anchor.riskLevel, 'full');
    assert.deepEqual(anchor.acceptance, ['first', 'second']);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('task 命令拒绝非法 task id 且不创建 tasks 目录', async () => {
  const project = await tempProject();
  try {
    for (const taskId of ['a/b', '[x]', 'CON', '.hidden']) {
      const result = await runCommand(['task', 'init', taskId, '--title', 'T', '--goal', 'G', '--write', '--json'], { cwd: project });
      assert.equal(result.exitCode, 1, taskId);
      assert.equal(result.report.status, 'failed', taskId);
      assert.equal(result.report.code, 'VIBE_HARNESS_INVALID_TASK_ID', taskId);
    }
    const status = await runCommand(['task', 'status', 'bad/id', '--json'], { cwd: project });
    assert.equal(status.report.status, 'failed');
    assert.equal(status.report.code, 'VIBE_HARNESS_INVALID_TASK_ID');
    await assert.rejects(readdir(path.join(project, '.vibe-harness', 'tasks')), { code: 'ENOENT' });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('task update 记录阶段、单元状态、决策、阻塞项与下一步', async () => {
  const project = await tempProject();
  try {
    await runCommand(['task', 'init', 'flow', '--title', 'Flow', '--goal', 'Ship it', '--write', '--json'], { cwd: project });
    const update = await runCommand([
      'task', 'update', 'flow',
      '--stage', 'implement',
      '--unit-status', 'u1:in_progress',
      '--decision', 'use anchors over ad-hoc notes',
      '--blocker', 'waiting on review',
      '--next-action', 'finish the unit',
      '--write', '--json',
    ], { cwd: project });
    assert.equal(update.exitCode, 0);
    assert.equal(update.report.status, 'passed');
    assert.equal(update.report.written, true);
    assert.deepEqual(update.report.changes, ['stage', 'unit-status:u1', 'decision', 'blocker', 'nextAction']);

    const anchor = await readAnchor(project, 'flow');
    assert.equal(anchor.stage, 'implement');
    assert.deepEqual(anchor.units.map((unit) => unit.id), ['u1']);
    assert.equal(anchor.units[0].status, 'in_progress');
    assert.deepEqual(anchor.decisions, ['use anchors over ad-hoc notes']);
    assert.deepEqual(anchor.blockers, ['waiting on review']);
    assert.equal(anchor.nextAction, 'finish the unit');
    assert.equal(anchor.sessions.length, 2);

    const status = await runCommand(['task', 'status', 'flow', '--json'], { cwd: project });
    assert.equal(status.exitCode, 0);
    assert.equal(status.report.status, 'ready');
    assert.deepEqual(status.report.pendingUnits, ['u1']);
    assert.match(status.report.resumeHint, /\.vibe-harness\/tasks\/flow\.json/u);
    assert.match(status.report.resumeHint, /do not re-read rule bodies/u);
    assert.match(status.report.resumeHint, /stage: implement/u);
    assert.match(status.report.resumeHint, /pending units: u1/u);
    assert.match(status.report.resumeHint, /next action: finish the unit/u);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('重复执行相同的 task update 不产生任何变更', async () => {
  const project = await tempProject();
  try {
    await runCommand(['task', 'init', 'stable', '--title', 'S', '--goal', 'G', '--write', '--json'], { cwd: project });
    const argv = [
      'task', 'update', 'stable', '--stage', 'implement', '--unit-status', 'u1:done',
      '--decision', 'd1', '--next-action', 'n1', '--write', '--json',
    ];
    const first = await runCommand(argv, { cwd: project });
    assert.equal(first.report.changed, true);
    assert.equal(first.report.written, true);
    const before = await readFile(anchorPath(project, 'stable'), 'utf8');

    const second = await runCommand(argv, { cwd: project });
    assert.equal(second.exitCode, 0);
    assert.equal(second.report.status, 'passed');
    assert.equal(second.report.changed, false);
    assert.equal(second.report.written, false);
    assert.deepEqual(second.report.changes, []);
    const after = await readFile(anchorPath(project, 'stable'), 'utf8');
    assert.equal(after, before);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('task update 登记失败并按文本去重，status 提示最近失败', async () => {
  const project = await tempProject();
  try {
    await runCommand(['task', 'init', 'flaky', '--title', 'F', '--goal', 'G', '--write', '--json'], { cwd: project });
    const update = await runCommand([
      'task', 'update', 'flaky',
      '--failure', 'test:unit 在 policy.mjs 用例超时',
      '--failure', 'test:unit 在 policy.mjs 用例超时',
      '--failure', 'eval:check reference 指纹漂移',
      '--write', '--json',
    ], { cwd: project });
    assert.equal(update.exitCode, 0);
    assert.equal(update.report.status, 'passed');
    assert.equal(update.report.written, true);
    assert.equal(update.report.changes.filter((change) => change === 'failure').length, 2);
    assert.equal(update.report.anchor.failures.length, 2);

    const anchor = await readAnchor(project, 'flaky');
    assert.deepEqual(anchor.failures.map((item) => item.text), [
      'test:unit 在 policy.mjs 用例超时',
      'eval:check reference 指纹漂移',
    ]);
    for (const entry of anchor.failures) {
      assert.equal(typeof entry.at, 'string');
      assert.ok(entry.at.length > 0);
    }

    const repeat = await runCommand([
      'task', 'update', 'flaky', '--failure', 'test:unit 在 policy.mjs 用例超时', '--write', '--json',
    ], { cwd: project });
    assert.equal(repeat.report.changed, false);
    assert.equal(repeat.report.written, false);
    assert.deepEqual(repeat.report.changes, []);
    const after = await readAnchor(project, 'flaky');
    assert.equal(after.failures.length, 2);

    await runCommand([
      'task', 'update', 'flaky', '--failure', 'test:component documentation 断言过期', '--write', '--json',
    ], { cwd: project });
    const status = await runCommand(['task', 'status', 'flaky', '--json'], { cwd: project });
    assert.equal(status.exitCode, 0);
    assert.equal(status.report.failures.length, 3);
    assert.match(status.report.resumeHint, /recent failure: test:component documentation 断言过期/u);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('task update 校验入参并拒绝缺失锚点的任务', async () => {
  const project = await tempProject();
  try {
    const missing = await runCommand(['task', 'update', 'ghost', '--stage', 'implement', '--write', '--json'], { cwd: project });
    assert.equal(missing.exitCode, 1);
    assert.equal(missing.report.status, 'failed');
    assert.match(missing.report.error, /no anchor for task ghost/u);

    await runCommand(['task', 'init', 'checks', '--title', 'C', '--goal', 'G', '--write', '--json'], { cwd: project });

    const noUnit = await runCommand(['task', 'update', 'checks', '--verification', '{"command":"verify"}', '--write', '--json'], { cwd: project });
    assert.equal(noUnit.report.status, 'failed');
    assert.match(noUnit.report.error, /--verification requires --unit/u);

    const badStage = await runCommand(['task', 'update', 'checks', '--stage', 'deliver', '--write', '--json'], { cwd: project });
    assert.equal(badStage.report.status, 'failed');
    assert.match(badStage.report.error, /--stage must be one of/u);

    const badStatus = await runCommand(['task', 'update', 'checks', '--unit-status', 'u1:finished', '--write', '--json'], { cwd: project });
    assert.equal(badStatus.report.status, 'failed');
    assert.match(badStatus.report.error, /--unit-status/u);

    const noSeparator = await runCommand(['task', 'update', 'checks', '--unit-status', 'u1', '--write', '--json'], { cwd: project });
    assert.equal(noSeparator.report.status, 'failed');
    assert.match(noSeparator.report.error, /--unit-status/u);

    const badUnitId = await runCommand(['task', 'update', 'checks', '--unit-status', 'a/b:done', '--write', '--json'], { cwd: project });
    assert.equal(badUnitId.report.status, 'failed');
    assert.equal(badUnitId.report.code, 'VIBE_HARNESS_INVALID_TASK_ID');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('task update 以内联与文件两种方式记录 verify 收据', async () => {
  const project = await tempProject();
  try {
    await runCommand(['task', 'init', 'receipts', '--title', 'R', '--goal', 'G', '--write', '--json'], { cwd: project });

    const inline = await runCommand(['task', 'update', 'receipts', '--unit', 'u1', '--verification', JSON.stringify(receiptFixture()), '--write', '--json'], { cwd: project });
    assert.equal(inline.report.status, 'passed');
    assert.ok(inline.report.changes.includes('verification:u1'));

    await writeFile(path.join(project, '.vibe-harness', 'receipt.json'), JSON.stringify(receiptFixture({ fingerprint: 'fp-2' })), 'utf8');
    const fromFile = await runCommand(['task', 'update', 'receipts', '--unit', 'u2', '--verification', '.vibe-harness/receipt.json', '--write', '--json'], { cwd: project });
    assert.equal(fromFile.report.status, 'passed');

    const failedReceipt = await runCommand(['task', 'update', 'receipts', '--unit', 'u3', '--verification', JSON.stringify(receiptFixture({ status: 'failed' })), '--write', '--json'], { cwd: project });
    assert.equal(failedReceipt.report.status, 'passed');

    const anchor = await readAnchor(project, 'receipts');
    assert.equal(anchor.units.length, 3);
    const u1 = anchor.units.find((unit) => unit.id === 'u1');
    assert.equal(u1.verification.command, 'test=test=node -e "process.exit(0)"');
    assert.equal(u1.verification.status, 'passed');
    assert.equal(u1.verification.exitCode, 0);
    assert.equal(u1.verification.fingerprint, 'fp-1');
    assert.equal(u1.verification.at, '2026-01-02T03:04:05.000Z');
    assert.equal(u1.verification.id, 'receipt-1');
    assert.equal(u1.verification.finishedAt, '2026-01-02T03:04:05.000Z');
    assert.equal(u1.verification.beforeHead, 'head-before');
    assert.equal(u1.verification.afterHead, 'head-after');
    const u2 = anchor.units.find((unit) => unit.id === 'u2');
    assert.equal(u2.verification.fingerprint, 'fp-2');
    const u3 = anchor.units.find((unit) => unit.id === 'u3');
    assert.equal(u3.verification.status, 'failed');
    assert.equal(u3.verification.exitCode, 1);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('task update 拒绝不可读与非 verify 的收据', async () => {
  const project = await tempProject();
  try {
    await runCommand(['task', 'init', 'bad-receipts', '--title', 'B', '--goal', 'G', '--write', '--json'], { cwd: project });

    const unreadable = await runCommand(['task', 'update', 'bad-receipts', '--unit', 'u1', '--verification', '.vibe-harness/missing.json', '--write', '--json'], { cwd: project });
    assert.equal(unreadable.exitCode, 1);
    assert.equal(unreadable.report.status, 'failed');
    assert.equal(unreadable.report.code, 'VIBE_HARNESS_VERIFICATION_RECEIPT_UNREADABLE');

    const notVerify = await runCommand(['task', 'update', 'bad-receipts', '--unit', 'u1', '--verification', JSON.stringify({ command: 'env', status: 'ready' }), '--write', '--json'], { cwd: project });
    assert.equal(notVerify.report.status, 'failed');
    assert.equal(notVerify.report.code, 'VIBE_HARNESS_VERIFICATION_RECEIPT_INVALID');

    await writeFile(path.join(project, '.vibe-harness', 'not-json.json'), 'not json at all', 'utf8');
    const notJson = await runCommand(['task', 'update', 'bad-receipts', '--unit', 'u1', '--verification', '.vibe-harness/not-json.json', '--write', '--json'], { cwd: project });
    assert.equal(notJson.report.status, 'failed');
    assert.equal(notJson.report.code, 'VIBE_HARNESS_VERIFICATION_RECEIPT_INVALID');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('task status 与 list 汇总锚点并容忍损坏文件', async () => {
  const project = await tempProject();
  try {
    const emptyList = await runCommand(['task', 'list', '--json'], { cwd: project });
    assert.equal(emptyList.exitCode, 0);
    assert.equal(emptyList.report.status, 'ready');
    assert.equal(emptyList.report.count, 0);
    assert.equal(emptyList.report.invalidCount, 0);
    assert.deepEqual(emptyList.report.tasks, []);

    const missing = await runCommand(['task', 'status', 'ghost', '--json'], { cwd: project });
    assert.equal(missing.exitCode, 1);
    assert.equal(missing.report.status, 'failed');
    assert.match(missing.report.error, /no anchor for task ghost/u);

    await runCommand(['task', 'init', 'good', '--title', 'Good', '--goal', 'G', '--write', '--json'], { cwd: project });
    await runCommand(['task', 'update', 'good', '--unit-status', 'u1:done', '--unit-status', 'u2:pending', '--write', '--json'], { cwd: project });
    await writeFile(path.join(project, '.vibe-harness', 'tasks', 'broken.json'), '{ not json', 'utf8');
    await writeFile(path.join(project, '.vibe-harness', 'tasks', 'not a task.json'), '{}', 'utf8');
    await writeFile(path.join(project, '.vibe-harness', 'tasks', 'notes.txt'), 'x', 'utf8');

    const list = await runCommand(['task', 'list', '--json'], { cwd: project });
    assert.equal(list.exitCode, 0);
    assert.equal(list.report.status, 'ready');
    assert.equal(list.report.count, 3);
    assert.equal(list.report.invalidCount, 2);

    const byId = new Map(list.report.tasks.map((item) => [item.taskId, item]));
    const good = byId.get('good');
    assert.equal(good.status, 'ready');
    assert.equal(good.unitCount, 2);
    assert.equal(good.doneUnits, 1);
    assert.deepEqual(good.pendingUnits, ['u2']);
    const broken = byId.get('broken');
    assert.equal(broken.status, 'invalid');
    assert.match(broken.error, /not valid JSON/u);
    const foreign = byId.get('not a task');
    assert.equal(foreign.status, 'invalid');
    assert.equal(foreign.error, 'filename is not a valid task id');

    const status = await runCommand(['task', 'status', 'good', '--json'], { cwd: project });
    assert.equal(status.report.status, 'ready');
    assert.deepEqual(status.report.pendingUnits, ['u2']);
    assert.equal(status.report.units.find((unit) => unit.id === 'u1').status, 'done');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('verify --reuse 命中时重放收据而不执行命令', async () => {
  const project = await tempProject();
  const markerDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-task-reuse-'));
  const marker = path.join(markerDir, 'executed.txt');
  try {
    // The proof of execution is written outside the worktree so the check can
    // run without moving the fingerprint the receipt is about to record.
    await writeFile(path.join(project, 'marker.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n`, 'utf8');
    await writeConfig(project, { test: 'node marker.cjs' });
    await initGitProject(project, '.vibe-harness/\n');

    const first = await runCommand(['verify', '--project', '.', '--json'], { cwd: project });
    assert.equal(first.exitCode, 0);
    assert.equal(first.report.status, 'passed');
    assert.equal(typeof first.report.verification.fingerprint, 'string');
    assert.equal(await readFile(marker, 'utf8'), 'executed');
    await rm(marker, { force: true });

    await recordReceipt(project, 'reuse-task', 'u1', first.report);

    const second = await runCommand(['verify', '--project', '.', '--task', 'reuse-task', '--reuse', '--json'], { cwd: project });
    assert.equal(second.exitCode, 0);
    assert.equal(second.report.status, 'reused');
    assert.equal(second.report.reused.taskId, 'reuse-task');
    assert.equal(second.report.reused.unitId, 'u1');
    assert.equal(second.report.reused.fingerprint, first.report.verification.fingerprint);
    assert.equal(second.report.reused.command, `test=${first.report.checks.test.command}`);
    assert.equal(second.report.reused.id, first.report.verification.id);
    assert.equal(second.report.reused.finishedAt, first.report.verification.finishedAt);
    assert.equal(second.report.reused.beforeHead, first.report.verification.before.head);
    assert.equal(second.report.reused.afterHead, first.report.verification.after.head);
    assert.equal(second.report.checks.test.status, 'reused');
    assert.equal(second.report.checks.lint.status, 'not_configured');
    assert.equal(second.report.checks.test.stdout, undefined);
    // The check did not run again: the deleted proof of execution stayed gone.
    await assert.rejects(readFile(marker, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(markerDir, { recursive: true, force: true });
  }
});

test('verify --reuse 标记未选中的检查并只重放记录的选择', async () => {
  const project = await tempProject();
  try {
    await writeConfig(project, { lint: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"' });
    await initGitProject(project, '.vibe-harness/\n');
    const first = await runCommand(['verify', '--project', '.', '--only', 'test', '--json'], { cwd: project });
    assert.equal(first.report.status, 'passed');
    await recordReceipt(project, 'selection', 'u1', first.report);

    const second = await runCommand(['verify', '--project', '.', '--only', 'test', '--reuse', '--json'], { cwd: project });
    assert.equal(second.report.status, 'reused');
    assert.equal(second.report.checks.test.status, 'reused');
    assert.equal(second.report.checks.lint.status, 'not_selected');
    assert.equal(second.report.checks.lint.command, first.report.checks.lint.command);
    assert.equal(second.report.checks.typecheck.status, 'not_configured');
    assert.equal(second.report.checks.eval.status, 'not_configured');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('工作区指纹漂移时 verify --reuse 回退为正常执行', async () => {
  const project = await tempProject();
  try {
    await writeConfig(project, { test: 'node -e "process.exit(0)"' });
    await initGitProject(project, '.vibe-harness/\n');
    const first = await runCommand(['verify', '--project', '.', '--json'], { cwd: project });
    assert.equal(first.report.status, 'passed');
    await recordReceipt(project, 'drift', 'u1', first.report);

    await writeFile(path.join(project, 'drift.txt'), 'moved\n', 'utf8');
    const second = await runCommand(['verify', '--project', '.', '--task', 'drift', '--reuse', '--json'], { cwd: project });
    assert.equal(second.report.status, 'passed');
    assert.equal(second.report.checks.test.status, 'passed');
    assert.equal(second.report.reused, undefined);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('命令集变化时 verify --reuse 回退为正常执行', async () => {
  const project = await tempProject();
  try {
    // The config is gitignored, so rewriting it keeps the fingerprint while
    // the command set grows a check only the command-set guard can detect.
    await writeConfig(project, { test: 'node -e "process.exit(0)"' });
    await initGitProject(project, '.vibe-harness/\nvibe-harness.config.json\n');
    const first = await runCommand(['verify', '--project', '.', '--json'], { cwd: project });
    assert.equal(first.report.status, 'passed');
    await recordReceipt(project, 'commands', 'u1', first.report);

    await writeConfig(project, { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' });
    const second = await runCommand(['verify', '--project', '.', '--task', 'commands', '--reuse', '--json'], { cwd: project });
    assert.equal(second.report.status, 'passed');
    assert.equal(second.report.checks.lint.status, 'passed');
    assert.equal(second.report.checks.test.status, 'passed');
    assert.equal(second.report.reused, undefined);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('缺少匹配锚点时 verify --reuse 回退且校验 task id', async () => {
  const project = await tempProject();
  try {
    await writeConfig(project, { test: 'node -e "process.exit(0)"' });
    await initGitProject(project, '.vibe-harness/\n');
    const first = await runCommand(['verify', '--project', '.', '--json'], { cwd: project });
    await recordReceipt(project, 'present', 'u1', first.report);

    const miss = await runCommand(['verify', '--project', '.', '--task', 'absent', '--reuse', '--json'], { cwd: project });
    assert.equal(miss.report.status, 'passed');
    assert.equal(miss.report.checks.test.status, 'passed');
    assert.equal(miss.report.reused, undefined);

    const invalid = await runCommand(['verify', '--project', '.', '--task', 'a/b', '--reuse', '--json'], { cwd: project });
    assert.equal(invalid.exitCode, 1);
    assert.equal(invalid.report.status, 'failed');
    assert.equal(invalid.report.code, 'VIBE_HARNESS_INVALID_TASK_ID');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('非 git 工作区中 verify --reuse 正常执行检查', async () => {
  const project = await tempProject();
  try {
    await writeConfig(project, { test: 'node -e "process.exit(0)"' });
    const result = await runCommand(['verify', '--project', '.', '--reuse', '--json'], { cwd: project });
    assert.equal(result.exitCode, 0);
    assert.equal(result.report.status, 'passed');
    assert.equal(result.report.checks.test.status, 'passed');
    assert.equal(result.report.verification.stable, null);
    assert.equal(result.report.reused, undefined);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('指纹可见的锚点会阻止自身收据被重放', async () => {
  const project = await tempProject();
  try {
    await writeConfig(project, { test: 'node -e "process.exit(0)"' });
    // No .gitignore: writing the anchor moves the working-tree fingerprint,
    // so the receipt it carries no longer describes the tree on disk.
    await initGitProject(project);
    const first = await runCommand(['verify', '--project', '.', '--json'], { cwd: project });
    assert.equal(first.report.status, 'passed');
    await recordReceipt(project, 'visible', 'u1', first.report);

    const second = await runCommand(['verify', '--project', '.', '--task', 'visible', '--reuse', '--json'], { cwd: project });
    assert.equal(second.report.status, 'passed');
    assert.equal(second.report.checks.test.status, 'passed');
    assert.equal(second.report.reused, undefined);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('verify --plan 优先于 --reuse', async () => {
  const project = await tempProject();
  try {
    await writeConfig(project, { test: 'node -e "process.exit(0)"' });
    await initGitProject(project, '.vibe-harness/\n');
    const first = await runCommand(['verify', '--project', '.', '--json'], { cwd: project });
    await recordReceipt(project, 'planned', 'u1', first.report);

    const result = await runCommand(['verify', '--project', '.', '--task', 'planned', '--reuse', '--plan', '--json'], { cwd: project });
    assert.equal(result.exitCode, 0);
    assert.equal(result.report.status, 'planned');
    assert.equal(result.report.checks.test.status, 'planned');
    assert.equal(result.report.reused, undefined);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('help 说明锚点目录与重放状态', async () => {
  const result = await runCommand(['help', '--json'], { cwd: rootDir });
  assert.equal(result.exitCode, 0);
  assert.match(result.report.task, /\.vibe-harness\/tasks\/<task-id>\.json/u);
  assert.match(result.report.task, /task <init\|update\|status\|list>/u);
  assert.match(result.report.reuse, /status "reused"/u);
});
