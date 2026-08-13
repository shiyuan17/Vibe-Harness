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
const reportTarget = 'docs/vibe-harness/PROJECT_BASELINE.md';

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

function emptyLoggingBaseline() {
  return {
    status: 'unknown',
    evidence: {
      frameworks: [],
      configFiles: [],
      queryCandidates: [],
      correlationCandidates: [],
    },
    contract: {
      frameworks: [],
      configFiles: [],
      sources: [],
      queries: [],
      correlationFields: [],
      verification: [],
    },
  };
}

function sanitizeLogging(logging, targetDir) {
  const source = logging ?? emptyLoggingBaseline();
  const sanitizeValues = (values) => (values ?? []).map((value) => redactProjectPath(value, targetDir));
  return stableObject({
    status: source.status ?? 'unknown',
    evidence: {
      frameworks: sanitizeValues(source.evidence?.frameworks),
      configFiles: sanitizeValues(source.evidence?.configFiles),
      queryCandidates: sanitizeValues(source.evidence?.queryCandidates),
      correlationCandidates: sanitizeValues(source.evidence?.correlationCandidates),
    },
    contract: {
      frameworks: sanitizeValues(source.contract?.frameworks),
      configFiles: sanitizeValues(source.contract?.configFiles),
      sources: sanitizeValues(source.contract?.sources),
      queries: sanitizeValues(source.contract?.queries),
      correlationFields: sanitizeValues(source.contract?.correlationFields),
      verification: sanitizeValues(source.contract?.verification),
    },
  });
}

function normalizeComparableBaseline(baseline) {
  return {
    ...baseline,
    project: {
      ...baseline.project,
      logging: baseline.project?.logging ?? emptyLoggingBaseline(),
    },
  };
}

function sanitizeVerification(commandStatus, results, targetDir, verify) {
  const commands = {};
  for (const name of ['lint', 'typecheck', 'test', 'eval']) {
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

function createRecommendations({ profile, tools, verification, vcs }) {
  const recommendations = [];
  for (const [name, command] of Object.entries(verification.commands)) {
    if (command.status === 'failed' || command.status === 'blocked') {
      recommendations.push({ code: `VERIFY_${name.toUpperCase()}_${command.status.toUpperCase()}`, message: `修复 ${name} 验证的 ${command.status} 状态后重新建立基线。`, priority: 'P0' });
    } else if (['manual', 'missing', 'not_configured'].includes(command.status)) {
      recommendations.push({ code: `VERIFY_${name.toUpperCase()}_${command.status.toUpperCase()}`, message: `在 vibe-harness.config.json 中补齐或确认 ${name} 验证命令。`, priority: 'P1' });
    }
  }
  for (const [id, tool] of Object.entries(tools)) {
    if (['degraded', 'pending-config'].includes(tool.status)) {
      recommendations.push({ code: `TOOL_${id.toUpperCase()}_${tool.status.replaceAll('-', '_').toUpperCase()}`, message: `处理 ${id} 的 ${tool.status} 状态后重新运行安装或 doctor。`, priority: 'P1' });
    }
  }
  if (verification.mode === 'static') {
    recommendations.push({ code: 'BASELINE_VERIFICATION_NOT_RUN', command: 'vibe-harness baseline --project <project> --verify --write', message: '执行项目验证并把结果纳入基线。', priority: 'P2' });
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
  const normalized = normalizeComparableBaseline(baseline);
  return {
    installation: normalized.installation,
    project: normalized.project,
    verification: normalized.verification,
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
  return `<!-- Generated by Vibe-Harness. Refresh with vibe-harness baseline; do not edit this managed file. -->
# 项目基线

- 生成时间：${baseline.generatedAt}
- 项目：${baseline.project.name}
- 技术栈：${baseline.project.stackSummary}
- Profile：${baseline.installation.profile}
- 工具插件：${baseline.installation.requestedPlugins.length ? baseline.installation.requestedPlugins.map((plugin) => `\`${plugin}\``).join('、') : '未选择'}
- 安装状态：${baseline.installation.status}
- 漂移状态：${baseline.drift.status}

## 项目事实

- 包管理器：${baseline.project.packageManager}
- 目录提示：${baseline.project.directoryGuidance}
- 版本控制：${baseline.project.vcs.kind}
- 工作区状态：${baseline.project.vcs.workingTreeStatus}
- 日志画像：${baseline.project.logging.status}
- 日志候选证据：${baseline.project.logging.evidence.frameworks.join('、') || '未发现实现'}；${baseline.project.logging.evidence.queryCandidates.join('、') || '未发现查询入口'}
- 日志项目契约：${baseline.project.logging.contract.sources.join('、') || '未声明来源'}；${baseline.project.logging.contract.queries.join('、') || '未声明查询'}；${baseline.project.logging.contract.verification.join('、') || '未声明验证'}

## 工具状态

${toolLines.length ? toolLines.join('\n') : '- 当前安装未选择项目内工具插件。'}

## 验证状态

- 模式：${baseline.verification.mode}
- 结果：${baseline.verification.status}
${commandLines.join('\n')}

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
    schemaVersion: 2,
    generatedAt: now.toISOString(),
    project: {
      name: singleLine(config.projectName),
      packageManager: singleLine(projectProfile.packageManager),
      stackSummary: singleLine(projectProfile.stackSummary),
      directoryGuidance: singleLine(projectProfile.directoryGuidance),
      logging: sanitizeLogging(projectProfile.logging, targetDir),
      vcs: {
        kind: singleLine(vcs.kind),
        workingTreeStatus: vcs.workingTreeStatus,
      },
    },
    installation: {
      managedFileCount: target.expected.length,
      profile: config.profile,
      requestedPlugins: installState.requestedPlugins ?? [],
      resolvedModules: installState.resolvedModules ?? [],
      status: 'consistent',
      tools: publicToolStates,
      version: installState.version,
    },
    verification,
    recommendations: createRecommendations({ profile: config.profile, tools: publicToolStates, verification, vcs }),
    drift: { changes: [], status: 'initial' },
  };
  const previous = await readPreviousBaseline(targetDir, installState, baselineTarget);
  if ([1, 2].includes(previous?.schemaVersion)) {
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
    throw baselineError('BASELINE_INSTALL_INVALID', 'Project installation is missing or inconsistent; run vibe-harness install and validate before baseline.');
  }
  const [commandStatus, tools] = await Promise.all([
    inspectValidationCommands({ commands: validationCommands, targetDir }),
    inspectProfileTools(config.profile, targetDir, installState.resolvedModules, undefined, {
      allowPreview: true,
    }),
  ]);
  return { commandStatus, installState, tools };
}
