import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createInstallPlan, renderActionContent } from '../scripts/lib/install-planner.js';
import { loadAllManifests, readJson } from '../scripts/lib/manifest.js';
import { scanForForbiddenTerms } from '../scripts/lib/redaction.js';

const rootDir = path.resolve(import.meta.dirname, '..');
const coreSkills = ['clarify-requirements', 'define-goal', 'git-deliver', 'systematic-debugging', 'eval-driven-development', 'security-and-hardening'];
const fullSkills = [...coreSkills, 'api-and-interface-design', 'frontend-design', 'runtime-cross-repo-rollout'];

test('canonical governance and nine native Skills are declared without a Router', async () => {
  const manifests = await loadAllManifests(rootDir);
  const rules = new Set(manifests.rules.items.map((item) => item.id));
  for (const id of ['governance-core', 'git-rules', 'test-rules', 'agent-skill-routing']) assert.equal(rules.has(id), true);
  assert.deepEqual(manifests.skills.items.filter((item) => item.kind === 'native').map((item) => item.id), fullSkills);
  assert.equal(manifests.skills.items.some((item) => ['router', 'compatibility'].includes(item.kind)), false);
});

test('completion evidence and task-scoped testing live in governance rules', async () => {
  const [kernel, testRules, troubleshootingRules, projectDirectoryRules, taskTemplate, englishTaskTemplate, gitRules, ...templates] = await Promise.all([
    readFile(path.join(rootDir, 'docs/rules/governance-core.md'), 'utf8'),
    readFile(path.join(rootDir, 'docs/rules/test-rules.md'), 'utf8'),
    readFile(path.join(rootDir, 'docs/rules/troubleshooting.md'), 'utf8'),
    readFile(path.join(rootDir, 'docs/rules/project-directory.md'), 'utf8'),
    readFile(path.join(rootDir, 'templates/task.md'), 'utf8'),
    readFile(path.join(rootDir, 'templates/task.en-US.md'), 'utf8'),
    readFile(path.join(rootDir, 'docs/rules/git-rules.md'), 'utf8'),
    ...['adapters/codex/AGENTS.template.md', 'adapters/claude/CLAUDE.template.md', 'adapters/gemini/GEMINI.template.md']
      .map((file) => readFile(path.join(rootDir, file), 'utf8')),
  ]);
  assert.match(kernel, /没有本轮有效验证不得声称完成/u);
  assert.match(kernel, /每个有实质修改的任务先按变更类型选择项目已定义的聚焦检查/u);
  assert.match(kernel, /最后一次实质修改后的状态重跑同一检查/u);
  assert.match(kernel, /覆盖同一受影响行为的等价检查及理由/u);
  assert.match(kernel, /handoff 只引用晚于最后一次实质修改的结果/u);
  for (const label of ['已确认事实', '静态结论', '待验证假设', '验证受阻']) assert.match(kernel, new RegExp(label, 'u'));
  for (const sensitive of ['密码', 'Secret', 'Token', 'Cookie', '验证码', '认证头', '会话标识', '个人敏感数据']) {
    assert.match(kernel, new RegExp(sensitive, 'u'));
  }
  assert.match(kernel, /不得进入回复、日志、错误、快照、Eval、任务记录或持久记忆/u);
  const taskExample = kernel.match(/10:00[\s\S]*10:05[\s\S]*10:07[\s\S]*交付只能引用 10:07/u)?.[0];
  assert.ok(taskExample);
  assert.ok(taskExample.indexOf('10:00') < taskExample.indexOf('10:05'));
  assert.ok(taskExample.indexOf('10:05') < taskExample.indexOf('10:07'));
  assert.match(testRules, /普通对话\s*\/\s*只读诊断/u);
  assert.match(testRules, /全量测试不是默认验证/u);
  assert.match(testRules, /验证受阻（degraded）/u);
  assert.match(testRules, /不得推断产品通过或失败/u);
  assert.match(testRules, /降低断言、删除断言或无理由跳过相关测试绕过/u);
  assert.match(testRules, /覆盖率是诊断信号不是目标/u);
  assert.match(testRules, /先写暴露该缺陷的复现测试/u);
  assert.match(testRules, /flaky 测试须隔离并限期修复，不以重跑掩盖/u);
  assert.match(testRules, /断言行为而非实现细节/u);
  assert.match(testRules, /仅测试使用的辅助路径/u);
  assert.match(troubleshootingRules, /验证受阻（degraded）/u);
  assert.match(troubleshootingRules, /失败阶段、替代证据、未验证行为和剩余风险/u);
  assert.match(projectDirectoryRules, /小型 Bug、单文件修改和简单问答不展开该清单/u);
  for (const item of ['技术栈', '目录结构', '业务流', '数据流', '模块依赖']) {
    assert.match(projectDirectoryRules, new RegExp(item, 'u'));
    assert.match(taskTemplate, new RegExp(item, 'u'));
  }
  assert.match(taskTemplate, /仅显式要求或影响范围无法缩小时填写/u);
  assert.match(englishTaskTemplate, /only when explicitly requested or impact cannot be narrowed/u);
  assert.match(testRules, /对抗式/u);
  assert.match(testRules, /测试类型/u);
  assert.match(testRules, /参考实现/u);
  assert.match(testRules, /契约重放（contract-replay）/u);
  assert.match(testRules, /eval:behavioral/u);
  assert.match(testRules, /更新须单独审查显式确认/u);
  assert.match(gitRules, /参考实现/u);
  for (const template of templates) assert.match(template, /测试范围细则/u);
});

test('OBS-RULE-001 observability guidance stays concise and enforces behavior', async () => {
  const rule = await readFile(path.join(rootDir, 'docs/rules/log-management.md'), 'utf8');
  const lines = rule.trimEnd().split(/\r?\n/u);
  const headings = lines.filter((line) => line.startsWith('## '));
  assert.ok(lines.length <= 60, 'log-management.md exceeds 60 lines: ' + lines.length);
  assert.deepEqual(headings, [
    '## 目标与边界',
    '## 最小字段与关联',
    '## 指标与追踪底线',
    '## 安全与可靠性',
    '## 排障与验收',
  ]);

  assert.match(rule, /新增日志、指标或追踪前必须说明消费目的/u);
  assert.match(rule, /公共字段包含时间、级别、service\/component、event\/operation、结果和 environment\/version/u);
  assert.match(rule, /项目已有 trace context 时同时记录 <code>traceId<\/code> 和 <code>spanId<\/code>/u);
  assert.match(rule, /<code>correlationId<\/code>.*不能替代 trace context/u);
  assert.match(rule, /结果指标必须同时提供总量/u);
  assert.match(rule, /延迟使用分布并区分成功与失败/u);
  assert.match(rule, /用户 ID、请求 ID、邮箱、完整 URL/u);
  assert.match(rule, /高基数值/u);
  assert.match(rule, /校验、限长、编码和脱敏/u);
  assert.match(rule, /CR\/LF/u);
  assert.match(rule, /不得阻塞核心业务/u);
  assert.match(rule, /\.vibe-harness\/log\//u);
  assert.match(rule, /\.vibe-harness\/artifacts\//u);
  assert.match(rule, /实际查询条件和验证证据/u);
  assert.match(rule, /先读取项目专项规则中的日志画像/u);
  assert.match(rule, /候选证据不能直接当作运行事实/u);
  assert.match(rule, /不引入新日志库、追踪系统或存储后端/u);
  assert.match(rule, /不编造生产位置或平台命令/u);
  assert.match(rule, /不代表目标应用日志目录/u);

  assert.doesNotMatch(rule, /https?:\/\//u);
  assert.doesNotMatch(rule, /OpenTelemetry|observedTimestamp|instrumentationScope|severityNumber|四个黄金信号|错误预算|多窗口|WAL|尾部采样|Eval 的 durationMs/u);
  assert.doesNotMatch(rule, /^\s+\{.*\}\s*$/mu);
  assert.doesNotMatch(rule, /ORDER_CREATE_FAILED|orders|req-123/u);
});

test('generic rules constrain process while retaining safety boundaries', async () => {
  const names = [
    'ai-collab-rules', 'ast-grep', 'chrome-devtools-mcp', 'codebase-memory-mcp',
    'coding-rules', 'frontend-rules', 'git-rules', 'log-management',
    'project-directory', 'release-rules', 'rtk', 'test-rules', 'troubleshooting',
  ];
  const entries = await Promise.all(names.map(async (name) => [
    name,
    await readFile(path.join(rootDir, 'docs/rules', name + '.md'), 'utf8'),
  ]));
  const rules = Object.fromEntries(entries);

  assert.match(rules['codebase-memory-mcp'], /只有显式选择.*--plugin codebase-memory-mcp/u);
  assert.match(rules['codebase-memory-mcp'], /未选择插件时不得假设工具存在/u);
  assert.doesNotMatch(rules['codebase-memory-mcp'], /full\/internal profile|full profile.*安装/u);
  for (const name of ['ast-grep', 'chrome-devtools-mcp', 'codebase-memory-mcp', 'rtk']) {
    assert.match(rules[name], /仅在.*(?:插件|工具).*存在.*时生效/u, name);
  }

  assert.match(rules['frontend-rules'], /用户输入和其他不可信内容不得直接注入 HTML/u);
  assert.match(rules['frontend-rules'], /破坏性操作必须要求确认或提供可恢复/u);
  assert.match(rules['frontend-rules'], /导航使用链接语义，操作使用按钮语义/u);
  assert.match(rules['frontend-rules'], /令牌体系或完整浏览器矩阵缺失不阻塞/u);
  assert.doesNotMatch(rules['frontend-rules'], /设计令牌系统必须存在|超过 50 项列表虚拟化|启用 CSP 与可信类型/u);

  assert.match(rules['test-rules'], /项目已配置且对本次文件或语言适用时/u);
  assert.match(rules['test-rules'], /只有共享.*无法隔离时才串行/u);
  assert.match(rules['test-rules'], /仅是 Vibe-Harness 参考值，不是目标项目通用门禁/u);

  assert.match(rules['project-directory'], /长期有效、高影响且难以逆转/u);
  assert.match(rules['project-directory'], /不为普通修复.*新建 ADR 体系/u);
  assert.doesNotMatch(rules['project-directory'], /跨模块边界变化必须创建 ADR/u);
  assert.match(rules['git-rules'], /普通单 Agent 局部修复不因任务类型自动创建 worktree/u);
  assert.doesNotMatch(rules['git-rules'], /一个实现任务对应一个命名分支 worktree/u);
  assert.doesNotMatch(rules['release-rules'], /tgz|SHA256|npm publish/u);

  assert.match(rules['coding-rules'], /先缩小改动范围/u);
  assert.match(rules.troubleshooting, /不得把“本地未复现”当作问题不存在或自动停止/u);
  assert.match(rules.troubleshooting, /需要产品决策、额外权限或生产访问/u);
  assert.match(rules['ai-collab-rules'], /仅在实际使用两个以上协作单元时生效/u);
  assert.match(rules['log-management'], /不替代目标项目的日志或遥测契约/u);
});

test('profiles install zero, six, or nine native Skills at intended tiers', async () => {
  for (const [profile, expected] of [['minimal', []], ['docs-only', []], ['core', coreSkills], ['full', fullSkills]]) {
    const plan = await createInstallPlan({ dryRun: true, profile, rootDir, targetDir: path.join(rootDir, `.tmp-depth-${profile}`) });
    const targets = new Set(plan.actions.map((item) => item.relativeTarget));
    const installed = fullSkills.filter((skill) => targets.has(`.agents/skills/${skill}/SKILL.md`));
    assert.deepEqual(installed, expected);
    assert.equal(targets.has('.agents/skills/agentmemory/SKILL.md'), false);
    assert.equal(targets.has('.agents/memory/README.md'), false);
    assert.equal(targets.has('.codex/hooks.json'), profile === 'full');
  }
});

test('installed native Skills preserve the same dependency-free contracts across adapters', async () => {
  for (const adapterId of ['codex', 'claude', 'gemini']) {
    const plan = await createInstallPlan({ adapterId, dryRun: true, profile: 'core', rootDir, targetDir: path.join(rootDir, `.tmp-depth-${adapterId}`) });
    for (const skill of coreSkills) {
      const action = plan.actions.find((item) => item.relativeSource === `skills/core/${skill}/SKILL.md`);
      assert.ok(action);
      assert.match(await renderActionContent(action, plan.renderData), new RegExp(`name: ${skill}`, 'u'));
    }
    assert.equal(plan.actions.some((item) => item.relativeTarget.endsWith('/agents/openai.yaml')), adapterId === 'codex');
  }
});

test('reusable assets stay generic and source mapping points to existing assets', async () => {
  const leaks = await scanForForbiddenTerms({
    forbiddenTerms: ['SYBaseProjectWeb', 'SYBaseProject', 'D:\\Github\\JW', 'T-019', '患者', '病理'],
    includeDirs: ['rules', 'templates', 'skills/core', 'skills/integrations', 'memory', 'adapters/codex', 'adapters/claude', 'adapters/gemini', 'manifests', 'schemas'],
    rootDir,
  });
  assert.deepEqual(leaks, []);
  const mapping = await readFile(path.join(rootDir, 'docs/inventory/source-rules-mapping.md'), 'utf8');
  assert.match(mapping, /Skill descriptions/u);
  assert.equal((await readJson(path.join(rootDir, 'manifests/profiles.json'))).items.length, 4);
});
