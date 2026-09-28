import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { runCommand } from '../../runtime/commands/run.mjs';
import { selectTierChecks } from '../../scripts/lib/validation-tiers.js';
import { buildVerificationPlan } from '../../scripts/lib/verification-plan.js';
import { runVerificationPlan } from '../../scripts/lib/project-verification.js';
import { detectProjectProfile } from '../../scripts/lib/project-profile.js';
import { verificationCheckEvidence } from '../../runtime/lib/verification-plan.mjs';

const execute = promisify(execFile);

async function fixture(callback) {
  const project = await mkdtemp(path.join(tmpdir(), 'verification-parity-'));
  try {
    await callback(project);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

async function configure(project, validationCommands) {
  await writeFile(path.join(project, 'vibe-harness.config.json'), JSON.stringify({ validationCommands }));
}

for (const tier of ['quick', 'standard', 'deep']) {
  test(`安装运行时与 CLI 档位选择一致：${tier}`, async () => {
    await fixture(async (project) => {
      const tiers = {
        quick: ['node aggregate.mjs'],
        standard: ['node backend.mjs'],
        deep: ['node journey.mjs'],
      };
      const commandStatus = { lint: { command: 'node lint.mjs', status: 'available' } };
      await configure(project, { lint: commandStatus.lint.command, tiers });
      const { report, exitCode } = await runCommand(['verify', '--project', project, '--tier', tier, '--plan']);
      const expected = selectTierChecks({ tier, tiers, commandStatus });
      assert.equal(exitCode, 0);
      assert.equal(report.minimumTier, null);
      assert.deepEqual(report.selectedChecks, expected.selectedChecks.map((check) => check.id));
      assert.deepEqual(
        report.selectedChecks.map((id) => report.checks[id].cwd),
        expected.selectedChecks.map((check) => check.cwd),
      );
      assert.deepEqual(
        report.selectedChecks.map((id) => report.checks[id].command),
        expected.selectedChecks.map((check) => check.command),
      );
      assert.deepEqual(
        report.deferredChecks.map((check) => check.command),
        expected.deferredChecks.map((check) => check.command),
      );
      assert.deepEqual(report.deferredChecks.map((check) => check.name), expected.deferredChecks.map((check) => check.id));
      await assert.rejects(readFile(path.join(project, '.vibe-harness/verification/receipts/index.json')));
    });
  });
}

test('安装运行时执行额外档位命令并绑定子目录', async () => {
  await fixture(async (project) => {
    await mkdir(path.join(project, 'backend'));
    await writeFile(path.join(project, 'backend', 'check.mjs'), 'console.log(process.cwd());\n');
    await configure(project, {
      tiers: { quick: [], standard: ['node check.mjs'], deep: [] },
      checks: [{ id: 'backend', command: 'node check.mjs', cwd: 'backend' }],
    });
    const { report, exitCode } = await runCommand(['verify', '--project', project, '--tier', 'standard']);
    assert.equal(exitCode, 0, JSON.stringify(report));
    assert.equal(report.checks.backend.status, 'passed');
    assert.equal(report.checks.backend.cwd, 'backend');
    assert.match(report.checks.backend.stdout, /backend/u);
  });
});

test('安装运行时拒绝检查目录逃逸', async () => {
  await fixture(async (project) => {
    await configure(project, {
      tiers: { quick: ['node check.mjs'], standard: [], deep: [] },
      checks: [{ id: 'escape', command: 'node check.mjs', cwd: '..' }],
    });
    const { report, exitCode } = await runCommand(['verify', '--project', project, '--plan']);
    assert.equal(exitCode, 1);
    assert.match(report.error, /cwd|directory|目录/u);
  });
});

test('CLI 不因显示 ID 碰撞丢弃不同检查', () => {
  const result = selectTierChecks({
    tier: 'quick',
    tiers: { quick: ['node check.mjs a/b', 'node check.mjs a-b'], standard: [], deep: [] },
  });
  assert.equal(result.selectedChecks.length, 2);
  assert.equal(new Set(result.selectedChecks.map((check) => check.id)).size, 2);
});

test('CLI 与 runtime 执行相同的子目录检查并传递显式范围', async () => {
  await fixture(async (project) => {
    await mkdir(path.join(project, 'backend'));
    await writeFile(path.join(project, 'backend', 'check.mjs'), 'console.log(process.env.VIBE_HARNESS_VERIFY_PATHS);\n');
    const validationCommands = {
      tiers: { quick: ['node check.mjs'], standard: [], deep: [] },
      checks: [{ id: 'backend', command: 'node check.mjs', cwd: 'backend' }],
    };
    await configure(project, validationCommands);
    const plan = await buildVerificationPlan({
      config: { validationCommands }, tiers: validationCommands.tiers, tier: 'quick',
      targetDir: project, changedPaths: ['backend/example.java'],
    });
    const cli = await runVerificationPlan({ plan: { ...plan, changedPaths: ['backend/example.java'] }, targetDir: project });
    const runtime = await runCommand(['verify', '--project', project, '--paths', 'backend/example.java', '--only', 'backend']);
    assert.equal(cli.ok, true, JSON.stringify(cli.error));
    assert.equal(runtime.exitCode, 0, JSON.stringify(runtime.report));
    assert.match(cli.results.backend.stdout, /backend\/example.java/u);
    assert.equal(cli.results.backend.stdout.trim(), runtime.report.checks.backend.stdout.trim());
  });
});

test('运行时拒绝未知检查和未关联的旧元数据', async () => {
  await fixture(async (project) => {
    await configure(project, { test: 'node test.mjs' });
    const unknown = await runCommand(['verify', '--project', project, '--plan', '--only', 'missing']);
    assert.equal(unknown.exitCode, 1);
    assert.match(unknown.report.error, /Unknown checks/u);
    await configure(project, { test: 'node test.mjs', checks: [{ id: 'missing' }] });
    const unresolved = await runCommand(['verify', '--project', project, '--plan']);
    assert.equal(unresolved.exitCode, 1);
    assert.match(unresolved.report.error, /Cannot resolve/u);
  });
});

async function reusableFixture(project, deterministic = true) {
  await writeFile(path.join(project, '.gitignore'), '.vibe-harness/\nruns.txt\n');
  await writeFile(path.join(project, 'check.mjs'), "import { appendFileSync } from 'node:fs'; appendFileSync('runs.txt', 'run\\n');\n");
  await configure(project, {
    test: 'node check.mjs',
    checks: [{ id: 'test', deterministic }],
  });
  await execute('git', ['init', '--quiet'], { cwd: project });
  await execute('git', ['add', '.'], { cwd: project });
  await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'fixture'], { cwd: project });
}

test('无锚点验证复用 v3 收据且未跟踪源码变化使其失效', async () => {
  await fixture(async (project) => {
    await reusableFixture(project);
    const first = await runCommand(['verify', '--project', project]);
    assert.equal(first.exitCode, 0);
    const second = await runCommand(['verify', '--project', project, '--reuse']);
    assert.equal(second.report.status, 'reused');
    assert.equal(second.report.verification.schemaVersion, 3);
    assert.equal(second.report.reused.id, first.report.verification.id);
    assert.equal(await readFile(path.join(project, 'runs.txt'), 'utf8'), 'run\n');
    await writeFile(path.join(project, 'new-source.js'), 'export const value = 1;\n');
    const changed = await runCommand(['verify', '--project', project, '--reuse']);
    assert.equal(changed.report.status, 'passed');
    assert.equal(changed.report.cache.status, 'miss');
    assert.equal(await readFile(path.join(project, 'runs.txt'), 'utf8'), 'run\nrun\n');
  });
});

test('未显式声明确定性时不复用无锚点收据', async () => {
  await fixture(async (project) => {
    await reusableFixture(project, false);
    await runCommand(['verify', '--project', project]);
    const second = await runCommand(['verify', '--project', project, '--reuse']);
    assert.equal(second.report.status, 'passed');
    assert.equal(await readFile(path.join(project, 'runs.txt'), 'utf8'), 'run\nrun\n');
  });
});

test('CLI 与安装运行时共享可复用收据', async () => {
  await fixture(async (project) => {
    await reusableFixture(project);
    const config = JSON.parse(await readFile(path.join(project, 'vibe-harness.config.json'), 'utf8'));
    const plan = await buildVerificationPlan({
      config, targetDir: project, tier: 'quick',
      commandStatus: { test: { command: 'node check.mjs', status: 'available' } },
      tiers: { quick: ['node check.mjs'], standard: [], deep: [] },
    });
    const head = await execute('git', ['rev-parse', 'HEAD'], { cwd: project });
    const cliPlan = { ...plan, baseSha: head.stdout.trim(), changedPaths: [] };
    const cli = await runVerificationPlan({ plan: cliPlan, targetDir: project });
    assert.equal(cli.ok, true, JSON.stringify(cli.error));
    const runtime = await runCommand(['verify', '--project', project, '--reuse']);
    assert.equal(runtime.report.status, 'reused');
    assert.equal(runtime.report.verification.engine, 'vibe-harness-runtime');
    assert.equal(runtime.report.reused.id, cli.verification.id);
    const replay = await runVerificationPlan({ plan: cliPlan, targetDir: project, reuse: true });
    assert.equal(replay.verification.cache.status, 'hit');
    assert.equal(replay.verification.engine, 'vibe-harness-cli');
    assert.equal(await readFile(path.join(project, 'runs.txt'), 'utf8'), 'run\n');
  });
});

test('环境和锁文件变化使收据失效', async () => {
  const previous = process.env.NODE_ENV;
  try {
    await fixture(async (project) => {
      await reusableFixture(project);
      await runCommand(['verify', '--project', project]);
      process.env.NODE_ENV = 'verification-fixture';
      const environmentChanged = await runCommand(['verify', '--project', project, '--reuse']);
      assert.equal(environmentChanged.report.cache.status, 'miss');
      await writeFile(path.join(project, 'bun.lock'), 'changed dependency graph');
      const dependenciesChanged = await runCommand(['verify', '--project', project, '--reuse']);
      assert.equal(dependenciesChanged.report.cache.status, 'miss');
      assert.equal(await readFile(path.join(project, 'runs.txt'), 'utf8'), 'run\nrun\nrun\n');
    });
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test('检查声明不适用时不产生通过或可复用证据', async () => {
  await fixture(async (project) => {
    await reusableFixture(project);
    await writeFile(path.join(project, 'check.mjs'), 'console.log(\'[VIBE_HARNESS_CHECK] {"status":"not_applicable","reason":"no relevant source"}\');\n');
    const result = await runCommand(['verify', '--project', project]);
    assert.equal(result.report.status, 'unverified');
    assert.equal(result.report.checks.test.status, 'not_selected');
    assert.notEqual(result.report.verification.status, 'verified');
    assert.equal(result.report.cache.stored, false);
  });
});

test('stderr 不适用标记与失败标记不会被退出零或后续跳过覆盖', async () => {
  assert.deepEqual(
    verificationCheckEvidence(
      '[VIBE_HARNESS_CHECK] {"status":"failed","reason":"coverage gap"}',
      '[VIBE_HARNESS_CHECK] {"status":"not_applicable","reason":"later skip"}',
    ),
    { status: 'failed', reason: 'coverage gap' },
  );
  await fixture(async (project) => {
    await reusableFixture(project);
    await writeFile(path.join(project, 'check.mjs'), 'console.warn(\'[VIBE_HARNESS_CHECK] {"status":"not_applicable","reason":"no behavior"}\');\n');
    const runtime = await runCommand(['verify', '--project', project]);
    assert.equal(runtime.report.checks.test.status, 'not_selected');
    assert.equal(runtime.report.status, 'unverified');
    const cli = await runVerificationPlan({
      targetDir: project,
      plan: { selectedChecks: [{ id: 'test', command: 'node check.mjs', deterministic: true }], changedPaths: ['check.mjs'] },
    });
    assert.equal(cli.ok, false);
    assert.equal(cli.verification.changeBoundary.status, 'unverified');
    assert.notEqual(cli.verification.evidence.commandExecution.status, 'passed');
    await assert.rejects(readdir(path.join(project, '.vibe-harness/verification/receipts')));
  });
});

test('聚合命令按参数与目录规范化去重且旧插槽别名只执行一次', () => {
  const plan = selectTierChecks({
    tier: 'deep',
    tiers: { quick: ['node  check.mjs', 'node "check.mjs"'], standard: ['node check.mjs'], deep: [] },
  });
  assert.equal(plan.selectedChecks.length, 1);
  const aliases = selectTierChecks({
    tier: 'quick',
    tiers: { quick: ['node check.mjs'], standard: [], deep: [] },
    commandStatus: { lint: { command: 'node check.mjs' }, test: { command: 'node check.mjs' } },
    only: ['lint', 'test'],
  });
  assert.equal(aliases.selectedChecks.length, 1);
  const reserved = selectTierChecks({
    tier: 'quick',
    tiers: { quick: ['node check.mjs', 'node other.mjs'], standard: [], deep: [] },
    metadata: [{ id: 'check-mjs', command: 'node other.mjs' }],
  });
  assert.equal(reserved.selectedChecks.length, 2);
  assert.notEqual(reserved.selectedChecks[0].id, 'check-mjs');
  assert.equal(reserved.selectedChecks[1].id, 'check-mjs');
});

test('旧配置从同一根目录事实推导而不把子目录 Maven 当根项目', async () => {
  await fixture(async (project) => {
    await mkdir(path.join(project, 'backend'));
    await writeFile(path.join(project, 'backend/pom.xml'), '<project/>');
    await writeFile(path.join(project, 'package.json'), JSON.stringify({ scripts: { lint: 'node lint.mjs' } }));
    const config = { projectName: 'Fixture', packageManager: 'npm', validationCommands: {} };
    await writeFile(path.join(project, 'vibe-harness.config.json'), JSON.stringify(config));
    const runtime = await runCommand(['verify', '--project', project, '--tier', 'deep', '--plan']);
    for (const mode of ['auto', 'manual', 'off']) {
      const profile = await detectProjectProfile({ config: { ...config, projectRules: { mode } }, targetDir: project });
      const cli = selectTierChecks({ tier: 'deep', tiers: profile.validationTiers, projectDir: project });
      assert.deepEqual(runtime.report.selectedChecks.map((id) => runtime.report.checks[id].command), cli.selectedChecks.map((check) => check.command), mode);
      assert.deepEqual(profile.validationTiers.standard, [], mode);
    }
  });
});

test('运行期间变更不写通过收据且配置损坏不会静默降级', async () => {
  await fixture(async (project) => {
    await reusableFixture(project);
    await writeFile(path.join(project, 'check.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('changed.txt', String(Date.now()));\n");
    const result = await runCommand(['verify', '--project', project, '--reuse']);
    assert.equal(result.report.status, 'failed');
    assert.equal(result.report.cache.stored, false);
    await writeFile(path.join(project, 'vibe-harness.config.json'), '{');
    const invalid = await runCommand(['verify', '--project', project, '--plan']);
    assert.equal(invalid.exitCode, 1);
    assert.equal(invalid.report.status, 'blocked');
  });
});

test('旧版和失败收据不能复用且后续失败移除同状态旧通过证据', async () => {
  await fixture(async (project) => {
    await reusableFixture(project);
    await writeFile(path.join(project, 'check.mjs'), "import { existsSync, appendFileSync } from 'node:fs'; if (existsSync('runs.txt')) process.exit(1); appendFileSync('runs.txt', 'run\\n');\n");
    const first = await runCommand(['verify', '--project', project]);
    assert.equal(first.report.status, 'passed');
    const directory = path.join(project, '.vibe-harness/verification/receipts');
    const [filename] = await readdir(directory);
    const file = path.join(directory, filename);
    const receipt = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...receipt, schemaVersion: 2 }));
    const legacy = await runCommand(['verify', '--project', project, '--reuse']);
    assert.equal(legacy.report.cache.status, 'miss');
    assert.equal(legacy.report.status, 'failed');
    await assert.rejects(readFile(file));
    await writeFile(file, JSON.stringify(receipt));
    const failure = await runCommand(['verify', '--project', project]);
    assert.equal(failure.report.status, 'failed');
    await assert.rejects(readFile(file));
  });
});

test('不同工作区不会命中另一工作区的通过收据', async () => {
  await fixture(async (firstProject) => {
    await fixture(async (secondProject) => {
      await reusableFixture(firstProject);
      await reusableFixture(secondProject);
      await runCommand(['verify', '--project', firstProject]);
      const directory = '.vibe-harness/verification/receipts';
      const [file] = await readdir(path.join(firstProject, directory));
      const receipt = await readFile(path.join(firstProject, directory, file), 'utf8');
      await mkdir(path.join(secondProject, directory), { recursive: true });
      await writeFile(path.join(secondProject, directory, file), receipt);
      const result = await runCommand(['verify', '--project', secondProject, '--reuse']);
      assert.equal(result.report.cache.status, 'miss');
      assert.equal(result.report.status, 'passed');
      assert.equal(await readFile(path.join(secondProject, 'runs.txt'), 'utf8'), 'run\n');
    });
  });
});

test('Windows Maven Wrapper 在声明子目录执行且两个引擎一致', { skip: process.platform !== 'win32' }, async () => {
  await fixture(async (project) => {
    await mkdir(path.join(project, 'backend'));
    await writeFile(path.join(project, 'backend/mvnw.cmd'), '@echo off\r\necho %CD%\r\nexit /b 0\r\n');
    await configure(project, {
      tiers: { quick: ['mvnw.cmd test'], standard: [], deep: [] },
      checks: [{ id: 'backend', command: 'mvnw.cmd test', cwd: 'backend' }],
    });
    const runtime = await runCommand(['verify', '--project', project]);
    assert.equal(runtime.exitCode, 0, JSON.stringify(runtime.report));
    const cli = await runVerificationPlan({ targetDir: project, plan: { selectedChecks: [{ id: 'backend', command: 'mvnw.cmd test', cwd: 'backend' }] } });
    assert.equal(cli.ok, true, JSON.stringify(cli.error));
    assert.equal(cli.results.backend.stdout.trim(), runtime.report.checks.backend.stdout.trim());
  });
});

test('空变更范围不产生行为证据且计划模式不写收据', async () => {
  await fixture(async (project) => {
    await reusableFixture(project);
    const planned = await runCommand(['verify', '--project', project, '--plan', '--reuse', '--scope', 'affected']);
    assert.equal(planned.report.status, 'planned');
    assert.equal(planned.report.noChanges, true);
    const empty = await runCommand(['verify', '--project', project, '--scope', 'affected']);
    assert.equal(empty.exitCode, 0);
    assert.equal(empty.report.status, 'unverified');
    assert.equal(empty.report.noChanges, true);
    await assert.rejects(readFile(path.join(project, 'runs.txt')));
    await assert.rejects(readdir(path.join(project, '.vibe-harness/verification/receipts')));
  });
});

test('所有档位显式禁用时 CLI 不回退到旧插槽执行', async () => {
  await fixture(async (project) => {
    const tiers = { quick: [], standard: [], deep: [] };
    const validationCommands = { test: 'node test.mjs', tiers };
    await configure(project, validationCommands);
    const cli = await buildVerificationPlan({
      config: { validationCommands }, tiers, tier: 'quick', targetDir: project,
      tierExplicit: true,
      commandStatus: { test: { command: 'node test.mjs', status: 'available' } },
    });
    const runtime = await runCommand(['verify', '--project', project, '--tier', 'quick', '--plan']);
    assert.deepEqual(cli.selectedChecks, []);
    assert.deepEqual(runtime.report.selectedChecks, []);
  });
});

test('任一检查失败后两个引擎均不执行后续已选择检查', async () => {
  await fixture(async (project) => {
    await writeFile(path.join(project, 'fail.mjs'), 'process.exit(1);\n');
    await writeFile(path.join(project, 'later.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('unexpected.txt', 'ran');\n");
    const tiers = { quick: ['node fail.mjs'], standard: ['node later.mjs'], deep: [] };
    await configure(project, { tiers });
    const runtime = await runCommand(['verify', '--project', project, '--tier', 'standard']);
    assert.equal(runtime.report.status, 'failed');
    assert.equal(runtime.report.checks['later-mjs'].status, 'not_run');
    const cli = await runVerificationPlan({
      targetDir: project,
      plan: selectTierChecks({ tier: 'standard', tiers, projectDir: project }),
    });
    assert.equal(cli.ok, false);
    assert.equal(cli.results['later-mjs'].status, 'not_run');
    await assert.rejects(readFile(path.join(project, 'unexpected.txt')));
  });
});

test('额外命令的缺失与手动授权在两个引擎保持阻塞语义', async () => {
  await fixture(async (project) => {
    await writeFile(path.join(project, 'check.mjs'), 'console.log("checked");\n');
    const tiers = { quick: ['manual:node check.mjs', 'vibe-harness-missing-fixture-tool-9821'], standard: [], deep: [] };
    await configure(project, { tiers });
    const selection = selectTierChecks({ tier: 'quick', tiers, projectDir: project });
    const runtime = await runCommand(['verify', '--project', project]);
    const cli = await runVerificationPlan({ targetDir: project, plan: selection });
    assert.equal(runtime.report.status, 'blocked');
    assert.equal(cli.ok, false);
    for (const check of selection.selectedChecks) {
      assert.equal(cli.results[check.id].status, 'blocked');
      assert.equal(runtime.report.checks[check.id].status, 'blocked');
    }
    await configure(project, { tiers: { ...tiers, quick: ['manual:node check.mjs'] } });
    const allowedRuntime = await runCommand(['verify', '--project', project, '--allow-manual']);
    const allowedCli = await runVerificationPlan({ targetDir: project, plan: { selectedChecks: [selection.selectedChecks[0]] }, allowManual: true });
    assert.equal(allowedRuntime.report.status, 'passed');
    assert.equal(allowedCli.ok, true);
  });
});
