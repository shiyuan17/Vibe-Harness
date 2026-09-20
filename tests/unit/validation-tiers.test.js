import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_VALIDATION_TIER,
  cheapestNonEmptyTier,
  deriveValidationTiers,
  emptyValidationTiers,
  nextNonEmptyTier,
  normalizeTierOption,
  normalizeValidationTiers,
  planValidationTierMigration,
  readProjectTierFacts,
  resolveExecutionTier,
  resolveValidationTiers,
  selectTierChecks,
} from '../../scripts/lib/validation-tiers.js';

async function projectFixture(files) {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tiers-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(target, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf8');
  }
  return target;
}

test('成本层推导把已声明的包脚本映射到三个层', () => {
  const { tiers } = deriveValidationTiers({
    packageManager: 'pnpm',
    scripts: {
      lint: 'oxlint .',
      'check:type': 'vue-tsc --noEmit',
      'test:unit': 'vitest run',
      'test:component': 'vitest run --dir tests/component',
      'test:integration': 'vitest run --dir tests/integration',
      'test:e2e': 'playwright test',
      'test:matrix': 'node ./scripts/matrix.mjs',
      unknown: 'node ./scripts/unknown.mjs',
    },
  });

  assert.deepEqual(tiers.quick, ['pnpm lint', 'pnpm check:type', 'pnpm test:unit', 'pnpm test:component']);
  assert.deepEqual(tiers.standard, ['pnpm test:integration']);
  assert.deepEqual(tiers.deep, ['pnpm test:e2e', 'pnpm test:matrix']);
});

test('成本层推导保持声明顺序并丢弃未知脚本名', () => {
  const { tiers } = deriveValidationTiers({
    packageManager: 'npm',
    scripts: {
      'test:api': 'node ./scripts/api.mjs',
      'test:contract': 'node ./scripts/contract.mjs',
      'smoke:release': 'node ./scripts/smoke.mjs',
      deploy: 'node ./scripts/deploy.mjs',
    },
  });

  assert.deepEqual(tiers.quick, []);
  assert.deepEqual(tiers.standard, ['npm run test:contract', 'npm run test:api']);
  assert.deepEqual(tiers.deep, ['npm run smoke:release']);
});

test('已配置命令先于脚本推导落入对应成本层', () => {
  const { tiers } = deriveValidationTiers({
    configuredCommands: { lint: 'pnpm lint:ci', eval: 'pnpm eval:replay', test: null, typecheck: null },
    packageManager: 'pnpm',
    scripts: { 'test:unit': 'vitest run' },
  });

  assert.deepEqual(tiers.quick, ['pnpm lint:ci', 'pnpm test:unit']);
  assert.deepEqual(tiers.deep, ['pnpm eval:replay']);
});

test('Maven 与 .NET 只从固定入口推导成本层', () => {
  const maven = deriveValidationTiers({ packageManager: 'Maven', stacks: { maven: true } });
  assert.deepEqual(maven.tiers.standard, ['mvn test']);
  assert.deepEqual(maven.tiers.deep, ['mvn verify']);

  const dotnet = deriveValidationTiers({ packageManager: 'dotnet', stacks: { dotnet: true } });
  assert.deepEqual(dotnet.tiers.standard, ['dotnet test']);
  assert.deepEqual(dotnet.tiers.deep, []);
});

test('无语义明确命令的项目推导出三个空层', () => {
  const { tiers, reasons } = deriveValidationTiers({
    packageManager: 'pnpm',
    scripts: { build: 'vite build', start: 'node src/server.js' },
  });

  assert.deepEqual(tiers, emptyValidationTiers());
  assert.deepEqual(reasons, emptyValidationTiers());
  assert.equal(resolveValidationTiers({ derived: { tiers } }).tierSource, 'empty');
});

test('readProjectTierFacts 读取包管理器、脚本与技术栈标记', async () => {
  const target = await projectFixture({
    'Legacy.sln': 'Microsoft Visual Studio Solution File\n',
    'package.json': `${JSON.stringify({ scripts: { lint: 'eslint .' } })}\n`,
    'src/App.csproj': '<Project Sdk="Microsoft.NET.Sdk" />\n',
  });
  try {
    const facts = await readProjectTierFacts(target);
    assert.equal(facts.packageManager, 'npm');
    assert.deepEqual(facts.scripts, { lint: 'eslint .' });
    assert.deepEqual(facts.stacks, { dotnet: true, maven: false });
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('readProjectTierFacts 识别 Maven 与 pnpm 锁文件', async () => {
  const target = await projectFixture({ 'pom.xml': '<project />\n', 'pnpm-lock.yaml': 'lockfileVersion: 9\n' });
  try {
    const facts = await readProjectTierFacts(target);
    assert.equal(facts.packageManager, 'pnpm');
    assert.deepEqual(facts.stacks, { dotnet: false, maven: true });
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('resolveValidationTiers 让显式配置覆盖推导结果', () => {
  const derived = { tiers: { quick: ['pnpm lint'], standard: [], deep: ['pnpm test:e2e'] } };
  const resolved = resolveValidationTiers({
    configuredTiers: { quick: ['pnpm lint:strict'], standard: [], deep: ['pnpm test:e2e'] },
    derived,
  });

  assert.equal(resolved.tierSource, 'explicit');
  assert.deepEqual(resolved.tiers.quick, ['pnpm lint:strict']);
  assert.deepEqual(resolved.tiers.deep, ['pnpm test:e2e']);
  assert.match(resolved.tierReasons.quick[0], /validationCommands\.tiers\.quick/u);
  assert.match(resolved.tierReasons.standard[0], /显式配置为空数组/u);
});

test('resolveValidationTiers 只为显式配置缺失的层做推导', () => {
  const resolved = resolveValidationTiers({
    configuredTiers: { quick: ['pnpm lint'] },
    derived: { tiers: { quick: ['pnpm lint'], standard: ['pnpm test:integration'], deep: ['pnpm test:e2e'] } },
  });

  assert.equal(resolved.tierSource, 'derived');
  assert.deepEqual(resolved.tiers.quick, ['pnpm lint']);
  assert.deepEqual(resolved.tiers.standard, ['pnpm test:integration']);
  assert.deepEqual(resolved.tiers.deep, ['pnpm test:e2e']);
});

test('normalizeValidationTiers 去空白、去重并忽略非字符串项', () => {
  assert.deepEqual(
    normalizeValidationTiers({ quick: [' pnpm lint ', 'pnpm lint', '', 42], standard: 'nope', deep: [] }),
    { quick: ['pnpm lint'], standard: [], deep: [] },
  );
  assert.deepEqual(normalizeValidationTiers(['pnpm lint']), emptyValidationTiers());
});

test('planValidationTierMigration 只补充配置缺失的层键', () => {
  const plan = planValidationTierMigration({
    configuredTiers: { quick: [] },
    derivedTiers: { quick: ['pnpm lint'], standard: ['pnpm test:integration'], deep: ['pnpm test:e2e'] },
  });

  // An empty array is a deliberate "disabled" statement, so the migration must
  // keep it and only add the two absent keys.
  assert.deepEqual(plan.addedTiers, ['standard', 'deep']);
  assert.deepEqual(plan.tiers, {
    quick: [],
    standard: ['pnpm test:integration'],
    deep: ['pnpm test:e2e'],
  });
});

test('planValidationTierMigration 在每层都已声明时不再补充', () => {
  assert.equal(planValidationTierMigration({
    configuredTiers: { quick: [], standard: [], deep: [] },
    derivedTiers: { quick: ['pnpm lint'], standard: [], deep: [] },
  }), null);
});

test('normalizeTierOption 不再接受 all 别名并拒绝未知取值', () => {
  assert.equal(normalizeTierOption('quick'), 'quick');
  assert.equal(normalizeTierOption('standard'), 'standard');
  assert.equal(normalizeTierOption('deep'), 'deep');
  assert.equal(normalizeTierOption(' DEEP '), 'deep');
  assert.throws(() => normalizeTierOption('all'), /--tier must be one of quick, standard, deep/u);
  assert.throws(() => normalizeTierOption('nightly'), /--tier must be one of/u);
  assert.throws(() => normalizeTierOption(undefined), /--tier must be one of/u);
});

test('未指定成本层时默认落在快速层', () => {
  const tiers = { quick: ['pnpm lint'], standard: ['pnpm test:integration'], deep: ['pnpm test:e2e'] };
  const resolved = resolveExecutionTier({ tiers });

  assert.equal(DEFAULT_VALIDATION_TIER, 'quick');
  assert.equal(resolved.tier, 'quick');
  assert.equal(resolved.fallback, null);
  assert.equal(nextNonEmptyTier('quick', tiers), 'standard');
  assert.equal(nextNonEmptyTier('standard', tiers), 'deep');
  assert.equal(nextNonEmptyTier('deep', tiers), null);
});

test('快速层为空时默认调用回退到最便宜的非空层并记录原因', () => {
  const tiers = { quick: [], standard: [], deep: ['pnpm test:e2e'] };
  const resolved = resolveExecutionTier({ tiers });

  assert.equal(cheapestNonEmptyTier(tiers), 'deep');
  assert.equal(resolved.tier, 'deep');
  assert.deepEqual(resolved.fallback, {
    from: 'quick',
    reason: 'quick 层未声明命令，回退到最便宜的非空层',
    to: 'deep',
  });
});

test('显式 --tier 不回退，未声明任何层时退回风险计划', () => {
  const explicit = resolveExecutionTier({
    explicit: true,
    tier: 'quick',
    tiers: { quick: [], standard: ['pnpm test:integration'], deep: [] },
  });
  assert.equal(explicit.tier, 'quick');
  assert.equal(explicit.fallback, null);

  // No command in any layer means the tier surface is not declared at all:
  // the caller keeps the risk-plan path instead of running an empty layer.
  const undeclared = resolveExecutionTier({ tiers: emptyValidationTiers() });
  assert.equal(undeclared.tier, null);
  assert.equal(undeclared.fallback, null);
  assert.equal(cheapestNonEmptyTier(emptyValidationTiers()), null);
});

test('selectTierChecks 选择累计层并延迟更深层', () => {
  const tiers = {
    quick: ['pnpm lint', 'pnpm test:unit'],
    standard: ['pnpm test:integration'],
    deep: ['pnpm test:e2e'],
  };
  const commandStatus = {
    lint: { command: 'pnpm lint', status: 'available' },
    test: { command: 'pnpm test:unit', status: 'available' },
  };

  const quick = selectTierChecks({ commandStatus, tier: 'quick', tiers });
  assert.deepEqual(quick.selectedChecks.map((item) => item.costTier), ['quick', 'quick']);
  // The configured `test` command keeps its historical id instead of a slug.
  assert.deepEqual(quick.selectedChecks.map((item) => item.id), ['lint', 'test']);
  assert.deepEqual(quick.deferredChecks.map((item) => item.id), ['test-integration', 'test-e2e']);
  assert.equal(quick.selectedChecks[0].blockingScope, 'quick 失败阻塞当前实施单元');
  assert.match(quick.deferredChecks[1].blockingScope, /deep 失败阻塞集成、发布/u);

  const standard = selectTierChecks({ commandStatus, tier: 'standard', tiers });
  assert.deepEqual(standard.selectedChecks.map((item) => item.id), ['lint', 'test', 'test-integration']);
  assert.deepEqual(standard.deferredChecks.map((item) => item.id), ['test-e2e']);

  const deep = selectTierChecks({ commandStatus, tier: 'deep', tiers });
  assert.deepEqual(deep.deferredChecks, []);
  assert.equal(deep.selectedChecks.length, 4);
});

test('selectTierChecks 让重复命令停留在最低层', () => {
  const selection = selectTierChecks({
    tier: 'quick',
    tiers: { quick: ['pnpm lint'], standard: ['pnpm lint'], deep: [] },
  });
  assert.deepEqual(selection.selectedChecks.map((item) => item.id), ['lint']);
  assert.deepEqual(selection.deferredChecks, []);
});
