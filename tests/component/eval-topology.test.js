import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { collectEvalSyncPlan } from '../../scripts/lib/eval-projection.js';

const rootDir = path.resolve(import.meta.dirname, '../..');
const execFileAsync = promisify(execFile);

const EXPECTED_EVALS_FILES = [
  'evals/clarification-cases.json',
  'evals/goal-definition-cases.json',
  'evals/goal-definition-trials.json',
  'evals/references/vibe-harness-core.offline.json',
  'evals/results/vibe-harness-behavioral.stub.json',
  'evals/results/vibe-harness-core.offline.json',
  'evals/suites/linear-workflow-online.json',
  'evals/suites/vibe-harness-behavioral.json',
  'evals/suites/vibe-harness-core.json',
  'evals/suites/vibe-harness-online-autonomy.json',
  'evals/suites/vibe-harness-online-canary.json',
  'evals/suites/vibe-harness-online-execution.json',
  'evals/suites/vibe-harness-response-modes.json',
  'evals/suites/vibe-harness-role-routing.json',
  'evals/suites/vibe-harness-tool-routing.json',
];

const EXPECTED_PROJECTION_FILES = [
  '.agents/evals/references/vibe-harness-core.offline.json',
  '.agents/evals/suites/vibe-harness-core.json',
  '.agents/evals/suites/vibe-harness-online-autonomy.json',
  '.agents/evals/suites/vibe-harness-online-canary.json',
  '.agents/evals/suites/vibe-harness-online-execution.json',
  '.agents/evals/suites/vibe-harness-response-modes.json',
  '.agents/evals/suites/vibe-harness-role-routing.json',
];

const IGNORED_GENERATED_DIRS = [
  'harness-evals/reports/generated',
  'harness-evals/traces/runs',
  'harness-evals/baselines/candidates',
  'harness-evals/regressions/generated',
  '.vibe-harness',
];

async function walkFiles(directory, results = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return results;
    throw error;
  }
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await walkFiles(fullPath, results);
    else if (entry.isFile()) results.push(path.relative(rootDir, fullPath).replaceAll('\\', '/'));
  }
  return results;
}

async function listFiles(relativeDir) {
  return (await walkFiles(path.join(rootDir, relativeDir))).sort();
}

async function gitLsFiles(paths) {
  const { stdout } = await execFileAsync('git', ['ls-files', '--', ...paths], { cwd: rootDir });
  return stdout.split('\n').filter(Boolean);
}

test('eval 投影与源字节一致且无孤儿', async () => {
  const plan = await collectEvalSyncPlan({ rootDir });
  assert.equal(plan.ok, true);
  assert.equal(plan.projectedCount, 7);
  assert.deepEqual(plan.drift, []);
  assert.deepEqual(plan.manualActions, []);
});

test('evals 目录恰好包含文档声明的签入资产清单', async () => {
  assert.deepEqual(await listFiles('evals'), EXPECTED_EVALS_FILES);
  assert.deepEqual(await listFiles('.agents/evals'), EXPECTED_PROJECTION_FILES);
});

test('eval 资产源与投影全部被 git 跟踪（fresh clone 可运行 eval:check）', async () => {
  // eval:check 无条件读取 behavioral 套件与产物；漏 git add 会让新 clone 直接失败。
  const tracked = new Set(await gitLsFiles(['evals', '.agents/evals']));
  const untracked = [...EXPECTED_EVALS_FILES, ...EXPECTED_PROJECTION_FILES]
    .filter((file) => !tracked.has(file));
  assert.deepEqual(untracked, []);
});

test('运行生成目录与 .vibe-harness 不得包含被跟踪文件', async () => {
  // 这些目录本地缺失不是缺陷：历史由 CI 产生，缺失等同空历史。
  assert.deepEqual(await gitLsFiles(IGNORED_GENERATED_DIRS), []);
});

test('harness-evals 框架资产在位且不复制旧 evals 资产', async () => {
  const tracked = await gitLsFiles(['harness-evals']);
  assert.ok(tracked.some((file) => file.startsWith('harness-evals/scenarios/')));
  assert.ok(tracked.some((file) => file.startsWith('harness-evals/fixtures/')));
  assert.ok(tracked.every((file) => !IGNORED_GENERATED_DIRS.some((dir) => file.startsWith(`${dir}/`))));

  const normalize = (content) => content.replace(/\r\n/gu, '\n');
  const evalsContents = new Set();
  for (const file of await listFiles('evals')) {
    evalsContents.add(normalize(await readFile(path.join(rootDir, file), 'utf8')));
  }
  for (const file of await listFiles('harness-evals')) {
    const content = normalize(await readFile(path.join(rootDir, file), 'utf8'));
    assert.ok(!evalsContents.has(content), `harness-evals/${file} duplicates an evals/ asset`);
  }
});
