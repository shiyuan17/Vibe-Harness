import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
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
import { verifyProject } from '../../runtime/lib/verification-command.mjs';
import { verificationCacheContext, findVerificationCheckReceipt, storeVerificationCheckReceipt,
  VERIFICATION_RECEIPT_SCHEMA_VERSION } from '../../runtime/lib/verification-receipt.mjs';

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

async function configureTreeContent(project, checks) {
  await writeFile(path.join(project, 'vibe-harness.config.json'), JSON.stringify({
    validationCommands: { tiers: { quick: checks.map((check) => check.command), standard: [], deep: [] }, checks },
    verification: { reuse: { mode: 'tree-content', envAllowlist: ['VIBE_TEST_ALLOWED'] } },
  }));
}

async function checkCacheDirectory(project) {
  const common = (await execute('git', ['rev-parse', '--git-common-dir'], { cwd: project })).stdout.trim();
  return path.join(project, common, 'vibe-harness', 'verification-cache', `v${VERIFICATION_RECEIPT_SCHEMA_VERSION}`);
}

async function commitFixture(project) {
  await execute('git', ['init', '--quiet'], { cwd: project });
  await execute('git', ['add', '.'], { cwd: project });
  await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    'commit', '--quiet', '-m', 'fixture'], { cwd: project });
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
      assert.equal(report.minimumTier, 'micro');
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

test('无锚点验证复用已认证收据且未跟踪源码变化使其失效', async () => {
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

test('tree-content 缓存跨 worktree 与空提交 HEAD 复用并在未跟踪内容变化时失效', async () => {
  await fixture(async (project) => {
    await writeFile(path.join(project, '.gitignore'), '.vibe-harness/\nruns.txt\n');
    await writeFile(path.join(project, 'check.mjs'), "import { appendFileSync } from 'node:fs'; appendFileSync('runs.txt', 'run\\n');\n");
    await configureTreeContent(project, [{ id: 'test', command: 'node check.mjs', deterministic: true, cacheScope: 'tree' }]);
    await execute('git', ['init', '--quiet'], { cwd: project });
    await execute('git', ['add', '.'], { cwd: project });
    await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'fixture'], { cwd: project });
    const first = await runCommand(['verify', '--project', project]);
    assert.equal(first.report.status, 'passed', JSON.stringify(first.report));
    assert.equal(await readFile(path.join(project, 'runs.txt'), 'utf8'), 'run\n');

    const parent = await mkdtemp(path.join(tmpdir(), 'verification-worktree-'));
    const worktree = path.join(parent, 'checkout');
    try {
      await execute('git', ['worktree', 'add', '--detach', worktree, 'HEAD'], { cwd: project });
      // Different HEAD, identical tree content: the tree-scoped check is still
      // addressed by what the code says, not by the commit that carries it.
      await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '--quiet', '-m', 'empty'], { cwd: worktree });
      const second = await runCommand(['verify', '--project', worktree, '--reuse']);
      assert.equal(second.report.status, 'reused', JSON.stringify(second.report));
      assert.equal(second.report.checks.test.status, 'reused');
      await assert.rejects(readFile(path.join(worktree, 'runs.txt')));

      await writeFile(path.join(worktree, 'new-source.js'), 'export const value = 1;\n');
      const changed = await runCommand(['verify', '--project', worktree, '--reuse']);
      assert.equal(changed.report.status, 'passed');
      assert.equal(changed.report.cache.status, 'miss');
      assert.equal(await readFile(path.join(worktree, 'runs.txt'), 'utf8'), 'run\n');
    } finally {
      await execute('git', ['worktree', 'remove', '--force', worktree], { cwd: project }).catch(() => {});
      await rm(parent, { force: true, recursive: true });
    }
  });
});

test('非确定性检查 miss 不使已命中的 tree-scope 检查失效', async () => {
  await fixture(async (project) => {
    await writeFile(path.join(project, '.gitignore'), '.vibe-harness/\nfront.runs\nback.runs\n');
    await writeFile(path.join(project, 'front.mjs'), "import { appendFileSync } from 'node:fs'; appendFileSync('front.runs', 'run\\n');\n");
    await writeFile(path.join(project, 'back.mjs'), "import { appendFileSync } from 'node:fs'; appendFileSync('back.runs', 'run\\n');\n");
    await configureTreeContent(project, [
      { id: 'front', command: 'node front.mjs', deterministic: true, cacheScope: 'tree' },
      { id: 'back', command: 'node back.mjs', deterministic: false, cacheScope: 'tree' },
    ]);
    await execute('git', ['init', '--quiet'], { cwd: project });
    await execute('git', ['add', '.'], { cwd: project });
    await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'fixture'], { cwd: project });
    const first = await runCommand(['verify', '--project', project, '--reuse']);
    assert.equal(first.report.status, 'passed', JSON.stringify(first.report));
    const second = await runCommand(['verify', '--project', project, '--reuse']);
    assert.equal(second.report.cache.status, 'partial', JSON.stringify(second.report.cache));
    assert.equal(second.report.checks.front.status, 'reused');
    assert.equal(second.report.checks.back.status, 'passed');
    assert.equal(await readFile(path.join(project, 'front.runs'), 'utf8'), 'run\n');
    assert.equal(await readFile(path.join(project, 'back.runs'), 'utf8'), 'run\nrun\n');
  });
});

test('非确定性检查失败不阻止已通过的确定性检查写入逐检查缓存', async () => {
  await fixture(async (project) => {
    await writeFile(path.join(project, '.gitignore'), '.vibe-harness/\nfront.runs\nback.runs\nback.fail\n');
    await writeFile(path.join(project, 'front.mjs'), "import { appendFileSync } from 'node:fs'; appendFileSync('front.runs', 'run\\n');\n");
    await writeFile(path.join(project, 'back.mjs'), [
      "import { appendFileSync, existsSync } from 'node:fs';",
      "appendFileSync('back.runs', 'run\\n');",
      "if (existsSync('back.fail')) process.exit(1);",
      '',
    ].join('\n'));
    await configureTreeContent(project, [
      { id: 'front', command: 'node front.mjs', deterministic: true, cacheScope: 'tree' },
      { id: 'back', command: 'node back.mjs', deterministic: false, cacheScope: 'tree' },
    ]);
    await execute('git', ['init', '--quiet'], { cwd: project });
    await execute('git', ['add', '.'], { cwd: project });
    await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'fixture'], { cwd: project });
    // The marker is ignored, so failing the back check changes neither the
    // committed tree nor the tree-content fingerprint.
    await writeFile(path.join(project, 'back.fail'), '1\n');
    const first = await runCommand(['verify', '--project', project, '--reuse']);
    assert.equal(first.report.status, 'failed', JSON.stringify(first.report));
    assert.equal(first.report.cache.status, 'miss');
    assert.deepEqual(
      first.report.cache.checkReceipts.find((item) => item.id === 'front'),
      { id: 'front', stored: true },
      JSON.stringify(first.report.cache.checkReceipts),
    );
    assert.equal(first.report.cache.checks.front.status, 'miss');
    assert.match(first.report.cache.checks.back.reason, /not-explicitly-deterministic/u);
    assert.equal(await readFile(path.join(project, 'front.runs'), 'utf8'), 'run\n');

    await rm(path.join(project, 'back.fail'));
    const second = await runCommand(['verify', '--project', project, '--reuse']);
    assert.equal(second.report.status, 'passed', JSON.stringify(second.report));
    assert.equal(second.report.cache.status, 'partial', JSON.stringify(second.report.cache));
    assert.equal(second.report.checks.front.status, 'reused');
    assert.equal(second.report.checks.back.status, 'passed');
    assert.equal(await readFile(path.join(project, 'front.runs'), 'utf8'), 'run\n');
    assert.equal(await readFile(path.join(project, 'back.runs'), 'utf8'), 'run\nrun\n');
  });
});

test('tree-content 旧 allowlist 不能隐藏仍传给检查的环境变化', async () => {
  await fixture(async (project) => {
    await writeFile(path.join(project, '.gitignore'), '.vibe-harness/\nruns.txt\n');
    await writeFile(path.join(project, 'check.mjs'), "import { appendFileSync } from 'node:fs'; appendFileSync('runs.txt', 'run\\n');\n");
    await configureTreeContent(project, [{ id: 'test', command: 'node check.mjs', deterministic: true, cacheScope: 'tree' }]);
    await execute('git', ['init', '--quiet'], { cwd: project });
    await execute('git', ['add', '.'], { cwd: project });
    await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'fixture'], { cwd: project });
    const previousAllowed = process.env.VIBE_TEST_ALLOWED;
    const previousOther = process.env.VIBE_TEST_OTHER;
    try {
      process.env.VIBE_TEST_ALLOWED = 'one';
      process.env.VIBE_TEST_OTHER = 'alpha';
      const first = await runCommand(['verify', '--project', project]);
      assert.equal(first.report.status, 'passed', JSON.stringify(first.report));
      process.env.VIBE_TEST_OTHER = 'beta';
      const ignored = await runCommand(['verify', '--project', project, '--reuse']);
      assert.equal(ignored.report.status, 'passed', JSON.stringify(ignored.report));
      process.env.VIBE_TEST_ALLOWED = 'two';
      const allowed = await runCommand(['verify', '--project', project, '--reuse']);
      assert.equal(allowed.report.status, 'passed', JSON.stringify(allowed.report));
      assert.equal(await readFile(path.join(project, 'runs.txt'), 'utf8'), 'run\nrun\nrun\n');
    } finally {
      if (previousAllowed === undefined) delete process.env.VIBE_TEST_ALLOWED;
      else process.env.VIBE_TEST_ALLOWED = previousAllowed;
      if (previousOther === undefined) delete process.env.VIBE_TEST_OTHER;
      else process.env.VIBE_TEST_OTHER = previousOther;
    }
  });
});

test('selection scope 的 base 变化不会跨基线复用检查收据', async () => {
  await fixture(async (project) => {
    await writeFile(path.join(project, 'check.mjs'), 'process.exit(0);\n');
    await configureTreeContent(project, [{ id: 'selected', command: 'node check.mjs', deterministic: true, cacheScope: 'selection' }]);
    await execute('git', ['init', '--quiet'], { cwd: project });
    await execute('git', ['add', '.'], { cwd: project });
    await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'fixture'], { cwd: project });
    const head = (await execute('git', ['rev-parse', 'HEAD'], { cwd: project })).stdout.trim();
    const base = { selectedChecks: [{ id: 'selected', command: 'node check.mjs', cwd: '.', costTier: 'quick', deterministic: true, cacheScope: 'selection' }], tier: 'quick', scope: 'affected' };
    const first = await verificationCacheContext(project, { ...base, baseSha: head, changedPaths: ['src/a.js'] });
    const storedContext = first.perCheck[0];
    assert.equal(storedContext.available, true, JSON.stringify(first));
    assert.equal(await storeVerificationCheckReceipt(project, storedContext), true);
    assert.equal((await findVerificationCheckReceipt(project, storedContext)).status, 'hit');
    const otherBase = await verificationCacheContext(project, { ...base, baseSha: head, changedPaths: ['src/b.js'] });
    assert.equal((await findVerificationCheckReceipt(project, otherBase.perCheck[0])).status, 'miss');
  });
});

test('被篡改的第 6 版检查收据按 miss 处理', async () => {
  await fixture(async (project) => {
    await writeFile(path.join(project, '.gitignore'), '.vibe-harness/\n');
    await writeFile(path.join(project, 'check.mjs'), 'process.exit(0);\n');
    await configureTreeContent(project, [{ id: 'test', command: 'node check.mjs', deterministic: true, cacheScope: 'tree' }]);
    await execute('git', ['init', '--quiet'], { cwd: project });
    await execute('git', ['add', '.'], { cwd: project });
    await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'fixture'], { cwd: project });
    const first = await runCommand(['verify', '--project', project]);
    assert.equal(first.report.status, 'passed', JSON.stringify(first.report));
    const common = (await execute('git', ['rev-parse', '--git-common-dir'], { cwd: project })).stdout.trim();
    const directory = path.join(project, common, 'vibe-harness', 'verification-cache', `v${VERIFICATION_RECEIPT_SCHEMA_VERSION}`);
    const [name] = (await readdir(directory)).filter((file) => file.endsWith('.json'));
    const file = path.join(directory, name);
    const record = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...record, status: 'failed' }));
    const second = await runCommand(['verify', '--project', project, '--reuse']);
    assert.equal(second.report.status, 'passed');
    assert.equal(second.report.cache.status, 'miss');
  });
});

test('旧版检查收据不会被自动复用', async () => {
  await fixture(async (project) => {
    await writeFile(path.join(project, '.gitignore'), '.vibe-harness/\nruns.txt\n');
    await writeFile(path.join(project, 'check.mjs'), "import { appendFileSync } from 'node:fs'; appendFileSync('runs.txt', 'run\\n');\n");
    await configureTreeContent(project, [{ id: 'test', command: 'node check.mjs', deterministic: true, cacheScope: 'tree' }]);
    await execute('git', ['init', '--quiet'], { cwd: project });
    await execute('git', ['add', '.'], { cwd: project });
    await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'fixture'], { cwd: project });
    const first = await runCommand(['verify', '--project', project]);
    assert.equal(first.report.status, 'passed', JSON.stringify(first.report));
    const directory = await checkCacheDirectory(project);
    const [name] = (await readdir(directory)).filter((file) => file.endsWith('.json'));
    const file = path.join(directory, name);
    const record = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...record, schemaVersion: 4 }));
    const second = await runCommand(['verify', '--project', project, '--reuse']);
    assert.equal(second.report.status, 'passed', JSON.stringify(second.report));
    assert.equal(second.report.cache.status, 'miss');
    assert.equal(await readFile(path.join(project, 'runs.txt'), 'utf8'), 'run\nrun\n');
  });
});

test('检查收据缓存目录是符号链接时按 miss 处理', async () => {
  await fixture(async (project) => {
    await writeFile(path.join(project, '.gitignore'), '.vibe-harness/\nruns.txt\n');
    await writeFile(path.join(project, 'check.mjs'), "import { appendFileSync } from 'node:fs'; appendFileSync('runs.txt', 'run\\n');\n");
    await configureTreeContent(project, [{ id: 'test', command: 'node check.mjs', deterministic: true, cacheScope: 'tree' }]);
    await execute('git', ['init', '--quiet'], { cwd: project });
    await execute('git', ['add', '.'], { cwd: project });
    await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'fixture'], { cwd: project });
    const first = await runCommand(['verify', '--project', project]);
    assert.equal(first.report.status, 'passed', JSON.stringify(first.report));
    const directory = await checkCacheDirectory(project);
    const outside = await mkdtemp(path.join(tmpdir(), 'verification-cache-outside-'));
    try {
      await rm(directory, { recursive: true, force: true });
      await symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
      const second = await runCommand(['verify', '--project', project, '--reuse']);
      assert.equal(second.report.status, 'passed', JSON.stringify(second.report));
      assert.equal(second.report.cache.status, 'miss');
      assert.equal(await readFile(path.join(project, 'runs.txt'), 'utf8'), 'run\nrun\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test('检查收据不可读时按 miss 处理', async () => {
  await fixture(async (project) => {
    await writeFile(path.join(project, '.gitignore'), '.vibe-harness/\nruns.txt\n');
    await writeFile(path.join(project, 'check.mjs'), "import { appendFileSync } from 'node:fs'; appendFileSync('runs.txt', 'run\\n');\n");
    await configureTreeContent(project, [{ id: 'test', command: 'node check.mjs', deterministic: true, cacheScope: 'tree' }]);
    await execute('git', ['init', '--quiet'], { cwd: project });
    await execute('git', ['add', '.'], { cwd: project });
    await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'fixture'], { cwd: project });
    const first = await runCommand(['verify', '--project', project]);
    assert.equal(first.report.status, 'passed', JSON.stringify(first.report));
    const directory = await checkCacheDirectory(project);
    const [name] = (await readdir(directory)).filter((file) => file.endsWith('.json'));
    const file = path.join(directory, name);
    await rm(file, { force: true });
    await mkdir(file);
    const second = await runCommand(['verify', '--project', project, '--reuse']);
    assert.equal(second.report.status, 'passed', JSON.stringify(second.report));
    assert.equal(second.report.cache.status, 'miss');
    assert.equal(await readFile(path.join(project, 'runs.txt'), 'utf8'), 'run\nrun\n');
  });
});

test('过期检查收据在 lookup 时被清理并判为 miss', async () => {
  await fixture(async (project) => {
    await writeFile(path.join(project, 'check.mjs'), 'process.exit(0);\n');
    await configureTreeContent(project, [{ id: 'test', command: 'node check.mjs', deterministic: true, cacheScope: 'tree' }]);
    await execute('git', ['init', '--quiet'], { cwd: project });
    await execute('git', ['add', '.'], { cwd: project });
    await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'fixture'], { cwd: project });
    const head = (await execute('git', ['rev-parse', 'HEAD'], { cwd: project })).stdout.trim();
    const plan = {
      selectedChecks: [{ id: 'test', command: 'node check.mjs', cwd: '.', costTier: 'quick', deterministic: true, cacheScope: 'tree' }],
      tier: 'quick', scope: 'affected', baseSha: head, changedPaths: [],
    };
    const context = await verificationCacheContext(project, plan);
    const check = context.perCheck[0];
    assert.equal(await storeVerificationCheckReceipt(project, check), true);
    const file = path.join(await checkCacheDirectory(project), `${check.key}.json`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const expired = await findVerificationCheckReceipt(project, check, { ttlMs: 1 });
    assert.equal(expired.status, 'miss');
    assert.equal(expired.reason, 'check-receipt-expired');
    await assert.rejects(readFile(file));
  });
});

test('未声明确定性的普通验证不复用且仍可显式要求重跑', async () => {
  await fixture(async (project) => {
    await reusableFixture(project, false);
    await runCommand(['verify', '--project', project]);
    const second = await runCommand(['verify', '--project', project, '--reuse']);
    assert.equal(second.report.status, 'passed');
    assert.equal(await readFile(path.join(project, 'runs.txt'), 'utf8'), 'run\nrun\n');
    const forced = await runCommand(['verify', '--project', project, '--no-reuse']);
    assert.equal(forced.report.status, 'passed');
    assert.equal(await readFile(path.join(project, 'runs.txt'), 'utf8'), 'run\nrun\nrun\n');
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
    assert.equal(result.report.status, 'stale');
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
    const failure = await runCommand(['verify', '--project', project, '--no-reuse']);
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

test('聚焦入口与两种引擎共享部分配置的显式成本归属', async () => {
  await fixture(async (project) => {
    await writeFile(path.join(project, 'package.json'), JSON.stringify({
      packageManager: 'pnpm@10.33.0',
      scripts: { 'test:unit': 'node --test', 'test:component': 'node --test' },
    }));
    const config = {
      validationCommands: { tiers: { standard: ['pnpm test:component'] } },
      projectRules: { mode: 'off' },
    };
    await writeFile(path.join(project, 'vibe-harness.config.json'), JSON.stringify(config));
    const profile = await detectProjectProfile({ config, targetDir: project });
    const focused = await buildVerificationPlan({ config, targetDir: project, changedPaths: ['scripts/helper.js'] });
    const cli = selectTierChecks({ tier: 'quick', tiers: profile.validationTiers, projectDir: project });
    const runtime = await runCommand(['verify', '--project', project, '--tier', 'quick', '--plan']);
    assert.equal(runtime.exitCode, 0);
    const component = focused.selectedChecks.find((check) => check.id === 'component');
    assert.equal(component.costTier, 'standard');
    assert.equal(cli.deferredChecks.find((check) => check.command === component.command).costTier, component.costTier);
    assert.equal(runtime.report.deferredChecks.find((check) => check.command === component.command).tier, component.costTier);
    assert.deepEqual(runtime.report.selectedChecks.map((id) => runtime.report.checks[id].command), ['pnpm test:unit']);
  });
});

test('identical deterministic executions coalesce, but --no-reuse still executes', async () => {
  await fixture(async (project) => {
    await writeFile(path.join(project, '.gitignore'), '.vibe-harness/\nruns.txt\n');
    await writeFile(path.join(project, 'check.mjs'),
      "import { appendFileSync } from 'node:fs'; appendFileSync('runs.txt', 'run\\n'); await new Promise(r => setTimeout(r, 500));\n");
    await configureTreeContent(project, [{ id: 'test', command: 'node check.mjs', deterministic: true, cacheScope: 'tree' }]);
    await commitFixture(project);
    const runs = await Promise.all([runCommand(['verify', '--project', project]), runCommand(['verify', '--project', project])]);
    assert.deepEqual(runs.map((run) => run.report.status).sort(), ['passed', 'reused']);
    assert.equal(await readFile(path.join(project, 'runs.txt'), 'utf8'), 'run\n');
    for (const run of runs) {
      assert.ok(run.report.timingsMs.total > 0);
      assert.ok(run.report.dependencyScan.before.files >= 0);
    }
    await runCommand(['verify', '--project', project, '--no-reuse']);
    assert.equal(await readFile(path.join(project, 'runs.txt'), 'utf8'), 'run\nrun\n');
  });
});

test('环境预检非零退出在两个引擎保持 blocked，跳过标记不能掩盖失败', async () => {
  await fixture(async (project) => {
    const tiers = { quick: ['node check.mjs'], standard: [], deep: [] };
    await configure(project, { tiers });
    for (const status of ['blocked', 'not_applicable']) {
      await writeFile(path.join(project, 'check.mjs'),
        `console.log('[VIBE_HARNESS_CHECK] {"status":"${status}","reason":"preflight"}'); process.exit(2);\n`);
      const runtime = await runCommand(['verify', '--project', project, '--no-reuse']);
      const cli = await runVerificationPlan({
        targetDir: project, plan: selectTierChecks({ tier: 'quick', tiers, projectDir: project }),
      });
      const expected = status === 'blocked' ? 'blocked' : 'failed';
      assert.equal(runtime.report.status, expected);
      assert.equal(cli.results['check-mjs'].status, expected);
      assert.equal(cli.ok, false);
    }
  });
});

test('bounded parallel checks overlap only with explicit opt-in and disjoint resources', async () => {
  await fixture(async (project) => {
    await writeFile(path.join(project, '.gitignore'), '.vibe-harness/\nevents.txt\n');
    await writeFile(path.join(project, 'check.mjs'),
      "import { appendFileSync } from 'node:fs'; const id = process.argv[2]; appendFileSync('events.txt', `${id}:start\\n`); await new Promise(r => setTimeout(r, 300)); appendFileSync('events.txt', `${id}:end\\n`);\n");
    const checks = ['a', 'b'].map((id) => ({ id, command: `node check.mjs ${id}`, parallel: true,
      resources: [`resource-${id}`], deterministic: false }));
    const config = { validationCommands: { tiers: { quick: checks.map((check) => check.command), standard: [], deep: [] }, checks },
      verification: { timeoutMs: 30000, maxConcurrency: 2 } };
    await writeFile(path.join(project, 'vibe-harness.config.json'), JSON.stringify(config));
    await commitFixture(project);
    const first = await runCommand(['verify', '--project', project, '--no-reuse']);
    assert.equal(first.report.status, 'passed', JSON.stringify(first.report));
    let events = (await readFile(path.join(project, 'events.txt'), 'utf8')).trim().split('\n');
    assert.ok(events[0].endsWith(':start') && events[1].endsWith(':start'), events.join(','));
    await writeFile(path.join(project, 'events.txt'), '');
    config.validationCommands.checks[1].resources = ['resource-a'];
    await writeFile(path.join(project, 'vibe-harness.config.json'), JSON.stringify(config));
    const second = await runCommand(['verify', '--project', project, '--no-reuse']);
    assert.equal(second.report.status, 'passed');
    events = (await readFile(path.join(project, 'events.txt'), 'utf8')).trim().split('\n');
    assert.deepEqual(events.map((event) => event.split(':')[1]), ['start', 'end', 'start', 'end']);
    await writeFile(path.join(project, 'events.txt'), '');
    config.validationCommands.checks[1].resources = ['resource-b'];
    config.validationCommands.checks[1].parallel = false;
    await writeFile(path.join(project, 'vibe-harness.config.json'), JSON.stringify(config));
    assert.equal((await runCommand(['verify', '--project', project, '--no-reuse'])).report.status, 'passed');
    events = (await readFile(path.join(project, 'events.txt'), 'utf8')).trim().split('\n');
    assert.deepEqual(events.map((event) => event.split(':')[1]), ['start', 'end', 'start', 'end']);
    await writeFile(path.join(project, 'events.txt'), '');
    config.validationCommands.checks[1].parallel = true;
    await writeFile(path.join(project, 'vibe-harness.config.json'), JSON.stringify(config));
    const cli = await runVerificationPlan({ targetDir: project, plan: { selectedChecks: checks,
      deferredChecks: [], changedPaths: [], scope: 'layer', executionTier: 'quick' } });
    assert.equal(cli.ok, true, JSON.stringify(cli));
    events = (await readFile(path.join(project, 'events.txt'), 'utf8')).trim().split('\n');
    assert.ok(events[0].endsWith(':start') && events[1].endsWith(':start'), events.join(','));
  });
});

test('运行时支持 full 且与 CLI 共享风险、范围和最低证据元数据', async () => {
  await fixture(async (project) => {
    const tiers = { quick: ['node quick.mjs'], standard: ['node contract.mjs'], deep: ['node matrix.mjs'] };
    const config = { validationCommands: { tiers } };
    await configure(project, config.validationCommands);
    for (const changedPaths of [['schemas/project-config.schema.json'], ['README.md'], ['unknown.bin'], []]) {
      const cli = await buildVerificationPlan({ config, tiers, targetDir: project, changedPaths, tier: 'quick' });
      const runtime = await verifyProject(project, { paths: changedPaths }, { planOnly: true });
      for (const field of ['riskLevel', 'impactGroups', 'scopeConfidence', 'minimumTier']) {
        assert.deepEqual(runtime[field], cli[field], `${field}: ${changedPaths.join(',')}`);
      }
    }
    const full = await runCommand(['verify', '--project', project, '--full', '--plan']);
    assert.equal(full.exitCode, 0, JSON.stringify(full.report));
    assert.deepEqual(full.report.selectedChecks.map((id) => full.report.checks[id].command), Object.values(tiers).flat());
    assert.equal((await runCommand(['verify', '--project', project, '--full', '--tier', 'quick', '--plan'])).report.code, 'FULL_FLAGS_CONFLICT');
  });
});
