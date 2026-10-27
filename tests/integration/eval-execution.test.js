import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readJson, validateJsonAgainstSchema } from '../../scripts/lib/manifest.js';
import {
  validateEvalObserverCoverage,
  validateEvalSuiteSemantics,
} from '../../scripts/lib/eval-contract.js';
import { runHiddenTests } from '../../runtime/evals/lib/hidden-tests.mjs';

const rootDir = path.resolve(import.meta.dirname, '../..');
const suitePath = path.join(rootDir, 'evals/suites/vibe-harness-online-execution.json');

const splitPushModes = ['existing', 'diverged', 'fast-forward', 'conflict', 'excluded', 'protected', 'ambiguous', 'hook'];
const splitPushSuitePath = path.join(rootDir, 'evals/suites/vibe-harness-online-canary.json');

async function parentBatchEvalFixture() {
  const suite = await readJson(path.join(rootDir, 'evals/suites/linear-workflow-online.json'));
  const definition = suite.cases.find((item) => item.id === 'EVAL-LINEAR-BATCH-001');
  const workspace = await mkdtemp(path.join(tmpdir(), 'vibe-parent-batch-eval-'));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const node = (cwd, ...args) => execFileSync(process.execPath, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    for (const file of definition.input.fixture.files) {
      const destination = path.join(workspace, file.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, file.content.replace('{{SKILL:vb-linear-worktree-develop}}',
        await readFile(path.join(rootDir, 'skills/integrations/vb-linear-worktree-develop/SKILL.md'), 'utf8')));
    }
    git(workspace, 'init', '-q');
    node(workspace, 'prepare.cjs');
    const state = JSON.parse(await readFile(path.join(workspace, '.git/batch-state.json')));
    return { workspace, definition, state, git, node };
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

test('Parent 批次执行评测使用真实提交图、远端 SHA 和状态写入顺序的正负控', async () => {
  const f = await parentBatchEvalFixture();
  try {
    const schema = await readJson(path.join(rootDir, 'schemas/eval-suite.schema.json'));
    const suite = await readJson(path.join(rootDir, 'evals/suites/linear-workflow-online.json'));
    assert.deepEqual(validateJsonAgainstSchema(suite, schema, 'Parent suite'), []);
    assert.deepEqual(validateEvalSuiteSemantics(suite), []);
    const inspect = () => runHiddenTests({ workspace: f.workspace, case: f.definition }, {});
    assert.equal((await inspect()).summary.failed, 1, '未执行结果不能通过');
    for (const id of ['A', 'B']) {
      await writeFile(path.join(f.state.source, `src/${id}.cjs`), 'module.exports = 1;\n');
      f.git(f.state.source, 'add', `src/${id}.cjs`);
      f.node(f.state.source, 'check.cjs', id);
      f.git(f.state.source, 'commit', '-qm', `feat(ENG-${id}): implement ${id}`);
    }
    f.git(f.state.repo, 'merge', '--no-ff', '--no-edit', 'feat/ENG-P-batch');
    f.node(f.state.repo, 'check.cjs');
    const head = f.git(f.state.repo, 'rev-parse', 'HEAD');
    f.git(f.state.repo, 'push', '--no-force', f.state.remote, `${head}:refs/heads/develop`);
    f.node(f.workspace, 'linear.cjs', 'ENG-A');
    assert.throws(() => f.node(f.workspace, '-e',
      "process.argv[2]='ENG-B';require('./linear.cjs');throw Error('response lost after write')"));
    assert.equal(JSON.parse(await readFile(path.join(f.workspace, 'linear-state.json')))['ENG-B'], 'Done');
    const confirmedStates = JSON.parse(await readFile(path.join(f.workspace, 'linear-state.json')));
    for (const id of ['ENG-A', 'ENG-B']) {
      if (confirmedStates[id] !== 'Done') f.node(f.workspace, 'linear.cjs', id);
    }
    f.node(f.workspace, 'linear.cjs', 'ENG-P');
    assert.equal((await inspect()).summary.failed, 0, '已知正确样本不得被误判');
    const events = await readFile(f.state.events, 'utf8');
    const parsed = events.trim().split('\n').map(JSON.parse);
    await writeFile(f.state.events, [...parsed.slice(1, 2), parsed[0], ...parsed.slice(2)].map(JSON.stringify).join('\n') + '\n');
    assert.equal((await inspect()).summary.failed, 1, '远端确认前的 Done 必须拒绝');
    await writeFile(f.state.events, events);
    const checks = await readFile(f.state.checks, 'utf8');
    await writeFile(f.state.checks, '');
    assert.equal((await inspect()).summary.failed, 1, '没有匹配提交树的检查证据必须拒绝');
    await writeFile(f.state.checks, checks);
    await writeFile(f.state.checks, checks.trim().split('\n').map((line) => ({ ...JSON.parse(line), worktrees: 3 })).map(JSON.stringify).join('\n') + '\n');
    assert.equal((await inspect()).summary.failed, 1, '逐 Issue 多建任务树必须拒绝');
    await writeFile(f.state.checks, checks);
    f.git(f.state.remote, 'update-ref', 'refs/heads/develop', f.state.base);
    assert.equal((await inspect()).summary.failed, 1, '本地完成不能冒充远端交付');
    f.git(f.state.remote, 'update-ref', 'refs/heads/develop', head);
    assert.equal((await inspect()).summary.failed, 0);
  } finally {
    await rm(f.workspace, { recursive: true, force: true });
  }
});

test('Parent 批次执行判据拒绝把两个 Issue 混入一次提交', async () => {
  const f = await parentBatchEvalFixture();
  try {
    for (const id of ['A', 'B']) await writeFile(path.join(f.state.source, `src/${id}.cjs`), 'module.exports = 1;\n');
    f.git(f.state.source, 'add', 'src');
    f.node(f.state.source, 'check.cjs');
    f.git(f.state.source, 'commit', '-qm', 'feat(ENG-A): deliver ENG-A and ENG-B together');
    f.git(f.state.repo, 'merge', '--no-ff', '--no-edit', 'feat/ENG-P-batch');
    f.node(f.state.repo, 'check.cjs');
    const head = f.git(f.state.repo, 'rev-parse', 'HEAD');
    f.git(f.state.repo, 'push', '--no-force', f.state.remote, `${head}:refs/heads/develop`);
    for (const id of ['ENG-A', 'ENG-B', 'ENG-P']) f.node(f.workspace, 'linear.cjs', id);
    const result = await runHiddenTests({ workspace: f.workspace, case: f.definition }, {});
    assert.equal(result.summary.failed, 1, '最终内容和 Done 都正确也不能掩盖错误的提交归属');
  } finally {
    await rm(f.workspace, { recursive: true, force: true });
  }
});

async function splitPushFixture(mode) {
  const suite = await readJson(splitPushSuitePath);
  const definition = suite.cases.find((item) => item.id === `EVAL-GIT-DELIVER-${String(splitPushModes.indexOf(mode) + 5).padStart(3, '0')}`);
  const workspace = await mkdtemp(path.join(tmpdir(), 'vibe-split-push-'));
  const git = (...args) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const node = (...args) => execFileSync(process.execPath, args, { cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    for (const file of definition.input.fixture.files) {
      let content = file.content;
      content = content.replace('{{RULE:git-rules}}', await readFile(path.join(rootDir, 'docs/rules/git-rules.md'), 'utf8'));
      content = content.replace('{{SKILL:vb-git-split-push}}', await readFile(path.join(rootDir, 'skills/core/vb-git-split-push/SKILL.md'), 'utf8'));
      await mkdir(path.dirname(path.join(workspace, file.path)), { recursive: true });
      await writeFile(path.join(workspace, file.path), content);
    }
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'core.autocrlf', 'false');
    git('add', '--all');
    git('commit', '-qm', 'chore(fixture): initial state');
    node('prepare.cjs');
    const state = JSON.parse(await readFile(path.join(workspace, '.git/split-state.json'), 'utf8'));
    return { definition, git, node, state, workspace };
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

// Known-good controls validate the hidden oracle, not the model's Skill compliance.
// The online runner uses the same cases with the actual Agent as the actor.
function exerciseSplitPushControl({ git, node, state }, mode) {
  if (mode === 'hook') {
    node('check.cjs');
    assert.throws(() => git('commit', '-m', 'feat(math): add multiply'));
    return;
  }
  if (mode !== 'fast-forward') {
    node('check.cjs');
    git('commit', '-qm', 'feat(math): add multiply', '--only', '--', 'app.cjs');
    git('add', 'guide.md', 'notes.md');
    node('check.cjs');
    git('commit', '-qm', 'docs(usage): explain arithmetic', '--only', '--', 'guide.md', 'notes.md');
  }
  if (['excluded', 'protected', 'ambiguous'].includes(mode)) return;
  if (mode !== 'existing') {
    git('fetch', '-q', state.remote, 'refs/heads/develop');
    const sha = git('rev-parse', 'FETCH_HEAD');
    if (mode === 'conflict') {
      assert.throws(() => git('merge', '--no-edit', sha));
      return;
    }
    if (mode === 'fast-forward') git('merge', '--ff-only', sha);
    else git('merge', '--no-edit', '-m', 'chore(sync): merge remote develop', sha);
    node('check.cjs');
  }
  git('push', '--no-force', state.remote, `${git('rev-parse', 'HEAD')}:refs/heads/develop`);
}

test('分组交付执行场景使用合法合同、真实 Git 判据和隐藏检查', async () => {
  const [suite, schema, observers] = await Promise.all([
    readJson(splitPushSuitePath),
    readJson(path.join(rootDir, 'schemas/eval-suite.schema.json')),
    readJson(path.join(rootDir, 'runtime/evals/observers.json')),
  ]);
  assert.deepEqual(validateJsonAgainstSchema(suite, schema, 'split-push suite'), []);
  assert.deepEqual(validateEvalSuiteSemantics(suite), []);
  assert.deepEqual(validateEvalObserverCoverage([suite], observers), []);
  for (const mode of splitPushModes) {
    const id = `EVAL-GIT-DELIVER-${String(splitPushModes.indexOf(mode) + 5).padStart(3, '0')}`;
    const definition = suite.cases.find((item) => item.id === id);
    assert.equal(definition.input.fixture.git.init, true);
    assert.ok(definition.input.fixture.tests.length > 0);
    assert.deepEqual(definition.oracle.requiredOutputFragments, []);
    assert.match(definition.input.fixture.tests[0].command[2], /rev-parse/u);
    assert.equal(definition.repetitions, 3);
  }
});

for (const mode of splitPushModes) {
  test(`分组交付 ${mode} 的隐藏判据拒绝未执行结果并接受已知正确 Git 状态`, async () => {
    const fixture = await splitPushFixture(mode);
    try {
      const request = { workspace: fixture.workspace, case: fixture.definition };
      const before = await runHiddenTests(request, {});
      assert.equal(before.summary.failed, 1, '未执行交付不能通过隐藏检查');
      exerciseSplitPushControl(fixture, mode);
      const after = await runHiddenTests(request, {});
      assert.equal(after.summary.failed, 0, `${mode} 已知正确样本不能被误判`);
      assert.equal(after.summary.passed, 1);
      if (mode === 'existing') {
        fixture.git('--git-dir', fixture.state.remote, 'update-ref', 'refs/heads/develop', fixture.state.base);
        const wrongRemote = await runHiddenTests(request, {});
        assert.equal(wrongRemote.summary.failed, 1, '本地完成但远端缺失提交不能冒充推送成功');
      }
      if (mode === 'diverged') {
        const log = path.join(fixture.workspace, '.git/validation-heads');
        const head = fixture.git('rev-parse', 'HEAD');
        const stale = (await readFile(log, 'utf8')).split('\n').filter((sha) => sha !== head).join('\n');
        await writeFile(log, stale);
        const staleEvidence = await runHiddenTests(request, {});
        assert.equal(staleEvidence.summary.failed, 1, '同步前的验证不能证明最终合并快照');
      }
    } finally {
      await rm(fixture.workspace, { recursive: true, force: true });
    }
  });
}

test('分组交付隐藏判据拒绝把独立修改混成一个提交', async () => {
  const fixture = await splitPushFixture('existing');
  try {
    fixture.git('add', 'app.cjs', 'guide.md', 'notes.md');
    fixture.node('check.cjs');
    fixture.git('commit', '-qm', 'feat(mixed): combine unrelated changes');
    fixture.git('push', '--no-force', fixture.state.remote, `${fixture.git('rev-parse', 'HEAD')}:refs/heads/develop`);
    const result = await runHiddenTests({ workspace: fixture.workspace, case: fixture.definition }, {});
    assert.equal(result.summary.failed, 1, '即使推送成功也必须拒绝错误分组');
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test('分组修复判据拒绝缺失依赖和失效快照，原 Hook 通过后提交完整逻辑组', async () => {
  const suite = await readJson(splitPushSuitePath);
  const definition = suite.cases.find((item) => item.id === 'EVAL-GIT-DELIVER-013');
  const workspace = await mkdtemp(path.join(tmpdir(), 'vibe-split-repair-eval-'));
  const git = (...args) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const node = (...args) => execFileSync(process.execPath, args, { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    for (const file of definition.input.fixture.files) {
      const content = file.content
        .replace('{{RULE:git-rules}}', await readFile(path.join(rootDir, 'docs/rules/git-rules.md'), 'utf8'))
        .replace('{{SKILL:vb-git-split-push}}', await readFile(path.join(rootDir, 'skills/core/vb-git-split-push/SKILL.md'), 'utf8'));
      await mkdir(path.dirname(path.join(workspace, file.path)), { recursive: true });
      await writeFile(path.join(workspace, file.path), content);
    }
    git('init', '-q');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'core.autocrlf', 'false');
    git('add', '.');
    git('commit', '-qm', 'chore(fixture): baseline');
    node('prepare.cjs');
    const state = JSON.parse(await readFile(path.join(workspace, '.git/repair-state.json')));
    const inspect = () => runHiddenTests({ workspace, case: definition }, {});
    assert.equal((await inspect()).summary.failed, 1, '未执行不能通过');
    assert.throws(() => git('commit', '-m', 'feat(app): deliver capability'), '原 Hook 拒绝 EOF');
    await writeFile(path.join(workspace, 'app.cjs'), 'module.exports = 2;\n');
    assert.throws(() => git('commit', '-m', 'feat(app): deliver capability'), '未重新暂存仍拒绝');
    git('add', 'app.cjs');
    assert.throws(() => node('verify-index.cjs'), '工作区存在测试不等于暂存快照包含测试');
    assert.throws(() => git('commit', '-m', 'feat(app): deliver capability'), '缺失依赖拒绝提交');
    assert.equal(git('rev-parse', 'HEAD'), state.base);
    git('add', 'new-check.cjs');
    node('verify-index.cjs');
    git('commit', '-qm', 'feat(app): deliver capability');
    assert.equal((await inspect()).summary.failed, 1, '本地提交不能冒充远端交付');
    git('push', '--no-force', state.remote, `${git('rev-parse', 'HEAD')}:refs/heads/develop`);
    assert.equal((await inspect()).summary.failed, 0, '完整快照与原 Hook 通过的样本应通过');
    const checks = await readFile(path.join(workspace, '.git/verified-trees'));
    await writeFile(path.join(workspace, '.git/verified-trees'), state.base + '\n');
    assert.equal((await inspect()).summary.failed, 1, '旧验证不能证明当前提交');
    await writeFile(path.join(workspace, '.git/verified-trees'), checks);
    git('config', 'core.hooksPath', '.git/disabled-hooks');
    assert.equal((await inspect()).summary.failed, 1, '禁用 Hook 不能通过');
    git('config', 'core.hooksPath', '.git/hooks');
    assert.equal((await inspect()).summary.failed, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('execution suite schema accepts the optional fixture.tests block', async () => {
  const [schema, suite] = await Promise.all([
    readJson(path.join(rootDir, 'schemas/eval-suite.schema.json')),
    readJson(suitePath),
  ]);
  assert.deepEqual(validateJsonAgainstSchema(suite, schema, 'execution suite'), []);
  // tests is optional and present on every case.
  assert.equal(suite.cases.filter((item) => item.input.fixture).every((item) => Array.isArray(item.input.fixture.tests) && item.input.fixture.tests.length > 0), true);
  // command is a non-empty argv array, expectedExitCode is a non-negative integer.
  for (const item of suite.cases.filter((item) => item.input.fixture)) {
    assert.equal(item.input.fixture.allowedWritePaths.length, 1);
    for (const entry of item.input.fixture.tests) {
      assert.equal(Array.isArray(entry.command) && entry.command.length > 0, true);
      assert.equal(Number.isInteger(entry.expectedExitCode) && entry.expectedExitCode >= 0, true);
    }
  }
});

test('execution suite rejects unknown fixture keys and bad command types', async () => {
  const schema = await readJson(path.join(rootDir, 'schemas/eval-suite.schema.json'));
  const suite = await readJson(suitePath);
  const invalid = structuredClone(suite);
  // Unknown key inside a test entry is rejected (additionalProperties: false).
  invalid.cases[0].input.fixture.tests[0].unexpected = true;
  assert.notEqual(validateJsonAgainstSchema(invalid, schema, 'bad').length, 0);
  // Non-array command is rejected.
  const nonArray = structuredClone(suite);
  nonArray.cases[0].input.fixture.tests[0].command = 'node test.js';
  assert.notEqual(validateJsonAgainstSchema(nonArray, schema, 'bad').length, 0);
  // Non-integer expectedExitCode is rejected.
  const badCode = structuredClone(suite);
  badCode.cases[0].input.fixture.tests[0].expectedExitCode = 1.5;
  assert.notEqual(validateJsonAgainstSchema(badCode, schema, 'bad').length, 0);
  for (const invalidPath of ['/absolute.js', 'C:/absolute.js', '../escape.js', 'dir\\file.js', 'dir/../file.js']) {
    const invalidWrite = structuredClone(suite);
    invalidWrite.cases[0].input.fixture.allowedWritePaths = [invalidPath];
    assert.notEqual(validateJsonAgainstSchema(invalidWrite, schema, 'bad').length, 0, invalidPath);
  }
});

test('execution suite passes semantic validation (weight-assertion coupling, positive total weight)', async () => {
  const suite = await readJson(suitePath);
  assert.deepEqual(validateEvalSuiteSemantics(suite), []);
});

test('execution suite hidden-test events are registered observers', async () => {
  const [suite, observers] = await Promise.all([
    readJson(suitePath),
    readJson(path.join(rootDir, 'runtime/evals/observers.json')),
  ]);
  assert.deepEqual(validateEvalObserverCoverage([suite], observers), []);
  assert.equal(typeof observers.events['hidden-tests-passed'], 'object');
  assert.equal(typeof observers.events['hidden-tests-failed'], 'object');
  assert.equal(typeof observers.events['undeclared-workspace-write'], 'object');
  for (const event of [
    'compaction-observed',
    'compaction-not-observed',
    'current-file-read',
    'git-head-advanced',
    'verification',
    'task-anchor-written',
    'rule-body-reread-after-compaction',
    'duplicate-verify-unchanged-fingerprint',
  ]) {
    assert.equal(typeof observers.events[event], 'object', event);
  }
  const incomplete = structuredClone(observers);
  delete incomplete.events['hidden-tests-failed'];
  assert.match(validateEvalObserverCoverage([suite], incomplete).join('\n'), /hidden-tests-failed/u);
});

test('execution suite schema rejects malformed host compaction and Git fixture blocks', async () => {
  const [schema, suite] = await Promise.all([
    readJson(path.join(rootDir, 'schemas/eval-suite.schema.json')),
    readJson(suitePath),
  ]);
  const index = suite.cases.findIndex((item) => item.id === 'EVAL-EXEC-COMPACT-001');
  assert.notEqual(index, -1);
  const validate = (mutate) => {
    const copy = structuredClone(suite);
    mutate(copy.cases[index].input);
    return validateJsonAgainstSchema(copy, schema, 'bad');
  };
  assert.deepEqual(validate(() => {}), []);
  assert.notEqual(validate((input) => { delete input.compaction.resumePrompt; }).length, 0);
  assert.notEqual(validate((input) => { input.compaction.contextWindow = 900; }).length, 0);
  assert.notEqual(validate((input) => { input.compaction.autoCompactTokenLimit = 4000.5; }).length, 0);
  assert.notEqual(validate((input) => { input.compaction.unknownKey = true; }).length, 0);
  assert.notEqual(validate((input) => { input.fixture.git = {}; }).length, 0);
  assert.notEqual(validate((input) => { input.fixture.git = { init: true, unknownKey: true }; }).length, 0);
});

test('host compaction case keeps the stale checkpoint out of the fixture and the first prompt', async () => {
  const suite = await readJson(suitePath);
  const item = suite.cases.find((entry) => entry.id === 'EVAL-EXEC-COMPACT-001');
  assert.equal(item.capability, 'execution-recovery');
  assert.equal(item.category, 'task-delivery-governance');
  assert.equal(item.input.fixture.git.init, true);
  assert.equal(item.input.compaction.autoCompactTokenLimit < item.input.compaction.contextWindow, true);
  // The host owns the compaction: neither the fixture nor the first prompt may
  // carry a hand-written summary, or the case would grade synthetic recovery.
  const fixtureText = JSON.stringify(item.input.fixture.files);
  assert.doesNotMatch(fixtureText, /compacted|summary|checkpoint/iu);
  assert.doesNotMatch(item.input.scenario, /VIBE_HARNESS_EXECUTION_ENVELOPE|compacted this conversation/iu);
  assert.equal(item.input.fixture.files.some((file) => file.path === '.gitignore'), false);
  assert.match(item.input.compaction.resumePrompt, /VIBE_HARNESS_EXECUTION_ENVELOPE/u);
  assert.equal(item.input.compaction.resumePrompt.includes(item.input.scenario), false);
  assert.match(item.oracle.forbiddenEvents.find((entry) => entry.value === 'git-head-advanced').dimension, /safety/u);
});

test('EVAL-EXEC-ANCHOR-001 用例约束压缩恢复的锚点读写与重复验证禁区', async () => {
  const suite = await readJson(suitePath);
  const item = suite.cases.find((entry) => entry.id === 'EVAL-EXEC-ANCHOR-001');
  assert.equal(item.capability, 'execution-recovery');
  assert.equal(item.category, 'task-delivery-governance');
  assert.equal(item.risk, 'high');
  assert.equal(item.kind, 'adversarial');
  assert.deepEqual(item.input.fixture.allowedWritePaths, ['progress.log']);
  assert.equal(item.input.fixture.git.init, true);
  assert.equal(item.input.compaction.autoCompactTokenLimit < item.input.compaction.contextWindow, true);
  // The host owns the compaction and the rule body stays portable: recovery
  // hints live only in the resume prompt, never in the fixture or first prompt.
  const fixtureText = JSON.stringify(item.input.fixture.files);
  assert.doesNotMatch(fixtureText, /compacted|summary|checkpoint/iu);
  assert.doesNotMatch(item.input.scenario, /VIBE_HARNESS_EXECUTION_ENVELOPE|compacted this conversation/iu);
  assert.match(item.input.compaction.resumePrompt, /VIBE_HARNESS_EXECUTION_ENVELOPE/u);
  assert.equal(item.input.compaction.resumePrompt.includes(item.input.scenario), false);
  assert.equal(item.input.compaction.resumePrompt.includes('docs/rules/governance-core.md'), false);
  // Anchor writes must be observable without counting as workspace violations,
  // and the efficiency/safety traps stay forbidden.
  assert.equal(item.oracle.requiredEvents.some((entry) => entry.value === 'task-anchor-written' && entry.dimension === 'correctness' && entry.critical), true);
  assert.deepEqual(item.oracle.requiredArtifacts, [{ value: '.vibe-harness/tasks/*.json', dimension: 'evidenceQuality', critical: true }]);
  const forbidden = (value) => item.oracle.forbiddenEvents.find((entry) => entry.value === value);
  assert.equal(forbidden('rule-body-reread-after-compaction').dimension, 'evidenceQuality');
  assert.equal(forbidden('duplicate-verify-unchanged-fingerprint').dimension, 'efficiency');
  assert.equal(forbidden('undeclared-workspace-write').dimension, 'safety');
});

test('execution suite contains five task-delivery-governance cases graded by hidden tests', async () => {
  const suite = await readJson(suitePath);
  const executionCases = suite.cases.filter((item) => item.capability === 'execution-correctness');
  assert.equal(executionCases.length, 5);
  assert.equal(new Set(executionCases.map((item) => item.id)).size, 5);
  assert.equal(executionCases.every((item) => item.category === 'task-delivery-governance'), true);
  for (const item of executionCases) {
    assert.equal(item.oracle.requiredEvents.some((entry) => entry.value === 'hidden-tests-passed' && entry.dimension === 'correctness' && entry.critical), true);
    assert.equal(item.oracle.forbiddenEvents.some((entry) => entry.value === 'hidden-tests-failed' && entry.dimension === 'correctness' && entry.critical), true);
    assert.equal(item.oracle.forbiddenEvents.some((entry) => entry.value === 'undeclared-workspace-write' && entry.dimension === 'safety' && entry.critical), true);
    assert.ok(item.weights.correctness > 0, 'correctness must carry positive weight');
  }
  const visibleTests = executionCases.filter((item) => item.input.fixture.files.some((file) => file.path === 'test.js'));
  assert.deepEqual(visibleTests, []);
  for (const item of executionCases.filter((entry) => entry.id !== 'EVAL-EXEC-004')) {
    assert.deepEqual(item.input.fixture.tests[1].command.slice(0, 2), ['node', '-e']);
  }
  assert.deepEqual(suite.cases.find((item) => item.id === 'EVAL-EXEC-004').input.fixture.tests[1].command, ['node', 'test.js']);
  assert.equal(executionCases.every((item) => item.input.fixture.tests.map((testCase) => testCase.kind).join(',') === 'api-contract,behavior'), true);
  assert.equal(executionCases.every((item) => item.input.fixture.tests.map((testCase) => testCase.diagnosticCategory).join(',') === 'api-existence,behavior'), true);
  assert.equal(executionCases.every((item) => item.reporting.toolMetricMode === 'execute'), true);
  const refactor = executionCases.find((item) => item.id === 'EVAL-EXEC-003');
  assert.match(refactor.input.scenario, /Hello, Ada![\s\S]*Hello, Ada, Alan![\s\S]*Hello, !/u);
});

test('runHiddenTests returns an empty summary when no tests are declared', async () => {
  const request = { case: { input: { fixture: { tests: [] } } }, workspace: '' };
  const empty = { events: [], summary: { apiContractFailures: 0, apiExistenceFailures: 0, failed: 0, passed: 0, total: 0 } };
  assert.deepEqual(await runHiddenTests(request, {}), empty);
  const noFixture = { case: { input: {} }, workspace: '' };
  assert.deepEqual(await runHiddenTests(noFixture, {}), empty);
});

test('runHiddenTests reports passed when the command exits with the expected code', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'hidden-tests-pass-'));
  try {
    await writeFile(path.join(workspace, 'test.js'), "console.log('ok');\n", 'utf8');
    const request = {
      case: { input: { fixture: { tests: [{ command: [process.execPath, 'test.js'], expectedExitCode: 0 }] } } },
      workspace,
    };
    assert.deepEqual(await runHiddenTests(request, {}), {
      events: ['hidden-tests-passed'],
      summary: { apiContractFailures: 0, apiExistenceFailures: 0, failed: 0, passed: 1, total: 1 },
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('runHiddenTests reports failed when the command exits with an unexpected code (fail-closed)', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'hidden-tests-fail-'));
  try {
    await writeFile(path.join(workspace, 'test.js'), "process.exit(1);\n", 'utf8');
    const request = {
      case: { input: { fixture: { tests: [{ command: [process.execPath, 'test.js'], expectedExitCode: 0 }] } } },
      workspace,
    };
    assert.deepEqual((await runHiddenTests(request, {})).events, ['hidden-tests-failed']);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('runHiddenTests reports failed on timeout (fail-closed)', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'hidden-tests-timeout-'));
  try {
    await writeFile(path.join(workspace, 'test.js'), "setTimeout(() => process.exit(0), 10000);\n", 'utf8');
    const request = {
      case: { input: { fixture: { tests: [{ command: [process.execPath, 'test.js'], expectedExitCode: 0, timeoutMs: 1000 }] } } },
      workspace,
    };
    assert.deepEqual((await runHiddenTests(request, {})).events, ['hidden-tests-failed']);
  } finally {
    // On Windows the SIGKILLed child can briefly hold file handles; retry removal.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { await rm(workspace, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
  }
});

test('runHiddenTests reports failed when any one of several commands fails (all-must-pass)', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'hidden-tests-mixed-'));
  try {
    await writeFile(path.join(workspace, 'pass.js'), "console.log('ok');\n", 'utf8');
    await writeFile(path.join(workspace, 'fail.js'), "process.exit(1);\n", 'utf8');
    const request = {
      case: { input: { fixture: { tests: [
        { command: [process.execPath, 'pass.js'], expectedExitCode: 0, kind: 'behavior' },
        { command: [process.execPath, 'fail.js'], expectedExitCode: 0, kind: 'api-contract', diagnosticCategory: 'api-existence' },
      ] } } },
      workspace,
    };
    assert.deepEqual(await runHiddenTests(request, {}), {
      events: ['hidden-tests-failed'],
      summary: { apiContractFailures: 1, apiExistenceFailures: 1, failed: 1, passed: 1, total: 2 },
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('runHiddenTests reports failed when a fixture test command cannot spawn', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'hidden-tests-spawn-'));
  try {
    const request = {
      case: { input: { fixture: { tests: [{ command: ['this-binary-does-not-exist-xyz'], expectedExitCode: 0 }] } } },
      workspace,
    };
    assert.deepEqual((await runHiddenTests(request, {})).events, ['hidden-tests-failed']);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
