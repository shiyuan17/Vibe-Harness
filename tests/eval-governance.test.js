import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { readJson } from '../scripts/lib/manifest.js';
import { validateCapabilityMatrix } from '../scripts/lib/pack-validation.js';
import { validateTasks } from '../runtime/governance/lib/task-validation.mjs';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve('.');
const cliPath = path.join(rootDir, 'scripts/cognis.js');

async function evaluationRun({ cases, referenceStatus = 'matched' }) {
  const run = await readJson(path.join(rootDir, 'evals/results/cognis-core.offline.json'));
  run.reference = { path: 'evals/references/core.json', status: referenceStatus };
  if (cases[0]?.id === 'EVAL-OTHER-001') {
    const result = run.cases.find((item) => item.id === 'EVAL-GOV-001');
    result.id = 'EVAL-OTHER-001';
    run.caseRepetitions.find((item) => item.id === 'EVAL-GOV-001').id = 'EVAL-OTHER-001';
  } else if (cases.length > 1) {
    const original = run.cases.find((item) => item.id === 'EVAL-GOV-001');
    run.cases.push({ ...structuredClone(original), passed: false, criticalFailures: 1 });
    run.caseRepetitions.find((item) => item.id === 'EVAL-GOV-001').count = 2;
  }
  return run;
}

async function taskProject(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'cognis-eval-task-'));
  await mkdir(path.join(root, 'docs/tasks'), { recursive: true });
  await mkdir(path.join(root, 'docs/schemas'), { recursive: true });
  await mkdir(path.join(root, '.cognis/evals/runs'), { recursive: true });
  await writeFile(
    path.join(root, 'docs/schemas/full-task-control.schema.json'),
    await readFile(path.join(rootDir, 'schemas/full-task-control.schema.json'), 'utf8'),
    'utf8',
  );
  await writeFile(
    path.join(root, 'docs/schemas/eval-run.schema.json'),
    await readFile(path.join(rootDir, 'schemas/eval-run.schema.json'), 'utf8'),
    'utf8',
  );
  for (const name of ['eval-suite', 'eval-reference']) {
    await writeFile(
      path.join(root, `docs/schemas/${name}.schema.json`),
      await readFile(path.join(rootDir, `schemas/${name}.schema.json`), 'utf8'),
      'utf8',
    );
  }
  await mkdir(path.join(root, 'evals/suites'), { recursive: true });
  await mkdir(path.join(root, 'evals/references'), { recursive: true });
  await writeFile(
    path.join(root, 'evals/suites/cognis-core.json'),
    await readFile(path.join(rootDir, 'evals/suites/cognis-core.json'), 'utf8'),
    'utf8',
  );
  await writeFile(
    path.join(root, 'evals/references/core.json'),
    await readFile(path.join(rootDir, 'evals/references/cognis-core.offline.json'), 'utf8'),
    'utf8',
  );
  await writeFile(path.join(root, 'cognis.config.json'), `${JSON.stringify({
    evaluations: {
      repetitions: 3,
      thresholds: { criticalPassRate: 1, overallScore: 0.9, maxCapabilityRegression: 0.05 },
    },
  })}\n`, 'utf8');
  await writeFile(path.join(root, '.cognis/evals/runs/pass.json'), `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  await writeFile(path.join(root, 'docs/tasks/T-EVAL.md'), `# T-EVAL 评测任务

- 工作流档位：快速
- 当前阶段：交付
- 当前状态：空闲
- 处理结果：完成

## 目标

验证治理行为。

## 验收标准

| AC-ID | 标准 |
| --- | --- |
| AC-01 | 评测行为通过。 |

## 评测映射

| AC-ID | Eval-ID |
| --- | --- |
| AC-01 | EVAL-GOV-001 |

## 验证计划

运行聚焦评测。

## 下一步动作

交付评测证据。

## 验收证据

| AC-ID | 证据类型 | 命令或产物 | 退出码 | 核验时间 | 核验者 | 实际结果 |
| --- | --- | --- | --- | --- | --- | --- |
| AC-01 | 评测 | .cognis/evals/runs/pass.json | 0 | 2026-07-14T00:00:00Z | 独立核验者 | 评测通过 |

## 剩余风险

无已知剩余风险。
`, 'utf8');
  return root;
}

test('completed task accepts a mapped evaluation run with matched reference and critical pass', async () => {
  const root = await taskProject(await evaluationRun({
    cases: [{ id: 'EVAL-GOV-001', passed: true }],
  }));
  try {
    assert.deepEqual(validateTasks(root), []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('evaluation evidence rejects mismatched reference and missing mapped case', async () => {
  const root = await taskProject(await evaluationRun({
    referenceStatus: 'mismatched',
    cases: [{ id: 'EVAL-OTHER-001', passed: true }],
  }));
  try {
    const errors = validateTasks(root).join('\n');
    assert.match(errors, /reference/u);
    assert.match(errors, /EVAL-GOV-001/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('evaluation evidence requires every repetition of the mapped case to pass', async () => {
  const root = await taskProject(await evaluationRun({
    cases: [
      { id: 'EVAL-GOV-001', passed: true },
      { id: 'EVAL-GOV-001', passed: false },
    ],
  }));
  try {
    assert.match(validateTasks(root).join('\n'), /EVAL-GOV-001/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('evaluation evidence recomputes reference fingerprint instead of trusting matched status', async () => {
  const run = await evaluationRun({ cases: [{ id: 'EVAL-GOV-001', passed: true }] });
  run.fingerprint.model = 'tampered-model';
  const root = await taskProject(run);
  try {
    assert.match(validateTasks(root).join('\n'), /reference fingerprint/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('EDD skill is description-routed, registered, capability-backed, and installed by core', async () => {
  const [skills, profiles, installMap, capabilities, routing] = await Promise.all([
    readJson(path.join(rootDir, 'manifests/skills.json')),
    readJson(path.join(rootDir, 'manifests/profiles.json')),
    readJson(path.join(rootDir, 'adapters/codex/install-map.json')),
    readJson(path.join(rootDir, 'manifests/capabilities.json')),
    readFile(path.join(rootDir, 'rules/agent-skill-routing.md'), 'utf8'),
  ]);
  assert.ok(skills.items.find((item) => item.id === 'eval-driven-development'));
  assert.match(routing, /eval-driven-development/u);
  assert.ok(capabilities.items.find((item) => item.id === 'eval-driven-development'));
  assert.deepEqual(await validateCapabilityMatrix(rootDir, capabilities), []);
  const evalGroups = new Set(installMap.entries.filter((item) => /eval-driven-development|runtime\/evals|evals\/suites/u.test(item.source)).map((item) => item.group));
  assert.equal(evalGroups.has('skills-core'), true);
  assert.equal(evalGroups.has('runtime-eval'), true);
  assert.equal(evalGroups.has('evals-core'), true);
  assert.equal(profiles.items.find((item) => item.id === 'minimal').groups.includes('runtime-eval'), false);
  assert.equal(profiles.items.find((item) => item.id === 'core').groups.includes('runtime-eval'), true);
  assert.equal(profiles.items.find((item) => item.id === 'docs-only').groups.includes('runtime-eval'), false);
});

test('profile installation exposes only the claimed EDD surfaces', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-eval-install-'));
  try {
    await execFileAsync(process.execPath, [cliPath, 'init', '--project', target], { cwd: rootDir });
    await execFileAsync(process.execPath, [cliPath, 'install', '--project', target, '--target', 'codex', '--profile', 'core', '--write'], { cwd: rootDir });
    await readFile(path.join(target, '.agents/skills/eval-driven-development/SKILL.md'), 'utf8');
    await readFile(path.join(target, '.agents/cognis/evals/run.mjs'), 'utf8');
    await readFile(path.join(target, '.agents/evals/suites/cognis-core.json'), 'utf8');
    await readFile(path.join(target, 'docs/schemas/eval-run.schema.json'), 'utf8');
    const offline = await execFileAsync(process.execPath, [
      '.agents/cognis/evals/run.mjs',
      '--project', target,
      '--suite', '.agents/evals/suites/cognis-core.json',
      '--reference', '.agents/evals/references/cognis-core.offline.json',
    ], { cwd: target });
    const report = JSON.parse(offline.stdout);
    assert.equal(report.status, 'passed');
    assert.equal(report.reference.status, 'matched');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
