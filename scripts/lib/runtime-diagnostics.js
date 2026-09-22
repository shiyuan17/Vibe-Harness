import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { pathExists } from './manifest.js';
import { readHostHookState } from './host-hook-state.js';
import { hashFile } from './install-state.js';
import { evaluateHook, HOOK_FAILURE_CODES } from '../../runtime/hooks/codex-hook.mjs';

const execFileAsync = promisify(execFile);
const hookConfigTargets = {
  codex: '.codex/hooks.json',
};
// The managed hook entrypoint doubles as the hooks-group sentinel: preview and
// multi-target installs land it on disk even for hosts that can never load it.
const runtimeHookEntryPath = '.agents/runtime/hooks/codex-hook.mjs';

/**
 * User-facing text for each host Hook trust state. The reasonCode stays the
 * machine contract; the sentence only has to be actionable.
 */
const MANUAL_TRUST_VERIFICATION = {
  'trusted-disabled': '本项目 Hook 已在宿主侧停用（hooks.state enabled=false），安全策略当前不生效；请在 Codex 中用 /hooks 或宿主配置重新启用后再复跑 doctor。',
  'trusted-enabled': '本项目 Hook 已被宿主信任，但仍没有证据表明宿主已加载它；请保留本次结论为 configured-unverified。',
  'untrusted': '宿主没有本项目的 Hook 信任记录，安全策略当前不生效；请在 Codex 中运行 /hooks 信任当前项目的 Hook 定义。',
  'unknown': '无法读取宿主 Hook 信任状态；请在 Codex 中运行 /hooks 复核当前项目的 Hook 定义。',
};

export const HOOK_COVERAGE_LIMITATIONS = [
  'Command-string inspection is heuristic and does not cover arbitrary PowerShell, Python, Node.js, package-manager, or Git network behavior.',
  'Project files cannot prove that the host loaded or trusted the installed Hook configuration.',
  'Host sandbox, approval policy, process isolation, and network proxy enforcement require independent host-level verification.',
];

export function hookConfigTarget(adapter) {
  return adapter.projectConfig?.hooks?.target || hookConfigTargets[adapter.id] || null;
}

/** Absolute path of the adapter's installed Hook definition, if it has one. */
export function hookDefinitionPath(adapter, targetDir) {
  const relativeTarget = hookConfigTarget(adapter);
  return relativeTarget ? path.join(targetDir, relativeTarget) : null;
}

/**
 * True when the installed Hook definition no longer matches the hash the
 * installer recorded for it. The host keys its own trust record on the
 * definition text, so a definition that changed after the recorded install
 * (edited by hand, or rendered by a newer pack) may require re-trusting before
 * the safety policy applies again.
 *
 * The host's own hash algorithm is not reproducible from the project, so this
 * stays a "may require re-trust" signal: it never claims causality, and it is
 * silent when there is no install record or no installed definition to compare.
 *
 * @param {any} adapter
 * @param {string} targetDir
 * @param {any} installState
 * @returns {Promise<boolean>}
 */
export async function hookDefinitionDrift(adapter, targetDir, installState) {
  const relativeTarget = hookConfigTarget(adapter);
  if (!relativeTarget || !Array.isArray(installState?.files)) return false;
  const record = installState.files.find((file) => file.target === relativeTarget);
  if (!record?.targetHash) return false;
  const installed = path.join(targetDir, relativeTarget);
  if (!await pathExists(installed)) return false;
  return await hashFile(installed) !== record.targetHash;
}

function selfCheckPayload(adapterId, targetDir) {
  const outsidePath = path.resolve(targetDir, '..', '.vibe-harness-hook-self-check');
  if (adapterId === 'antigravity') {
    return {
      toolCall: { name: 'write_file', args: { path: outsidePath } },
      workspacePaths: [targetDir],
    };
  }
  return {
    cwd: targetDir,
    hook_event_name: 'PreToolUse',
    session_id: 'hook-self-check',
    tool_input: { file_path: outsidePath },
    tool_name: 'Write',
  };
}

function selfCheckDenied(adapterId, result) {
  if (adapterId === 'cursor') return result?.continue === false;
  if (adapterId === 'antigravity') return result?.decision === 'deny';
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

/** @param {any} adapter @param {string} targetDir @param {{configured?: boolean}} options */
export async function inspectRuntimeHookSelfCheck(adapter, targetDir, { configured } = {}) {
  if (adapter.hookActivation === 'unsupported') {
    return { status: 'unsupported', code: 'HOOK_SELF_CHECK_UNSUPPORTED' };
  }
  if (!configured) return { status: 'not-installed', code: 'HOOK_SELF_CHECK_NOT_INSTALLED' };
  try {
    const result = await evaluateHook(selfCheckPayload(adapter.id, targetDir), {
      expectedEvent: 'PreToolUse',
      host: adapter.id,
    });
    return selfCheckDenied(adapter.id, result)
      ? { status: 'pass', code: 'HOOK_SELF_CHECK_PASSED' }
      : { status: 'degraded', code: 'HOOK_SELF_CHECK_NOT_DENIED' };
  } catch (error) {
    const stableCodes = new Set(Object.values(HOOK_FAILURE_CODES));
    return { status: 'degraded', code: stableCodes.has(error?.code) ? error.code : 'HOOK_SELF_CHECK_FAILED' };
  }
}

/**
 * @param {any} adapter
 * @param {string} targetDir
 * @param {{hostEvidence?: Record<string, any>, hostHookState?: Record<string, any> | null, selfCheck?: boolean}} options
 */
export async function inspectRuntimeHooks(adapter, targetDir, { hostEvidence = {}, hostHookState = null, selfCheck = false } = {}) {
  const configTarget = hookConfigTarget(adapter);
  const configured = Boolean(configTarget && await pathExists(path.join(targetDir, configTarget)));
  const filesInstalled = await pathExists(path.join(targetDir, runtimeHookEntryPath));
  const mechanism = adapter.hookActivation;
  const supported = mechanism !== 'unsupported';
  // Host trust is recorded outside the project, so it can only be read, never
  // inferred from project files (see readHostHookState for the field contract).
  const trustState = mechanism === 'manual-trust'
    ? (hostHookState ?? await readHostHookState({ adapterId: adapter.id, projectDir: targetDir }))
    : null;
  let status = 'unknown';
  let verification = configTarget
    ? 'Confirm that the host loaded ' + configTarget + ' for this project.'
    : 'No project Hook configuration is installed.';
  if (mechanism === 'unsupported') {
    status = 'unsupported';
    verification = 'This host does not support Vibe-Harness runtime Hooks.';
  } else if (mechanism === 'manual-trust') {
    status = Object.hasOwn(MANUAL_TRUST_VERIFICATION, trustState?.status) ? trustState.status : 'unknown';
    verification = MANUAL_TRUST_VERIFICATION[status];
  } else if (configured) {
    status = 'configured-unverified';
  }
  const authority = adapter.executionAuthority || {
    envelopeVersions: [],
    goalLifecycle: 'unsupported',
    highRiskEnforcement: 'unsupported',
    projectConfigMayAuthorize: false,
    trustedSource: 'none',
  };
  // A host with no declared execution envelope cannot enforce the runtime Hook
  // policy no matter what is installed, so the report states that explicitly
  // instead of leaving it implicit in executionAuthority.
  const envelopeDegraded = authority.envelopeVersions.length === 0
    || authority.highRiskEnforcement === 'unsupported';
  const activated = supported && hostEvidence.activated === true ? true : (supported ? null : false);
  const hostContextVerified = ['sandbox', 'approval', 'process', 'network']
    .every((field) => hostEvidence[field] === true);
  const envelopeRequired = hostEvidence.envelopeRequired === true;
  const enforced = configured
    && activated === true
    && envelopeRequired
    && hostContextVerified
    && authority.highRiskEnforcement === 'host-required';
  if (activated === true) {
    status = 'verified';
    verification = 'Host evidence confirms the Hook is activated for this project.';
  }
  const report = {
    activated,
    configured,
    coverageLimitations: [...HOOK_COVERAGE_LIMITATIONS],
    declaredEvents: { ...adapter.hookEvents },
    enforced,
    envelopeSupport: {
      degraded: envelopeDegraded,
      highRiskEnforcement: authority.highRiskEnforcement,
      versions: [...authority.envelopeVersions],
    },
    executionAuthority: {
      ...authority,
      envelopeRequired,
      hostContextVerified,
    },
    filesInstalled,
    host: adapter.id,
    pathResolution: 'git-root',
    status: enforced ? 'enforced' : (!supported ? 'unsupported' : (!configured ? 'not-configured' : 'configured-unverified')),
    supported,
    activation: { mechanism, status, verification },
    hostHookState: trustState
      ? {
          configPath: trustState.configPath,
          entries: { ...trustState.entries },
          reason: trustState.reason,
          status: trustState.status,
        }
      : null,
  };
  if (selfCheck) report.selfCheck = await inspectRuntimeHookSelfCheck(adapter, targetDir, { configured });
  return report;
}

/**
 * @param {any} runtimeHooks
 * @param {{definitionChanged?: boolean, enforcementPolicy?: string}} [options]
 * `definitionChanged` carries the caller's own comparison of the Hook
 * definition before and after the current operation (an install that rewrites
 * the definition), because the post-install record already matches the new
 * file. `enforcementPolicy` mirrors the project's hooks.enforcement setting:
 * under "strict" the unproven-enforcement warning is marked blocking and
 * callers downgrade their success status instead of treating it as advisory.
 */
export function runtimeHookWarnings(runtimeHooks, { definitionChanged = false, enforcementPolicy = 'advisory' } = {}) {
  const warnings = [];
  if (runtimeHooks.envelopeSupport?.degraded) {
    warnings.push({
      code: 'ENVELOPE_UNSUPPORTED',
      message: 'This host declares no high-risk execution envelope (envelopeVersions is empty and highRiskEnforcement is unsupported), so runtime red-zone, egress, and credential policies cannot be enforced here; high-risk operations rely on host-native approval and human review only.',
    });
  }
  if (runtimeHooks.supported === false && runtimeHooks.filesInstalled) {
    // The hooks group can be on disk for a host that can never load it (a
    // preview install, or a multi-target project where another host owns the
    // files); name that host instead of letting the files read as an active
    // policy.
    warnings.push({
      code: 'HOOK_ACTIVATION_UNSUPPORTED',
      message: runtimeHooks.host + ' 的 Hook 机制不被支持：Hook 文件仅随安装落盘、不会被该宿主激活；红区与凭据策略依赖宿主原生审批与人工复核。',
    });
  }
  if (definitionChanged
    && runtimeHooks.configured
    && runtimeHooks.activation.status === 'trusted-enabled') {
    warnings.push({
      code: 'HOOK_TRUST_REREVIEW_REQUIRED',
      message: '已安装的 Hook 定义与宿主信任的那份不同（本次安装或手工改写改动了定义文本），宿主可能要求重新信任；请在 Codex 中运行 /hooks 复核并启用当前定义。',
    });
  }
  const disabled = runtimeHooks.configured && runtimeHooks.activation.status === 'trusted-disabled';
  if (disabled) {
    // The host records the Hook as trusted but switched off: that is a sharper
    // statement than "activation unverified", so it replaces it instead of
    // stacking a second warning about the same condition.
    warnings.push({
      code: 'HOOK_DISABLED',
      message: runtimeHooks.activation.verification,
    });
  } else if (runtimeHooks.configured && !['unsupported', 'verified'].includes(runtimeHooks.activation.status)) {
    warnings.push({
      code: 'HOOK_ACTIVATION_UNVERIFIED',
      message: runtimeHooks.activation.verification,
    });
  }
  if (runtimeHooks.configured && !runtimeHooks.enforced) {
    const strict = enforcementPolicy === 'strict';
    warnings.push({
      code: 'HOOK_ENFORCEMENT_UNVERIFIED',
      message: strict
        ? 'hooks.enforcement is "strict" and Hook enforcement is not proven for this project, so this command reports a degraded status; verify the host sandbox, approval policy, process isolation, and network proxy (or re-run with --allow-degraded) before relying on the Hook policy.'
        : 'Hook policy is defense in depth only; verify the host sandbox, approval policy, process isolation, and network proxy before treating it as enforced.',
      ...(strict ? { blocking: true } : {}),
    });
  }
  if (runtimeHooks.selfCheck?.status === 'degraded') {
    warnings.push({
      code: 'HOOK_SELF_CHECK_DEGRADED',
      message: 'The project Hook self-check did not produce the expected fail-closed decision.',
    });
  }
  return warnings;
}

/**
 * First blocking Hook warning, or null when every warning is advisory. Under
 * hooks.enforcement "strict" a blocking warning must downgrade the command's
 * success status even when every other check passed.
 *
 * @param {any[]} [warnings]
 */
export function blockingHookWarning(warnings = []) {
  return warnings.find((warning) => warning?.blocking === true) ?? null;
}

function extractField(content, labels) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const match = content.match(new RegExp('^\\s*-\\s*' + escaped + '\\s*:\\s*(.*?)\\s*$', 'imu'));
    if (match) return match[1].trim();
  }
  return null;
}

function parseDate(value) {
  if (!value || value.includes('YYYY-MM-DD')) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return Number.NaN;
  const parsed = new Date(value + 'T00:00:00.000Z');
  if (Number.isNaN(parsed.getTime())) return Number.NaN;
  return parsed.toISOString().slice(0, 10) === value ? parsed : Number.NaN;
}

function hasMeaningfulFields(content, labels) {
  return labels.some((labelSet) => {
    const value = extractField(content, labelSet);
    return value !== null && value.length > 0;
  });
}

async function headCommitDate(targetDir) {
  try {
    const result = await execFileAsync('git', ['log', '-1', '--format=%cI'], { cwd: targetDir, windowsHide: true });
    const value = result.stdout.trim();
    return value ? new Date(value) : null;
  } catch {
    return null;
  }
}

async function inspectMemoryFile({ contentLabels, dateLabels, installed, maxAgeDays, relativePath, targetDir, headDate }) {
  if (!installed) return { path: relativePath, status: 'not-installed' };
  const absolutePath = path.join(targetDir, relativePath);
  if (!(await pathExists(absolutePath))) return { path: relativePath, status: 'missing' };
  let content;
  try {
    content = await readFile(absolutePath, 'utf8');
  } catch {
    return { path: relativePath, status: 'invalid' };
  }
  if (!content.trim()) return { path: relativePath, status: 'empty' };
  const dateValue = extractField(content, dateLabels);
  if ((!dateValue || dateValue.includes('YYYY-MM-DD')) && !hasMeaningfulFields(content, contentLabels)) {
    return { path: relativePath, status: 'empty' };
  }
  const date = parseDate(dateValue);
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return { path: relativePath, status: 'invalid' };
  }
  const ageMs = Date.now() - date.getTime();
  const staleByAge = ageMs > maxAgeDays * 24 * 60 * 60 * 1000;
  const staleByHead = headDate instanceof Date && dateValue < headDate.toISOString().slice(0, 10);
  return {
    date: dateValue,
    path: relativePath,
    status: staleByAge || staleByHead ? 'stale' : 'current',
  };
}

export async function inspectMemory(config, installState, targetDir) {
  const runtimePath = path.posix.join((config.memory?.path || '.agents/memory').replaceAll('\\', '/'), 'CURRENT.md');
  const durablePath = 'docs/memory/PROJECT_STATE.md';
  if (config.memory?.enabled === false) {
    return {
      runtime: { path: runtimePath, status: 'disabled' },
      durable: { path: durablePath, status: 'disabled' },
    };
  }
  const installedTargets = new Set((installState?.files || []).map((file) => file.target.replaceAll('\\', '/')));
  const headDate = await headCommitDate(targetDir);
  const runtime = await inspectMemoryFile({
    contentLabels: [['目标', 'Goal'], ['当前状态', 'Current status'], ['已验证证据', 'Verified evidence'], ['下一步最小动作', 'Next action']],
    dateLabels: ['最后验证', 'Last verified'],
    headDate,
    installed: installedTargets.has(runtimePath),
    maxAgeDays: 1,
    relativePath: runtimePath,
    targetDir,
  });
  const durable = await inspectMemoryFile({
    contentLabels: [['当前阶段', 'Current phase'], ['当前重点', 'Current focus'], ['下一步动作', 'Next action'], ['恢复提示', 'Resume hint']],
    dateLabels: ['最后更新', 'Last updated'],
    headDate: null,
    installed: installedTargets.has(durablePath),
    maxAgeDays: 30,
    relativePath: durablePath,
    targetDir,
  });
  return { runtime, durable };
}
