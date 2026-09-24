import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
    assert.equal(anchor.schemaVersion, 2);
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
    const fullStatus = await runCommand(['task', 'status', 'gamma', '--json'], { cwd: project });
    assert.equal(fullStatus.report.verificationAdvisory, 'riskLevel full: claim unit completion on a standard-tier verify receipt');
    assert.match(fullStatus.report.resumeHint, /verification advisory: riskLevel full/u);
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
    assert.equal(status.report.verificationAdvisory, 'riskLevel light: a quick-tier focused receipt supports the unit completion claim');
    assert.match(status.report.resumeHint, /verification advisory: riskLevel light/u);
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
  assert.match(result.report.task, /task <init\|update\|status\|list\|plan-check\|plan-sync\|check\|freeze-tests\|rebaseline-tests>/u);
  assert.match(result.report.reuse, /status "reused"/u);
});

test('受管计划绑定、漂移检查与 plan-sync 阻断更新', async () => {
  const project = await tempProject();
  try {
    await mkdir(path.join(project, 'docs', 'plans'), { recursive: true });
    const planPath = path.join(project, 'docs', 'plans', 'handoff.md');
    const plan = [
      '# Handoff',
      '',
      '## Goal',
      'Ship a handoff-ready task.',
      '',
      '## Non-goals',
      'Do not change the public API.',
      '',
      '## Plan of Work',
      'Implement the runtime contract.',
      '',
      '## Validation and Acceptance',
      'Run the focused integration test.',
    ].join('\n');
    await writeFile(planPath, `${plan}\n`, 'utf8');
    const init = await runCommand([
      'task', 'init', 'handoff', '--title', 'Handoff', '--goal', 'Ship it',
      '--plan-file', 'docs/plans/handoff.md', '--write', '--json',
    ], { cwd: project });
    assert.equal(init.report.status, 'passed');
    assert.equal(init.report.anchor.planFile, 'docs/plans/handoff.md');
    assert.equal(init.report.anchor.planRevision.length, 12);

    await writeFile(planPath, `${plan}\n\n## Decision Log\nChanged the implementation order.\n`, 'utf8');
    const drift = await runCommand(['task', 'plan-check', 'handoff', '--json'], { cwd: project });
    assert.equal(drift.report.status, 'failed');
    assert.equal(drift.report.code, 'VIBE_HARNESS_PLAN_DRIFT');
    const blocked = await runCommand(['task', 'update', 'handoff', '--stage', 'implement', '--write', '--json'], { cwd: project });
    assert.equal(blocked.report.status, 'failed');
    assert.equal(blocked.report.code, 'VIBE_HARNESS_PLAN_DRIFT');
    await writeConfig(project, { test: 'node -e "process.exit(0)"' });
    const verifyBlocked = await runCommand(['verify', '--task', 'handoff', '--json'], { cwd: project });
    assert.equal(verifyBlocked.report.status, 'blocked');
    assert.equal(verifyBlocked.report.code, 'VIBE_HARNESS_PLAN_DRIFT');

    const sync = await runCommand(['task', 'plan-sync', 'handoff', '--reason', 'implementation order changed', '--write', '--json'], { cwd: project });
    assert.equal(sync.report.status, 'passed');
    const checked = await runCommand(['task', 'plan-check', 'handoff', '--json'], { cwd: project });
    assert.equal(checked.report.status, 'passed');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('受管计划拒绝项目外路径和缺少必需章节的文件', async () => {
  const project = await tempProject();
  try {
    await mkdir(path.join(project, 'docs', 'plans'), { recursive: true });
    await writeFile(path.join(project, 'docs', 'plans', 'invalid.md'), '# Invalid\n', 'utf8');
    const invalid = await runCommand([
      'task', 'init', 'invalid', '--title', 'Invalid', '--goal', 'Reject it',
      '--plan-file', 'docs/plans/invalid.md', '--write', '--json',
    ], { cwd: project });
    assert.equal(invalid.report.status, 'failed');
    assert.equal(invalid.report.code, 'VIBE_HARNESS_PLAN_INVALID');

    const outside = await runCommand([
      'task', 'init', 'outside', '--title', 'Outside', '--goal', 'Reject it',
      '--plan-file', '../outside.md', '--write', '--json',
    ], { cwd: project });
    assert.equal(outside.report.status, 'failed');
    assert.equal(outside.report.code, 'VIBE_HARNESS_PLAN_OUTSIDE_PROJECT');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

// Builds a handoff plan whose acceptance table holds A-001 and A-002, so a
// fresh reader can see the machine-readable execution block next to the prose
// the block is bound to.
function planWithUnits(units, extra = {}, acceptance = ['A-001', 'A-002']) {
  return [
    '# Handoff',
    '',
    '## 目标',
    '交付可交接的计划。',
    '',
    '## 非目标',
    '不改公共 API。',
    '',
    '## 实施顺序',
    '按执行块中的单元推进。',
    '',
    '## 验收方式',
    '',
    '| 验收 ID | 判据 | 命令或操作 | 预期结果 | 证据 |',
    '|---|---|---|---|---|',
    ...acceptance.map((id) => `| ${id} | 判据 ${id} | node --test | 通过 | 测试输出 |`),
    '',
    '## 实施单元',
    '',
    '```plan-units',
    JSON.stringify({ allowedScope: ['runtime/**'], protectedAssets: ['evals/**'], units, ...extra }, null, 2),
    '```',
  ].join('\n');
}

async function bindPlan(project, taskId, planText) {
  await mkdir(path.join(project, 'docs', 'plans'), { recursive: true });
  const planPath = path.join(project, 'docs', 'plans', `${taskId}.md`);
  await writeFile(planPath, `${planText}\n`, 'utf8');
  const init = await runCommand([
    'task', 'init', taskId, '--title', taskId, '--goal', 'Ship it',
    '--plan-file', `docs/plans/${taskId}.md`, '--write', '--json',
  ], { cwd: project });
  assert.equal(init.report.status, 'passed');
  return planPath;
}

test('plan-check 通过自洽的执行块并报出单元与验收绑定', async () => {
  const project = await tempProject();
  try {
    await bindPlan(project, 'units', planWithUnits([
      { id: 'U1', title: '边界', files: ['runtime/commands/run.mjs'], dependsOn: [], acceptance: ['A-001'] },
      { id: 'U2', title: '文档', files: ['runtime/hooks/README.md'], dependsOn: ['U1'], acceptance: ['A-002'] },
    ]));
    const checked = await runCommand(['task', 'plan-check', 'units', '--json'], { cwd: project });
    assert.equal(checked.report.status, 'passed');
    assert.equal(checked.report.units.present, true);
    assert.equal(checked.report.units.count, 2);
    assert.deepEqual(checked.report.units.ids, ['U1', 'U2']);
    assert.deepEqual(checked.report.units.warnings, []);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('plan-check 拒绝执行块越界与受保护资产写入', async () => {
  const project = await tempProject();
  try {
    await bindPlan(project, 'scope', planWithUnits([
      { id: 'U1', title: '越界', files: ['docs/plans/other.md'], dependsOn: [], acceptance: ['A-001'] },
      { id: 'U2', title: '受保护', files: ['evals/results/x.json'], dependsOn: [], acceptance: ['A-001'] },
    ]));
    const checked = await runCommand(['task', 'plan-check', 'scope', '--json'], { cwd: project });
    assert.equal(checked.report.status, 'failed');
    assert.equal(checked.report.code, 'VIBE_HARNESS_PLAN_UNITS_INVALID');
    const codes = checked.report.problems.map((item) => item.code);
    assert.ok(codes.includes('VIBE_HARNESS_PLAN_SCOPE_VIOLATION'), codes.join(','));
    assert.ok(codes.includes('VIBE_HARNESS_PLAN_PROTECTED_ASSET'), codes.join(','));
    // The dispatch gate reads the same verdict: a drifting scope blocks update.
    const blocked = await runCommand(['task', 'update', 'scope', '--stage', 'implement', '--write', '--json'], { cwd: project });
    assert.equal(blocked.report.status, 'failed');
    assert.equal(blocked.report.code, 'VIBE_HARNESS_PLAN_UNITS_INVALID');

    // Touching a protected asset is only legal when the same unit repeats that
    // exact asset, so the exception is visible in the plan's own text.
    await bindPlan(project, 'granted', planWithUnits([
      {
        id: 'U1',
        title: '受批准写入受保护资产',
        files: ['evals/results/x.json', 'runtime/a.mjs'],
        protectedAssets: ['evals/**'],
        dependsOn: [],
        acceptance: ['A-001'],
      },
    ], { allowedScope: ['runtime/**', 'evals/**'] }));
    const granted = await runCommand(['task', 'plan-check', 'granted', '--json'], { cwd: project });
    assert.equal(granted.report.status, 'passed');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('plan-check 拒绝非法依赖与依赖成环', async () => {
  const project = await tempProject();
  try {
    await bindPlan(project, 'deps', planWithUnits([
      { id: 'U1', title: '未知前驱', files: ['runtime/a.mjs'], dependsOn: ['U9'], acceptance: ['A-001'] },
      { id: 'U2', title: '自依赖', files: ['runtime/b.mjs'], dependsOn: ['U2'], acceptance: ['A-001'] },
      { id: 'U3', title: '成环', files: ['runtime/c.mjs'], dependsOn: ['U4'], acceptance: ['A-001'] },
      { id: 'U4', title: '成环', files: ['runtime/d.mjs'], dependsOn: ['U3'], acceptance: ['A-001'] },
    ]));
    const checked = await runCommand(['task', 'plan-check', 'deps', '--json'], { cwd: project });
    assert.equal(checked.report.status, 'failed');
    const codes = checked.report.problems.map((item) => item.code);
    assert.deepEqual([...new Set(codes)], ['VIBE_HARNESS_PLAN_DEPENDENCY_INVALID']);
    assert.ok(checked.report.problems.some((item) => /unknown unit U9/u.test(item.message)));
    assert.ok(checked.report.problems.some((item) => /depends on itself/u.test(item.message)));
    assert.ok(checked.report.problems.some((item) => /cycle/u.test(item.message)));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('plan-check 拒绝未绑定的验收 ID 并把未认领验收记为警告', async () => {
  const project = await tempProject();
  try {
    await bindPlan(project, 'accept', planWithUnits([
      { id: 'U1', title: '引用不存在验收', files: ['runtime/a.mjs'], dependsOn: [], acceptance: ['A-099'] },
      { id: 'U2', title: '无验收', files: ['runtime/b.mjs'], dependsOn: [], acceptance: [] },
    ]));
    const checked = await runCommand(['task', 'plan-check', 'accept', '--json'], { cwd: project });
    assert.equal(checked.report.status, 'failed');
    const codes = checked.report.problems.map((item) => item.code);
    assert.deepEqual([...new Set(codes)], ['VIBE_HARNESS_PLAN_ACCEPTANCE_UNBOUND']);
    assert.ok(checked.report.problems.some((item) => /A-099/u.test(item.message)));
    assert.ok(checked.report.problems.some((item) => /claims no acceptance id/u.test(item.message)));

    await bindPlan(project, 'unclaimed', planWithUnits([
      { id: 'U1', title: '只认领一条', files: ['runtime/a.mjs'], dependsOn: [], acceptance: ['A-001'] },
    ]));
    const warned = await runCommand(['task', 'plan-check', 'unclaimed', '--json'], { cwd: project });
    assert.equal(warned.report.status, 'passed');
    assert.deepEqual(warned.report.units.warnings.map((item) => item.code), ['VIBE_HARNESS_PLAN_ACCEPTANCE_UNCLAIMED']);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('缺少执行块的旧计划只产生警告并保持可绑定', async () => {
  const project = await tempProject();
  try {
    await bindPlan(project, 'legacy', planWithUnits([], {}, ['A-001']).replace(/\n## 实施单元[\s\S]*$/u, ''));
    const checked = await runCommand(['task', 'plan-check', 'legacy', '--json'], { cwd: project });
    assert.equal(checked.report.status, 'passed');
    assert.equal(checked.report.units.present, false);
    // Without a block there is no unit list to claim acceptance with, so the
    // only honest signal is "the machine-readable contract is missing".
    assert.deepEqual(checked.report.units.warnings.map((item) => item.code), ['VIBE_HARNESS_PLAN_UNITS_MISSING']);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('task check 拒绝执行块未声明的单元', async () => {
  const project = await tempProject();
  try {
    await bindPlan(project, 'declared', planWithUnits([
      { id: 'U1', title: '声明过的单元', files: ['runtime/a.mjs'], dependsOn: [], acceptance: ['A-001'] },
    ]));
    for (const unit of ['U1', 'U2']) {
      const recorded = await runCommand(['task', 'update', 'declared', '--unit-status', `${unit}:in_progress`, '--write', '--json'], { cwd: project });
      assert.equal(recorded.report.status, 'passed', unit);
    }
    const undeclared = await runCommand(['task', 'check', 'declared', '--unit', 'U2', '--json'], { cwd: project });
    assert.equal(undeclared.report.status, 'failed');
    assert.equal(undeclared.report.code, 'VIBE_HARNESS_PLAN_UNIT_UNDECLARED');
    const declared = await runCommand(['task', 'check', 'declared', '--unit', 'U1', '--json'], { cwd: project });
    assert.equal(declared.report.status, 'failed');
    assert.equal(declared.report.code, 'VIBE_HARNESS_TASK_NOT_READY');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('freeze-tests 只接受真实红灯，rebaseline-tests 需要受保护批准', async () => {
  const project = await tempProject();
  try {
    await runCommand(['task', 'init', 'bug', '--title', 'Bug', '--goal', 'Fix bug', '--write', '--json'], { cwd: project });
    const green = receiptFixture({ status: 'passed' });
    const rejected = await runCommand([
      'task', 'freeze-tests', 'bug', '--unit', 'u1', '--test-path', 'tests/unit/bug.test.js',
      '--verification', JSON.stringify(green), '--write', '--json',
    ], { cwd: project });
    assert.equal(rejected.report.status, 'failed');
    assert.equal(rejected.report.code, 'VIBE_HARNESS_RED_EVIDENCE_REQUIRED');

    const red = receiptFixture({ status: 'failed' });
    red.checks.test.status = 'failed';
    const frozen = await runCommand([
      'task', 'freeze-tests', 'bug', '--unit', 'u1', '--test-path', 'tests/unit/bug.test.js',
      '--verification', JSON.stringify(red), '--write', '--json',
    ], { cwd: project });
    assert.equal(frozen.report.status, 'passed');
    const anchor = await readAnchor(project, 'bug');
    assert.deepEqual(anchor.units[0].testFreeze.paths, ['tests/unit/bug.test.js']);
    assert.equal(anchor.units[0].testFreeze.status, 'frozen');

    const noApproval = await runCommand([
      'task', 'rebaseline-tests', 'bug', '--unit', 'u1', '--test-path', 'tests/unit/bug.test.js',
      '--verification', JSON.stringify(red), '--write', '--json',
    ], { cwd: project });
    assert.equal(noApproval.report.status, 'failed');
    assert.equal(noApproval.report.code, 'VIBE_HARNESS_REBASELINE_APPROVAL_INVALID');

    const approval = JSON.stringify({ status: 'approved', source: 'protected-ci', trust: 'verified', reviewer: 'protected-review', protectedCheck: 'required-review' });
    const rebaseline = await runCommand([
      'task', 'rebaseline-tests', 'bug', '--unit', 'u1', '--test-path', 'tests/unit/bug.test.js',
      '--verification', JSON.stringify(red), '--approval', approval, '--write', '--json',
    ], { cwd: project });
    assert.equal(rebaseline.report.status, 'failed');
    assert.equal(rebaseline.report.code, 'VIBE_HARNESS_REBASELINE_APPROVAL_INVALID');

    const previousApproval = process.env.VIBE_HARNESS_PROTECTED_APPROVAL;
    process.env.VIBE_HARNESS_PROTECTED_APPROVAL = '1';
    const verifiedRebaseline = await runCommand([
      'task', 'rebaseline-tests', 'bug', '--unit', 'u1', '--test-path', 'tests/unit/bug.test.js',
      '--verification', JSON.stringify(red), '--approval', approval, '--write', '--json',
    ], { cwd: project });
    if (previousApproval === undefined) delete process.env.VIBE_HARNESS_PROTECTED_APPROVAL;
    else process.env.VIBE_HARNESS_PROTECTED_APPROVAL = previousApproval;
    assert.equal(verifiedRebaseline.report.status, 'passed');
    const updated = await readAnchor(project, 'bug');
    assert.equal(updated.units[0].testFreeze.approval.trust, 'verified');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('task check --complete 在存在 blocker 时保持阻塞', async () => {
  const project = await tempProject();
  try {
    await runCommand(['task', 'init', 'blocked', '--title', 'Blocked', '--goal', 'Do not complete', '--write', '--json'], { cwd: project });
    await runCommand(['task', 'update', 'blocked', '--unit-status', 'u1:done', '--blocker', '等待 protected approval', '--write', '--json'], { cwd: project });
    const check = await runCommand(['task', 'check', 'blocked', '--complete', '--json'], { cwd: project });
    assert.equal(check.report.status, 'failed');
    assert.equal(check.report.code, 'VIBE_HARNESS_TASK_NOT_READY');
    assert.deepEqual(check.report.blockers, ['等待 protected approval']);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('task check --complete 拒绝没有验证收据的 done 单元', async () => {
  const project = await tempProject();
  try {
    await runCommand(['task', 'init', 'missing-receipt', '--title', 'Missing receipt', '--goal', 'Keep evidence mandatory', '--write', '--json'], { cwd: project });
    await runCommand(['task', 'update', 'missing-receipt', '--unit-status', 'u1:done', '--write', '--json'], { cwd: project });
    const check = await runCommand(['task', 'check', 'missing-receipt', '--complete', '--json'], { cwd: project });
    assert.equal(check.report.status, 'failed');
    assert.deepEqual(check.report.unverified, ['u1']);
    assert.match(check.report.error, /unverified units: u1/u);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

// Blockers are appended, never overwritten. Once the external approval they
// wait on arrives, the anchor needs an explicit clear or the task can never
// satisfy `task check --complete` again.
test('task update --clear-blockers 解除已解决的外部阻塞并可判定完成', async () => {
  const project = await tempProject();
  try {
    await runCommand(['task', 'init', 'approved', '--title', 'Approved', '--goal', 'Resume after approval', '--write', '--json'], { cwd: project });
    const blocked = await runCommand(['task', 'update', 'approved', '--unit-status', 'u1:done', '--blocker', '等待 protected approval', '--write', '--json'], { cwd: project });
    assert.ok(blocked.report.changes.includes('blocker'));
    await recordReceipt(project, 'approved', 'u1', receiptFixture());

    const stillBlocked = await runCommand(['task', 'check', 'approved', '--complete', '--json'], { cwd: project });
    assert.equal(stillBlocked.report.status, 'failed');
    assert.deepEqual(stillBlocked.report.blockers, ['等待 protected approval']);

    const cleared = await runCommand(['task', 'update', 'approved', '--clear-blockers', '--write', '--json'], { cwd: project });
    assert.equal(cleared.report.status, 'passed');
    assert.ok(cleared.report.changes.includes('clear-blockers'));
    assert.deepEqual((await readAnchor(project, 'approved')).blockers, []);

    const complete = await runCommand(['task', 'check', 'approved', '--complete', '--json'], { cwd: project });
    assert.equal(complete.report.status, 'passed', JSON.stringify(complete.report));

    const repeated = await runCommand(['task', 'update', 'approved', '--clear-blockers', '--write', '--json'], { cwd: project });
    assert.equal(repeated.report.changed, false);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('失败单元阻塞依赖单元的派发前校验', async () => {
  const project = await tempProject();
  try {
    await bindPlan(project, 'chain', planWithUnits([
      { id: 'A', title: '先做', files: ['runtime/commands/run.mjs'], dependsOn: [], acceptance: ['A-001'] },
      { id: 'B', title: '依赖 A', files: ['runtime/hooks/README.md'], dependsOn: ['A'], acceptance: ['A-002'] },
    ]));
    await runCommand(['task', 'update', 'chain', '--unit-status', 'A:pending', '--unit-status', 'B:pending', '--write', '--json'], { cwd: project });

    // Nothing has failed yet: B stays dispatchable, and the unfinished
    // predecessor is reported instead of silently disappearing.
    const open = await runCommand(['task', 'check', 'chain', '--unit', 'B', '--dispatch', '--json'], { cwd: project });
    assert.equal(open.report.status, 'failed');
    assert.equal(open.report.code, 'VIBE_HARNESS_UNIT_PREDECESSOR_UNMET');
    assert.deepEqual(open.report.predecessors.unfinished, [{ id: 'A', status: 'pending' }]);

    await runCommand(['task', 'update', 'chain', '--unit-status', 'A:done', '--write', '--json'], { cwd: project });
    const dispatchable = await runCommand(['task', 'check', 'chain', '--unit', 'B', '--dispatch', '--json'], { cwd: project });
    assert.equal(dispatchable.report.status, 'passed');
    assert.equal(dispatchable.report.code, undefined);

    await runCommand(['task', 'update', 'chain', '--unit-status', 'A:failed', '--failure', 'A 的聚焦验证失败', '--write', '--json'], { cwd: project });
    const blocked = await runCommand(['task', 'check', 'chain', '--unit', 'B', '--dispatch', '--json'], { cwd: project });
    assert.equal(blocked.exitCode, 1);
    assert.equal(blocked.report.status, 'failed');
    assert.equal(blocked.report.code, 'VIBE_HARNESS_UNIT_PREDECESSOR_FAILED');
    assert.deepEqual(blocked.report.predecessors.failed, [{ id: 'A', status: 'failed' }]);
    assert.match(blocked.report.error, /A=failed/u);

    const complete = await runCommand(['task', 'check', 'chain', '--complete', '--json'], { cwd: project });
    assert.equal(complete.report.status, 'failed');
    assert.deepEqual(complete.report.failedUnits, ['A']);

    // Repairing the predecessor unblocks the dependent without touching the plan.
    await runCommand(['task', 'update', 'chain', '--unit-status', 'A:done', '--write', '--json'], { cwd: project });
    const reopened = await runCommand(['task', 'check', 'chain', '--unit', 'B', '--dispatch', '--json'], { cwd: project });
    assert.equal(reopened.report.status, 'passed');

    // A blocked predecessor stops the dispatch the same way a failed one does.
    await runCommand(['task', 'update', 'chain', '--unit-status', 'A:blocked', '--write', '--json'], { cwd: project });
    const blockedAgain = await runCommand(['task', 'check', 'chain', '--unit', 'B', '--dispatch', '--json'], { cwd: project });
    assert.equal(blockedAgain.report.code, 'VIBE_HARNESS_UNIT_PREDECESSOR_FAILED');
    assert.deepEqual(blockedAgain.report.predecessors.blocked, [{ id: 'A', status: 'blocked' }]);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('freeze-tests 校验红灯真实性与覆盖范围', async () => {
  const project = await tempProject();
  try {
    await runCommand(['task', 'init', 'red', '--title', 'Red', '--goal', 'Freeze a real red', '--write', '--json'], { cwd: project });
    const freeze = (receipt, testPath = 'tests/unit/bug.test.js') => runCommand([
      'task', 'freeze-tests', 'red', '--unit', 'u1', '--test-path', testPath,
      '--verification', JSON.stringify(receipt), '--write', '--json',
    ], { cwd: project });
    const red = () => {
      const receipt = receiptFixture({ status: 'failed' });
      receipt.checks.test.status = 'failed';
      receipt.checks.test.exitCode = 1;
      return receipt;
    };

    const lintOnly = red();
    lintOnly.checks.test = { status: 'passed', command: 'test=node -e "process.exit(0)"', exitCode: 0 };
    lintOnly.checks.lint = { status: 'failed', command: 'lint=pnpm lint', exitCode: 1 };
    assert.equal((await freeze(lintOnly)).report.code, 'VIBE_HARNESS_RED_CHECK_NOT_TEST');

    const timeout = red();
    timeout.checks.test.code = 'TIMEOUT';
    assert.equal((await freeze(timeout)).report.code, 'VIBE_HARNESS_RED_EVIDENCE_INVALID');

    const syntax = red();
    syntax.checks.test.stderr = 'SyntaxError: Unexpected token }';
    assert.equal((await freeze(syntax)).report.code, 'VIBE_HARNESS_RED_EVIDENCE_SYNTAX');

    const empty = red();
    empty.checks.test.stdout = '# tests 0\n';
    assert.equal((await freeze(empty)).report.code, 'VIBE_HARNESS_RED_EVIDENCE_EMPTY');

    const dependency = red();
    dependency.checks.test.stderr = "Error: Cannot find module 'left-pad'";
    assert.equal((await freeze(dependency)).report.code, 'VIBE_HARNESS_RED_EVIDENCE_DEPENDENCY');

    const unstable = red();
    unstable.verification.stable = false;
    assert.equal((await freeze(unstable)).report.code, 'VIBE_HARNESS_RED_EVIDENCE_UNSTABLE');

    // A focused command that named a different file never ran the frozen asset.
    const otherPath = red();
    otherPath.checks.test.command = 'test=node --test tests/unit/other.test.js';
    assert.equal((await freeze(otherPath)).report.code, 'VIBE_HARNESS_RED_PATH_UNCOVERED');

    const focused = red();
    focused.checks.test.command = 'test=node --test tests/unit/bug.test.js';
    const frozen = await freeze(focused);
    assert.equal(frozen.report.status, 'passed');
    assert.deepEqual(frozen.report.freeze.redEvidence.checks, [{ name: 'test', command: 'test=node --test tests/unit/bug.test.js', exitCode: 1 }]);
    const anchor = await readAnchor(project, 'red');
    assert.deepEqual(anchor.units[0].testFreeze.paths, ['tests/unit/bug.test.js']);
    assert.equal(anchor.units[0].testFreeze.redEvidence.status, 'failed');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('验证收据携带任务与计划关联并拒绝跨任务收据', async () => {
  const project = await tempProject();
  try {
    await writeConfig(project, { test: 'node -e "process.exit(0)"' });
    await bindPlan(project, 'bound', planWithUnits([
      { id: 'u1', title: '单元', files: ['runtime/commands/run.mjs'], dependsOn: [], acceptance: ['A-001'] },
    ]));
    const verified = await runCommand(['verify', '--project', '.', '--task', 'bound', '--json'], { cwd: project });
    assert.equal(verified.report.status, 'passed');
    const anchor = await readAnchor(project, 'bound');
    assert.deepEqual(verified.report.verification.task, {
      id: 'bound',
      stage: 'plan',
      planFile: 'docs/plans/bound.md',
      planRevision: anchor.planRevision,
      planDigest: anchor.planDigest,
    });

    const recorded = await runCommand(['task', 'update', 'bound', '--unit', 'u1', '--verification', JSON.stringify(verified.report), '--write', '--json'], { cwd: project });
    assert.equal(recorded.report.status, 'passed');
    const withReceipt = await readAnchor(project, 'bound');
    assert.equal(withReceipt.units[0].verification.taskId, 'bound');
    assert.equal(withReceipt.units[0].verification.planDigest, anchor.planDigest);

    const foreign = structuredClone(verified.report);
    foreign.verification.task.id = 'elsewhere';
    const rejected = await runCommand(['task', 'update', 'bound', '--unit', 'u1', '--verification', JSON.stringify(foreign), '--write', '--json'], { cwd: project });
    assert.equal(rejected.report.status, 'failed');
    assert.equal(rejected.report.code, 'VIBE_HARNESS_VERIFICATION_TASK_MISMATCH');

    // The same association constrains a freeze: red evidence from another task
    // cannot freeze this task's acceptance assets.
    await runCommand(['task', 'init', 'red-owner', '--title', 'Red', '--goal', 'Freeze', '--write', '--json'], { cwd: project });
    const redForeign = receiptFixture({ status: 'failed' });
    redForeign.checks.test.status = 'failed';
    redForeign.verification.task = { id: 'elsewhere' };
    const deniedFreeze = await runCommand([
      'task', 'freeze-tests', 'red-owner', '--unit', 'u1', '--test-path', 'tests/unit/bug.test.js',
      '--verification', JSON.stringify(redForeign), '--write', '--json',
    ], { cwd: project });
    assert.equal(deniedFreeze.report.status, 'failed');
    assert.equal(deniedFreeze.report.code, 'VIBE_HARNESS_RED_EVIDENCE_TASK_MISMATCH');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
