import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildVerificationPlan, classifyVerificationRisk } from '../../scripts/lib/verification-plan.js';

const scripts = {
  check: 'node ./scripts/lint.js && node ./scripts/validate.js && pnpm test:unit && pnpm test:component',
  lint: 'node ./scripts/lint.js',
  typecheck: 'tsc -p jsconfig.json',
  validate: 'node ./scripts/validate.js',
  'test:unit': 'node --test',
  'test:component': 'node --test',
  'eval:check': 'node ./scripts/eval-check.js',
  'eval:replay': 'node ./scripts/eval-replay.js',
  'test:integration': 'node --test tests/integration.test.js',
  'test:e2e': 'node --test tests/e2e.test.js',
  'test:matrix': 'node --test tests/matrix.test.js',
  'smoke:lifecycle': 'node ./scripts/smoke-lifecycles.js',
  'docs:audit': 'node ./scripts/docs-audit.js',
  'skills:audit': 'node ./scripts/skills-audit.js',
};

async function targetWithScripts() {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-plan-'));
  await writeFile(path.join(target, 'package.json'), JSON.stringify({ scripts }) + '\n', 'utf8');
  return target;
}

test('verification risk classifier selects quick, standard, and high safely', () => {
  assert.equal(classifyVerificationRisk(['README.md']).riskLevel, 'quick');
  assert.equal(classifyVerificationRisk(['tests/example.test.js']).riskLevel, 'quick');
  assert.equal(classifyVerificationRisk(['src/example.js']).riskLevel, 'standard');
  assert.equal(classifyVerificationRisk(['schemas/example.json']).riskLevel, 'high');
  const unknown = classifyVerificationRisk(['misc/example.bin']);
  assert.equal(unknown.riskLevel, 'high');
  assert.equal(unknown.fallbackUsed, true);
});

test('planner exposes minimum tier, Micro selection, and escalation contract', async () => {
  const target = await targetWithScripts();
  try {
    const plan = await buildVerificationPlan({
      changedPaths: ['src/config.js'],
      config: {
        validationCommands: {
          micro: [{ id: 'config-probe', kind: 'pure', entry: 'scripts/probes/config.mjs', scopes: ['affected'] }],
        },
        verification: { defaultScope: 'affected' },
      },
      targetDir: target,
      scope: 'affected',
      covers: { 'tests/unit/config.test.js': ['src/config.js'] },
    });
    assert.equal(plan.minimumTier, 'unit');
    assert.ok(Array.isArray(plan.selectedMicroChecks));
    assert.ok(Array.isArray(plan.deferredMicroChecks));
    assert.equal(typeof plan.escalation.required, 'boolean');
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test('an unknown path cannot lower the risk selected for a mixed change', () => {
  const plan = classifyVerificationRisk(['scripts/example.js', 'misc/example.bin']);
  assert.equal(plan.riskLevel, 'high');
  assert.equal(plan.fallbackUsed, true);
});

test('仓库根实际文件在分组规则中永不为 unknown', async () => {
  const rootDir = path.resolve(import.meta.dirname, '../..');
  const entries = await readdir(rootDir, { withFileTypes: true });
  // `.git` is VCS metadata (a file in worktrees, a directory elsewhere) that git
  // never reports as a changed path, so it is not a repository file here.
  const files = entries
    .filter((entry) => entry.isFile() && entry.name !== '.git')
    .map((entry) => entry.name);
  assert.ok(files.length > 0);
  for (const file of files) {
    const report = classifyVerificationRisk([file]);
    assert.equal(report.fallbackUsed, false, `${file} must match a GROUP_RULES entry`);
    assert.ok(!report.impactGroups.includes('unknown'), file);
  }
});

test('riskZones and pathPatterns raise risk and preserve the reason in the plan', async () => {
  const target = await targetWithScripts();
  try {
    const red = await buildVerificationPlan({
      changedPaths: ['src/auth/client.js'],
      config: { riskZones: { red: ['auth'] } },
      targetDir: target,
    });
    assert.equal(red.riskLevel, 'high');
    assert.ok(red.selectionReasons.some((reason) => reason.includes('riskZones.red')));

    const yellow = classifyVerificationRisk(['src/state/store.js'], {
      riskZones: { pathPatterns: { yellow: ['src/**'] } },
    });
    assert.equal(yellow.riskLevel, 'standard');
    assert.equal(yellow.configuredZones.yellow, true);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('documentation, tests, and ordinary scripts stay below integration and smoke', async () => {
  const target = await targetWithScripts();
  try {
    const docs = await buildVerificationPlan({ changedPaths: ['README.md'], targetDir: target });
    assert.deepEqual(docs.selectedChecks.map((item) => item.id), ['docs']);

    const unit = await buildVerificationPlan({ changedPaths: ['tests/example.test.js'], targetDir: target });
    assert.deepEqual(unit.selectedChecks.map((item) => item.id), ['test', 'component']);
    assert.equal(unit.selectedChecks.some((item) => ['integration', 'smoke'].includes(item.id)), false);

    const script = await buildVerificationPlan({ changedPaths: ['scripts/lib/other.js'], targetDir: target });
    assert.deepEqual(script.selectedChecks.map((item) => item.id), ['test', 'component']);
    assert.equal(script.selectedChecks.some((item) => ['integration', 'smoke'].includes(item.id)), false);

    const rules = await buildVerificationPlan({ changedPaths: ['docs/rules/test-rules.md'], targetDir: target });
    assert.equal(rules.impactGroups.includes('rules'), true);
    assert.deepEqual(rules.selectedChecks.map((item) => item.id), ['test', 'component', 'eval-check']);

    const skill = await buildVerificationPlan({ changedPaths: ['.agents/skills/example/SKILL.md'], targetDir: target });
    assert.equal(skill.riskLevel, 'standard');
    assert.equal(skill.impactGroups.includes('skills'), true);
    assert.equal(skill.selectedChecks.some((item) => ['integration', 'smoke'].includes(item.id)), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('high risk defers deep evidence while lifecycle changes keep smoke synchronous', async () => {
  const target = await targetWithScripts();
  try {
    // install-planner.js is high risk AND on the lifecycle surface, so smoke
    // stays synchronous and only eval moves to the deferred deep evidence.
    const lifecycle = await buildVerificationPlan({ changedPaths: ['scripts/lib/install-planner.js'], targetDir: target });
    assert.deepEqual(lifecycle.selectedChecks.map((item) => item.id), [
      'validate', 'lint', 'typecheck', 'test', 'component', 'integration', 'smoke',
    ]);
    assert.equal(lifecycle.selectedChecks.some((item) => item.id === 'eval'), false);
    assert.deepEqual(lifecycle.deferredChecks.map((item) => item.id), ['eval']);
    assert.equal(new Set(lifecycle.selectedChecks.map((item) => item.command)).size, lifecycle.selectedChecks.length);

    // A high-risk path outside the lifecycle surface defers both deep checks.
    const plain = await buildVerificationPlan({ changedPaths: ['schemas/example.json'], targetDir: target });
    assert.deepEqual(plain.selectedChecks.map((item) => item.id), [
      'validate', 'lint', 'typecheck', 'test', 'component', 'integration',
    ]);
    assert.deepEqual(plain.deferredChecks.map((item) => item.id), ['eval', 'smoke']);
    assert.ok(plain.deferredChecks.every((item) => item.costTier === 'deep' && item.blockingScope && item.command));

    // The unknown fallback stays fail-safe: the whole matrix stays synchronous.
    const unknown = await buildVerificationPlan({ changedPaths: ['misc/example.bin'], targetDir: target });
    assert.equal(unknown.riskLevel, 'high');
    assert.equal(unknown.fallbackUsed, true);
    assert.ok(unknown.selectedChecks.some((item) => item.id === 'eval'));
    assert.ok(unknown.selectedChecks.some((item) => item.id === 'integration'));
    assert.ok(unknown.selectedChecks.some((item) => item.id === 'smoke'));
    assert.deepEqual(unknown.deferredChecks, []);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('comment-only source changes remain quick when the diff supplies content evidence', () => {
  const risk = classifyVerificationRisk(['src/example.js'], {
    changedDetails: [{ commentsOnly: true }],
  });
  assert.equal(risk.riskLevel, 'quick');
  assert.equal(risk.commentsOnly, true);
});

test('governance notes and delivery audits stay out of the full verification matrix', () => {
  for (const changedPath of [
    '.agents/memory/CURRENT.md',
    'audit-reports/2026-09-14-review.md',
    '.github/SECURITY.md',
    '.github/ISSUE_TEMPLATE/bug_report.yml',
  ]) {
    const risk = classifyVerificationRisk([changedPath]);
    assert.equal(risk.riskLevel, 'quick', `${changedPath} must not escalate to the full matrix`);
    assert.equal(risk.fallbackUsed, false, `${changedPath} must not fall back to unknown`);
    assert.equal(risk.impactGroups.includes('docs'), true);
  }
  const workflows = classifyVerificationRisk(['.github/workflows/ci.yml']);
  assert.equal(workflows.riskLevel, 'high');
  assert.equal(workflows.impactGroups.includes('workflows'), true);
  const installedEvalMirror = classifyVerificationRisk(['.agents/evals/references/vibe-harness-core.offline.json']);
  assert.equal(installedEvalMirror.impactGroups.includes('eval'), true);
  assert.equal(installedEvalMirror.fallbackUsed, false);
});

test('configured zone names match whole path parts instead of substrings', () => {
  const riskZones = { red: ['env', 'secrets'], yellow: ['shared-libs'] };
  // `env` must not match `envelope.js`: the previous compact-substring match
  // raised the risk of the repository's own governance tooling to red.
  for (const changedPath of ['scripts/envelope.js', 'scripts/lib/envelope-records.js']) {
    const risk = classifyVerificationRisk([changedPath], { riskZones });
    assert.equal(risk.configuredZones.red, false, `${changedPath} must not be treated as red zone`);
    assert.equal(risk.riskLevel, 'standard');
  }
  for (const changedPath of ['.env', 'secrets-manager.js', 'config/secrets/client.js', 'shared-libs/index.js']) {
    const risk = classifyVerificationRisk([changedPath], { riskZones });
    assert.equal(
      risk.configuredZones.red || risk.configuredZones.yellow,
      true,
      `${changedPath} must still match its configured zone`,
    );
  }
});

test('成本层缺省解析为快速层而 --full 保留完整矩阵', async () => {
  const target = await targetWithScripts();
  const tiers = {
    quick: ['pnpm lint', 'pnpm test:unit'],
    standard: ['pnpm test:integration'],
    deep: ['pnpm test:e2e'],
  };
  try {
    const fast = await buildVerificationPlan({
      changedPaths: ['docs/rules/test-rules.md'],
      targetDir: target,
      tier: 'quick',
      tiers,
    });
    assert.equal(fast.planMode, 'tier:quick');
    assert.equal(fast.executionTier, 'quick');
    assert.equal(fast.nextTier, 'standard');
    assert.deepEqual(fast.selectedChecks.map((item) => item.command), ['pnpm lint', 'pnpm test:unit']);
    assert.deepEqual(fast.deferredChecks.map((item) => item.costTier), ['standard', 'deep']);
    assert.equal(fast.tierFallback, null);

    // The risk plan must not smuggle a deferred command into a fast run.
    assert.equal(fast.selectedChecks.some((item) => ['integration', 'e2e'].includes(item.costTier)), false);

    const full = await buildVerificationPlan({
      changedPaths: ['docs/rules/test-rules.md'],
      full: true,
      targetDir: target,
      tier: 'deep',
      tiers,
    });
    assert.equal(full.planMode, 'full');
    assert.deepEqual(full.deferredChecks, []);
    const commands = full.selectedChecks.map((item) => item.command);
    for (const expected of ['pnpm lint', 'pnpm test:unit', 'pnpm test:integration', 'pnpm test:e2e']) {
      assert.equal(commands.includes(expected), true, `--full must include ${expected}`);
    }
    assert.equal(new Set(commands).size, commands.length);

    const undeclared = await buildVerificationPlan({
      changedPaths: ['docs/rules/test-rules.md'],
      targetDir: target,
      tier: 'quick',
      tiers: { quick: [], standard: [], deep: [] },
    });
    assert.equal(undeclared.planMode, 'auto');
    assert.equal(undeclared.executionTier, null);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('被覆盖映射完整归因的脚本变更收窄为文件级测试命令', async () => {
  const target = await targetWithScripts();
  try {
    const plan = await buildVerificationPlan({
      changedPaths: ['scripts/lib/helper.js'],
      targetDir: target,
      covers: { 'tests/unit/alpha.test.js': ['scripts/lib/helper.js'] },
    });
    const test = plan.selectedChecks.find((item) => item.id === 'test');
    const component = plan.selectedChecks.find((item) => item.id === 'component');
    assert.equal(test.command, 'node --test tests/unit/alpha.test.js');
    assert.ok(test.reason.includes('文件级聚焦'));
    // 没有归因的层保持完整层级命令，不凭空构造聚焦。
    assert.equal(component.command, 'pnpm test:component');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('覆盖映射未归因的源文件变更阻止收窄并回退整层', async () => {
  const target = await targetWithScripts();
  try {
    const plan = await buildVerificationPlan({
      changedPaths: ['scripts/lib/helper.js', 'docs/guide.md'],
      targetDir: target,
      covers: { 'tests/unit/alpha.test.js': ['scripts/lib/helper.js'] },
    });
    const test = plan.selectedChecks.find((item) => item.id === 'test');
    assert.equal(test.command, 'pnpm test:unit');
    assert.equal(test.command.includes('alpha.test.js'), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('变更自身的测试文件直接入选聚焦命令', async () => {
  const target = await targetWithScripts();
  try {
    const plan = await buildVerificationPlan({
      changedPaths: ['tests/unit/beta.test.js'],
      targetDir: target,
      covers: { 'tests/unit/alpha.test.js': [], 'tests/unit/beta.test.js': [] },
    });
    const test = plan.selectedChecks.find((item) => item.id === 'test');
    const component = plan.selectedChecks.find((item) => item.id === 'component');
    assert.equal(test.command, 'node --test tests/unit/beta.test.js');
    assert.equal(component.command, 'pnpm test:component');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('tier 计划不收窄测试命令以保持层命令同一性', async () => {
  const target = await targetWithScripts();
  try {
    const plan = await buildVerificationPlan({
      changedPaths: ['scripts/lib/helper.js'],
      targetDir: target,
      tier: 'quick',
      tiers: { quick: ['pnpm test:unit'], standard: [], deep: [] },
      covers: { 'tests/unit/alpha.test.js': ['scripts/lib/helper.js'] },
    });
    assert.deepEqual(plan.selectedChecks.map((item) => item.command), ['pnpm test:unit']);
    assert.equal(plan.selectedChecks.some((item) => item.command.includes('alpha.test.js')), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
