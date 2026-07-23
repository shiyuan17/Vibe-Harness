import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { inspectValidationCommands } from './command-status.js';
import {
  backupFile,
  createBackupId,
  hashFile,
  readInstallState,
  registerGeneratedFile,
  stateFilePath,
} from './install-state.js';
import { assertSafePathInside, pathExists, validateJsonAgainstSchema } from './manifest.js';
import { beginFileTransaction } from './file-transaction.js';
import { executeProjectVerification } from './project-verification.js';
import { inspectProfileTools } from './tool-provisioning.js';
import { projectStateDir } from './project-layout.js';

const execFileAsync = promisify(execFile);
const reportTarget = 'docs/cognis/PROJECT_BASELINE.md';

function baselineError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableObject(value[key])]));
}

function singleLine(value) {
  return String(value).replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function publicTools(tools) {
  return stableObject(Object.fromEntries(Object.entries(tools).map(([id, tool]) => [id, {
    ...(tool.code ? { code: tool.code } : {}),
    ...(tool.platform ? { platform: tool.platform } : {}),
    phase: tool.phase,
    ...(tool.source ? { source: tool.source } : {}),
    status: tool.status,
    version: tool.version,
  }])));
}

async function inspectVcs(targetDir, projectProfile) {
  if (!projectProfile.vcsSummary.includes('Git')) {
    return { kind: projectProfile.vcsSummary, workingTreeStatus: 'unknown' };
  }
  try {
    const result = await execFileAsync('git', ['status', '--short'], { cwd: targetDir, windowsHide: true });
    return { kind: projectProfile.vcsSummary, workingTreeStatus: result.stdout.trim() ? 'dirty' : 'clean' };
  } catch {
    return { kind: projectProfile.vcsSummary, workingTreeStatus: 'unknown' };
  }
}

function redactProjectPath(command, targetDir) {
  if (!command) return null;
  const projectPath = path.resolve(targetDir);
  const lowerProjectPath = projectPath.toLowerCase();
  let redacted = singleLine(command);
  let index = redacted.toLowerCase().indexOf(lowerProjectPath);
  while (index !== -1) {
    redacted = `${redacted.slice(0, index)}<project>${redacted.slice(index + projectPath.length)}`;
    index = redacted.toLowerCase().indexOf(lowerProjectPath, index + '<project>'.length);
  }
  return redacted
    .replaceAll('\\', '/')
    .replace(/\b((?:api[-_]?key|password|secret|token)=)[^\s/]+/giu, '$1[REDACTED]')
    .replace(/(--?(?:api[-_]?key|password|secret|token)(?:=|\s+))[^\s]+/giu, '$1[REDACTED]')
    .replace(/\bBearer\s+[^\s]+/giu, 'Bearer [REDACTED]');
}

function sanitizeVerification(commandStatus, results, targetDir, verify) {
  const commands = {};
  for (const name of ['governance', 'lint', 'typecheck', 'eval']) {
    const source = results?.[name] ?? commandStatus[name] ?? { command: null, status: 'not_configured' };
    commands[name] = stableObject({
      ...(source.command ? { command: redactProjectPath(source.command, targetDir) } : {}),
      ...(Number.isInteger(source.exitCode) ? { exitCode: source.exitCode } : {}),
      status: source.status,
    });
  }
  if (!verify) return { commands, mode: 'static', status: 'not_run' };
  const statuses = Object.values(commands).map((item) => item.status);
  const status = statuses.includes('failed')
    ? 'failed'
    : (statuses.includes('blocked') || statuses.includes('missing') ? 'blocked' : 'passed');
  return { commands, mode: 'executed', status };
}

function installedSkillNames(target) {
  return new Set(target.expected
    .map((item) => item.target.match(/^\.agents\/skills\/([^/]+)\/SKILL\.md$/u)?.[1])
    .filter(Boolean));
}

function workflow(id, name, trigger, steps, candidates, installedSkills) {
  const skills = candidates.filter((skill) => installedSkills.has(skill));
  return { id, name, trigger, steps, ...(skills.length > 0 ? { skills } : {}) };
}

function createWorkflows(target, governanceWorkflow) {
  const skills = installedSkillNames(target);
  if (governanceWorkflow === 'adaptive') {
    return [
      workflow('outcome-first', '结果优先执行', '目标清晰且属于已授权、可逆的本地工作', ['获取仓库事实', '实施最小改动', '运行与主张匹配的验证', '简洁交付结果与证据'], [], skills),
      workflow('clarification', '必要澄清', '仓库事实无法消除会改变结果的产品决定', ['区分审批、产品决定和实现选择', '单轮询问最多三个独立决定', '答案关闭分支后直接继续'], ['clarify-requirements'], skills),
      workflow('escalation', '失败或风险升级', '出现未知根因、特殊领域知识或完整路径信号', ['按 description 只加载当前阶段一个必要 Skill', '安全、外部契约、红区或不可逆动作进入完整路径', '验证后交付真实风险'], ['systematic-debugging', 'security-and-hardening'], skills),
    ];
  }
  return [
    workflow('requirements', '需求澄清', '仓库事实无法消除会改变结果的产品决定', ['区分审批、产品决定和实现选择', '单轮询问最多三个独立决定', '答案关闭分支后直接继续'], ['clarify-requirements'], skills),
    workflow('scoped-change', '轻量代码修改', '单一范围且不涉及红区或外部契约', ['固定写入范围', '为行为变化匹配测试', '实施最小改动', '运行聚焦验证并交付证据'], [], skills),
    workflow('debugging', '故障排查', '测试失败、构建错误或行为异常', ['复现问题', '定位根因', '用失败测试锁定问题', '修复并验证反例'], ['systematic-debugging'], skills),
    workflow('high-risk', '完整高风险任务', '涉及安全、数据、发布、红区、跨层或外部契约', ['先完成风险和回滚设计', '分解任务并实施', '执行宿主原生 Review 和独立 Red Team', '验证后交付剩余风险'], ['security-and-hardening'], skills),
    workflow('delivery', '验证与交付', '准备声明任务完成', ['运行本轮有效检查', '核对主张、证据、反例和剩余风险', '报告 Git 状态与下一步'], [], skills),
  ];
}

function createRecommendations({ profile, tools, verification, vcs }) {
  const recommendations = [];
  for (const [name, command] of Object.entries(verification.commands)) {
    if (command.status === 'failed' || command.status === 'blocked') {
      recommendations.push({ code: `VERIFY_${name.toUpperCase()}_${command.status.toUpperCase()}`, message: `修复 ${name} 验证的 ${command.status} 状态后重新建立基线。`, priority: 'P0' });
    } else if (['manual', 'missing', 'not_configured'].includes(command.status)) {
      recommendations.push({ code: `VERIFY_${name.toUpperCase()}_${command.status.toUpperCase()}`, message: `在 cognis.config.json 中补齐或确认 ${name} 验证命令。`, priority: 'P1' });
    }
  }
  for (const [id, tool] of Object.entries(tools)) {
    if (['degraded', 'pending-config'].includes(tool.status)) {
      recommendations.push({ code: `TOOL_${id.toUpperCase()}_${tool.status.replaceAll('-', '_').toUpperCase()}`, message: `处理 ${id} 的 ${tool.status} 状态后重新运行安装或 doctor。`, priority: 'P1' });
    }
  }
  if (verification.mode === 'static') {
    recommendations.push({ code: 'BASELINE_VERIFICATION_NOT_RUN', command: 'cognis baseline --project <project> --verify --write', message: '执行项目验证并把结果纳入基线。', priority: 'P2' });
  }
  if (vcs.workingTreeStatus === 'dirty') {
    recommendations.push({ code: 'VCS_WORKTREE_DIRTY', message: '开始修改前先确认并保护当前未提交改动。', priority: 'P2' });
  }
  if (profile !== 'full') {
    recommendations.push({ code: 'OPTIONAL_FULL_CAPABILITIES_DISABLED', message: '当前 profile 未启用 full 的持久记忆和 hooks；仅在项目确有需要时升级。外部工具独立使用 --plugin 管理。', priority: 'P2' });
  }
  return recommendations.sort((a, b) => `${a.priority}:${a.code}`.localeCompare(`${b.priority}:${b.code}`));
}

function comparableBaseline(baseline) {
  return {
    installation: baseline.installation,
    project: baseline.project,
    verification: baseline.verification,
  };
}

function collectChanges(before, after, prefix = '') {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object' || Array.isArray(before) || Array.isArray(after)) {
    return [{ path: prefix || '$', ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) }];
  }
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .flatMap((key) => collectChanges(before[key], after[key], prefix ? `${prefix}.${key}` : key));
}

async function readPreviousBaseline(targetDir, installState, baselineTarget) {
  const target = path.join(targetDir, baselineTarget);
  if (!(await pathExists(target))) return null;
  const tracked = installState.generatedFiles?.find((item) => item.target === baselineTarget);
  if (!tracked || await hashFile(target) !== tracked.targetHash) return null;
  try {
    return JSON.parse(await readFile(target, 'utf8'));
  } catch {
    return null;
  }
}

function renderReport(baseline) {
  const toolLines = Object.entries(baseline.installation.tools).map(([id, tool]) => `- ${id}: ${tool.status} (${tool.phase})`);
  const commandLines = Object.entries(baseline.verification.commands).map(([name, item]) => `- ${name}: ${item.status}${item.command ? ` - \`${item.command}\`` : ''}`);
  const recommendationLines = baseline.recommendations.map((item) => `- [${item.priority}] ${item.message}${item.command ? ` \`${item.command}\`` : ''}`);
  const workflowSections = baseline.workflows.map((item) => [
    `### ${item.name}`,
    '',
    `触发条件：${item.trigger}`,
    '',
    ...item.steps.map((step, index) => `${index + 1}. ${step}`),
    ...(item.skills?.length ? ['', `可用 Skills：${item.skills.map((skill) => `\`${skill}\``).join('、')}`] : []),
  ].join('\n'));
  return `<!-- Generated by Cognis. Refresh with cognis baseline; do not edit this managed file. -->
# 项目基线

- 生成时间：${baseline.generatedAt}
- 项目：${baseline.project.name}
- 技术栈：${baseline.project.stackSummary}
- Profile：${baseline.installation.profile}
- Workflow：${baseline.installation.governanceWorkflow}
- 工具插件：${baseline.installation.requestedPlugins.length ? baseline.installation.requestedPlugins.map((plugin) => `\`${plugin}\``).join('、') : '未选择'}
- 安装状态：${baseline.installation.status}
- 漂移状态：${baseline.drift.status}

## 项目事实

- 包管理器：${baseline.project.packageManager}
- 目录提示：${baseline.project.directoryGuidance}
- 版本控制：${baseline.project.vcs.kind}
- 工作区状态：${baseline.project.vcs.workingTreeStatus}

## 工具状态

${toolLines.length ? toolLines.join('\n') : '- 当前安装未选择项目内工具插件。'}

## 验证状态

- 模式：${baseline.verification.mode}
- 结果：${baseline.verification.status}
${commandLines.join('\n')}

## 后续工作流

${workflowSections.join('\n\n')}

## 建议

${recommendationLines.length ? recommendationLines.join('\n') : '- 当前没有待处理建议。'}
`;
}

async function inspectArtifact(targetDir, installState, relativeTarget) {
  const target = path.join(targetDir, relativeTarget);
  if (!(await pathExists(target))) return { action: 'create', relativeTarget, target };
  const tracked = installState.generatedFiles?.find((item) => item.target === relativeTarget);
  const currentHash = await hashFile(target);
  if (tracked?.targetHash === currentHash) return { action: 'update', relativeTarget, target };
  return { action: 'conflict', relativeTarget, target };
}

export async function createProjectBaseline({
  baselineSchema,
  commandStatus,
  config,
  force = false,
  governanceMode,
  governanceWorkflow,
  installState,
  now = new Date(),
  projectProfile,
  target,
  targetDir,
  tools,
  verify = false,
  write = false,
}) {
  const stateRoot = await projectStateDir(targetDir);
  const baselineTarget = `${path.basename(stateRoot)}/baseline.json`;
  const vcs = await inspectVcs(targetDir, projectProfile);
  const verificationResults = verify
    ? await executeProjectVerification({ commandStatus, failureMode: 'report', targetDir })
    : null;
  const verification = sanitizeVerification(commandStatus, verificationResults, targetDir, verify);
  const publicToolStates = publicTools(tools);
  const baseline = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    project: {
      name: singleLine(config.projectName),
      packageManager: singleLine(projectProfile.packageManager),
      stackSummary: singleLine(projectProfile.stackSummary),
      directoryGuidance: singleLine(projectProfile.directoryGuidance),
      vcs: {
        kind: singleLine(vcs.kind),
        workingTreeStatus: vcs.workingTreeStatus,
      },
    },
    installation: {
      governanceMode,
      governanceWorkflow,
      managedFileCount: target.expected.length,
      profile: config.profile,
      requestedPlugins: installState.requestedPlugins ?? [],
      resolvedModules: installState.resolvedModules ?? [],
      status: 'consistent',
      tools: publicToolStates,
      version: installState.version,
    },
    verification,
    workflows: createWorkflows(target, governanceWorkflow),
    recommendations: createRecommendations({ profile: config.profile, tools: publicToolStates, verification, vcs }),
    drift: { changes: [], status: 'initial' },
  };
  const previous = await readPreviousBaseline(targetDir, installState, baselineTarget);
  if (previous?.schemaVersion === 1) {
    const changes = collectChanges(comparableBaseline(previous), comparableBaseline(baseline));
    baseline.drift = { changes, status: changes.length > 0 ? 'changed' : 'unchanged' };
  }
  const schemaErrors = validateJsonAgainstSchema(baseline, baselineSchema, 'baseline');
  if (schemaErrors.length > 0) {
    throw baselineError('BASELINE_SCHEMA_INVALID', schemaErrors.join('\n'));
  }
  const report = renderReport(baseline);
  const artifacts = await Promise.all([
    inspectArtifact(targetDir, installState, baselineTarget),
    inspectArtifact(targetDir, installState, reportTarget),
  ]);
  const conflicts = artifacts.filter((item) => item.action === 'conflict');
  if (write && conflicts.length > 0 && !force) {
    throw baselineError('BASELINE_ARTIFACT_CONFLICT', `Refusing to overwrite unmanaged or modified baseline artifact: ${conflicts[0].relativeTarget}`);
  }
  const backups = [];
  if (write) {
    const backupId = createBackupId(now);
    const transaction = await beginFileTransaction({
      cleanupPaths: [path.join(stateRoot, 'backups', backupId)],
      operation: 'baseline',
      targetDir,
      trackedPaths: [...artifacts.map((item) => item.target), stateFilePath(targetDir)],
    });
    try {
    for (const item of conflicts) {
      backups.push({ target: item.relativeTarget, backup: await backupFile({ backupId, target: item.target, targetDir }) });
    }
    for (const item of artifacts) {
      await assertSafePathInside(targetDir, item.target, 'project baseline artifact');
      await mkdir(path.dirname(item.target), { recursive: true });
    }
    await writeFile(path.join(targetDir, baselineTarget), `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    await writeFile(path.join(targetDir, reportTarget), report, 'utf8');
    await registerGeneratedFile(targetDir, baselineTarget);
    await registerGeneratedFile(targetDir, reportTarget);
    await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
  return {
    artifacts: artifacts.map((item) => ({ action: item.action, target: item.relativeTarget })),
    backups,
    baseline,
    dryRun: !write,
    ok: verification.status !== 'failed' && verification.status !== 'blocked',
    written: write ? [baselineTarget, reportTarget] : [],
  };
}

export async function collectProjectBaselineInputs({
  config,
  governanceMode,
  projectProfile,
  target,
  targetDir,
  validationCommands,
}) {
  let installState;
  try {
    installState = await readInstallState(targetDir);
  } catch (cause) {
    throw Object.assign(baselineError('BASELINE_INSTALL_INVALID', 'Project install state is invalid; reinstall before baseline.'), { cause });
  }
  if (
    !installState
    || !target.ok
    || installState.profile !== config.profile
    || typeof installState.version !== 'string'
    || !installState.version.trim()
  ) {
    throw baselineError('BASELINE_INSTALL_INVALID', 'Project installation is missing or inconsistent; run cognis install and validate before baseline.');
  }
  const [commandStatus, tools] = await Promise.all([
    inspectValidationCommands({ commands: validationCommands, targetDir }),
    inspectProfileTools(config.profile, targetDir, installState.resolvedModules, undefined, {
      allowPreview: true,
    }),
  ]);
  return { commandStatus, installState, tools };
}
