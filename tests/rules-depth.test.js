import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createInstallPlan, renderActionContent } from '../scripts/lib/install-planner.js';
import { loadAllManifests, readJson } from '../scripts/lib/manifest.js';
import { scanForForbiddenTerms } from '../scripts/lib/redaction.js';

const rootDir = path.resolve('.');

test('canonical governance and routed skills are declared', async () => {
  const manifests = await loadAllManifests(rootDir);
  const rules = new Set(manifests.rules.items.map((item) => item.id));
  const skills = new Set(manifests.skills.items.map((item) => item.id));
  for (const id of ['governance-core', 'codebase-memory-mcp', 'git-rules', 'test-rules']) assert.equal(rules.has(id), true);
  for (const id of ['using-cognis', 'verification-before-completion', 'code-review-and-quality', 'adversarial-review-packet']) assert.equal(skills.has(id), true);
});

test('installed instructions scope tests to the task instead of ordinary sessions', async () => {
  const [testRules, verificationSkill, ...adapterTemplates] = await Promise.all([
    readFile(path.join(rootDir, 'rules/test-rules.md'), 'utf8'),
    readFile(path.join(rootDir, 'skills/core/verification-before-completion/SKILL.md'), 'utf8'),
    ...[
      'adapters/codex/AGENTS.template.md',
      'adapters/claude/CLAUDE.template.md',
      'adapters/gemini/GEMINI.template.md',
    ].map((file) => readFile(path.join(rootDir, file), 'utf8')),
  ]);

  assert.match(testRules, /普通对话\s*\/\s*只读诊断/u);
  assert.match(testRules, /默认不运行测试/u);
  assert.match(testRules, /全量测试不是默认验证/u);
  for (const term of [
    '用户明确要求',
    '目标项目将其配置为门禁',
    '发布 / CI',
    '安装器、运行时、hook、模板行为变化',
    '跨模块高风险变更',
    '不因安装而继承',
  ]) {
    assert.match(testRules, new RegExp(term, 'u'));
  }
  assert.match(verificationSkill, /当前主张.*完整命令/u);
  for (const term of [
    '不等于默认运行目标项目的全量测试',
    '只能声明受影响行为已验证',
    '未运行全量测试时必须说明未覆盖范围和升级理由',
  ]) {
    assert.match(verificationSkill, new RegExp(term, 'u'));
  }
  for (const template of adapterTemplates) {
    assert.match(template, /测试范围细则.*docs\/rules\/test-rules\.md/u);
    assert.doesNotMatch(template, /普通会话或只读任务不自动运行全量测试/u);
  }

  for (const adapterId of ['codex', 'claude', 'gemini']) {
    for (const profile of ['minimal', 'core', 'full']) {
      const plan = await createInstallPlan({
        adapterId,
        allowPreview: adapterId !== 'codex' && profile === 'full',
        dryRun: true,
        managedAgentsBlock: true,
        profile,
        rootDir,
        targetDir: path.join(rootDir, `.tmp-test-scope-${adapterId}-${profile}`),
      });
      const instruction = plan.actions.find((action) => action.relativeTarget === plan.instructionTarget);
      assert.ok(instruction, `${adapterId}:${profile} instruction should be installed`);
      const content = await renderActionContent(instruction, plan.renderData);
      assert.match(content, /测试范围细则.*docs\/rules\/test-rules\.md/u);
      assert.doesNotMatch(content, /普通会话或只读任务不自动运行全量测试/u);

      const testRule = plan.actions.find((action) => action.relativeTarget === 'docs/rules/test-rules.md');
      assert.ok(testRule, `${adapterId}:${profile} test rule should be installed`);
      assert.match(await renderActionContent(testRule, plan.renderData), /全量测试不是默认验证/u);

      const verification = plan.actions.find((action) => action.relativeSource === 'skills/core/verification-before-completion/SKILL.md');
      if (['core', 'full'].includes(profile)) {
        assert.ok(verification, `${adapterId}:${profile} should install completion verification`);
        const verificationContent = await renderActionContent(verification, plan.renderData);
        assert.match(verificationContent, /当前主张.*完整命令/u);
        for (const term of [
          '不等于默认运行目标项目的全量测试',
          '只能声明受影响行为已验证',
          '未运行全量测试时必须说明未覆盖范围和升级理由',
        ]) {
          assert.match(verificationContent, new RegExp(term, 'u'));
        }
      } else {
        assert.equal(verification, undefined, `${adapterId}:${profile} should not install completion verification`);
      }
    }
  }
});

test('profiles install minimal, common, and full surfaces at intended tiers', async () => {
  const targets = async (profile) => new Set((await createInstallPlan({ dryRun: true, profile, rootDir, targetDir: path.join(rootDir, '.tmp-profile-check') })).actions.map((item) => item.relativeTarget));
  const minimal = await targets('minimal');
  const core = await targets('core');
  const full = await targets('full');
  assert.equal(minimal.has('docs/rules/governance-core.md'), true);
  assert.equal(minimal.has('docs/rules/coding-rules.md'), false);
  assert.equal([...minimal].some((item) => item.startsWith('.agents/skills/')), false);
  assert.equal(core.has('docs/rules/coding-rules.md'), true);
  assert.equal(core.has('.agents/skills/using-cognis/SKILL.md'), true);
  assert.equal(core.has('.agents/skills/adversarial-review-packet/SKILL.md'), true);
  assert.equal(core.has('.agents/skills/loop-planning/SKILL.md'), false);
  assert.equal(core.has('docs/rules/release-rules.md'), false);
  assert.equal(core.has('docs/rules/db-rules.md'), false);
  assert.equal(core.has('docs/rules/pencil-rules.md'), false);
  assert.equal(core.has('docs/rules/codebase-memory-mcp.md'), false);
  assert.equal(core.has('.agents/skills/agentmemory/SKILL.md'), false);
  assert.equal(core.has('.codex/hooks.json'), false);
  assert.equal(full.has('.agents/skills/adversarial-review-packet/SKILL.md'), true);
  assert.equal(full.has('docs/rules/codebase-memory-mcp.md'), false);
  assert.equal(full.has('.agents/skills/agentmemory/SKILL.md'), true);
  assert.equal(full.has('.agents/memory/README.md'), true);
  assert.equal(full.has('.codex/hooks.json'), true);
  assert.equal(full.has('docs/rules/coding-rules.md'), true);
  assert.equal([...full].some((item) => item.includes('karpathy-guidelines')), false);
});

test('router only names registered skills', async () => {
  const manifests = await loadAllManifests(rootDir);
  const registered = new Set(manifests.skills.items.map((item) => item.id));
  const router = manifests.skills.items.find((item) => item.id === 'using-cognis');
  for (const id of [...router.requiresSkills, ...router.optionalSkills]) assert.equal(registered.has(id), true, `${id} should be registered`);
});

test('rules absorb pruned thin skill guidance', async () => {
  const [coding, git, projectDirectory, frontend, logManagement, release, pencil] = await Promise.all([
    readFile(path.join(rootDir, 'rules/coding-rules.md'), 'utf8'),
    readFile(path.join(rootDir, 'rules/git-rules.md'), 'utf8'),
    readFile(path.join(rootDir, 'rules/project-directory.md'), 'utf8'),
    readFile(path.join(rootDir, 'rules/frontend-rules.md'), 'utf8'),
    readFile(path.join(rootDir, 'rules/log-management.md'), 'utf8'),
    readFile(path.join(rootDir, 'rules/release-rules.md'), 'utf8'),
    readFile(path.join(rootDir, 'rules/pencil-rules.md'), 'utf8'),
  ]);

  assert.match(coding, /characterization test/u);
  assert.match(git, /验证只来自临时 worktree/u);
  assert.match(git, /`<type>\(<scope>\): <中文描述>`/u);
  assert.match(git, /类型前缀和可选 scope 保持英文/u);
  assert.match(git, /主题、正文和人工编写的说明使用中文/u);
  assert.match(git, /`feat: 增加项目基线快照`/u);
  assert.match(git, /`feat: add project baseline snapshots`[^\n]*不符合/u);
  assert.match(git, /Git 自动生成且无需人工编辑的 merge 或 revert 信息不受此限制/u);
  assert.match(projectDirectory, /ADR/u);
  assert.match(frontend, /品牌展示|产品界面/u);
  assert.match(logManagement, /\.cognis\/log\//u);
  assert.match(logManagement, /vite-dev\.out\/err/u);
  assert.doesNotMatch(logManagement, /vite-dev\.out\/err[^\n]*写入[^\n]*artifacts|artifacts[^\n]*vite-dev\.out\/err/u);
  assert.match(release, /本 skill 不维护第二套发布规则|规则是真值/u);
  assert.match(pencil, /同名预览|截图/u);
});

test('reusable assets do not leak source project terms', async () => {
  const leaks = await scanForForbiddenTerms({
    forbiddenTerms: ['SYBaseProjectWeb', 'SYBaseProject', 'D:\\Github\\JW', 'T-019', '患者', '病理'],
    includeDirs: ['rules', 'templates', 'skills/core', 'skills/integrations', 'memory', 'adapters/codex', 'adapters/claude', 'adapters/gemini', 'manifests', 'schemas'],
    rootDir,
  });
  assert.deepEqual(leaks, []);
  assert.equal((await readJson(path.join(rootDir, 'manifests/profiles.json'))).items.length >= 3, true);
});

test('governance rules use deterministic precedence and expose no retired collaboration rule', async () => {
  const manifests = await loadAllManifests(rootDir);
  const reusableFiles = [
    'adapters/codex/AGENTS.template.md',
    'rules/ai-collab-rules.md',
    'rules/project-specific-rules.md',
  ];
  const contents = await Promise.all(reusableFiles.map((file) => readFile(path.join(rootDir, file), 'utf8')));

  assert.equal(manifests.rules.items.some((item) => item.id === 'agent-collaboration'), false);
  for (const content of contents) {
    assert.doesNotMatch(content, /更严格(?:的本地)?规则/u);
  }
  assert.match(contents[0], /同一层级.*停止.*确认/u);
  assert.match(contents[1], /平台系统指令/u);
});

test('adaptive information presentation is routed and scoped to non-minimal profiles', async () => {
  const capabilityManifest = await readJson(path.join(rootDir, 'manifests/capabilities.json'));
  const capability = capabilityManifest.items.find((item) => item.id === 'adaptive-information-presentation');
  assert.ok(capability, 'adaptive-information-presentation capability should be declared');
  assert.deepEqual(capability.targets, ['rules/ai-collab-rules.md', 'rules/agent-skill-routing.md']);
  const targets = async (profile) => new Set((await createInstallPlan({
    dryRun: true,
    profile,
    rootDir,
    targetDir: path.join(rootDir, '.tmp-profile-check'),
  })).actions.map((item) => item.relativeTarget));
  assert.equal((await targets('minimal')).has('docs/rules/ai-collab-rules.md'), false);
  for (const profile of ['core', 'full', 'docs-only']) {
    assert.equal((await targets(profile)).has('docs/rules/ai-collab-rules.md'), true);
  }
});
