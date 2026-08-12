import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { pathExists } from './manifest.js';
import { evaluateHook, HOOK_FAILURE_CODES } from '../../runtime/hooks/codex-hook.mjs';

const execFileAsync = promisify(execFile);
const hookConfigTargets = {
  codex: '.codex/hooks.json',
};

function hookConfigTarget(adapter) {
  return adapter.projectConfig?.hooks?.target || hookConfigTargets[adapter.id] || null;
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

function selfCheckMatchesMode(adapterId, result, hookMode) {
  if (hookMode === 'observe') {
    if (adapterId === 'cursor') return result?.continue === true && typeof result?.additionalContext === 'string';
    if (adapterId === 'antigravity') return result?.decision === 'ask';
    return typeof result?.hookSpecificOutput?.additionalContext === 'string';
  }
  if (adapterId === 'cursor') return result?.continue === false;
  if (adapterId === 'antigravity') return result?.decision === 'deny';
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

export async function inspectRuntimeHookSelfCheck(adapter, targetDir, { configured, hookMode } = {}) {
  if (adapter.hookActivation === 'unsupported') {
    return { status: 'unsupported', code: 'HOOK_SELF_CHECK_UNSUPPORTED' };
  }
  if (!configured) return { status: 'not-installed', code: 'HOOK_SELF_CHECK_NOT_INSTALLED' };
  if (hookMode === 'off') return { status: 'disabled', code: 'HOOK_SELF_CHECK_DISABLED' };
  try {
    const result = await evaluateHook(selfCheckPayload(adapter.id, targetDir), {
      expectedEvent: 'PreToolUse',
      host: adapter.id,
    });
    return selfCheckMatchesMode(adapter.id, result, hookMode)
      ? { status: 'pass', code: 'HOOK_SELF_CHECK_PASSED' }
      : { status: 'degraded', code: 'HOOK_SELF_CHECK_NOT_DENIED' };
  } catch (error) {
    const stableCodes = new Set(Object.values(HOOK_FAILURE_CODES));
    return { status: 'degraded', code: stableCodes.has(error?.code) ? error.code : 'HOOK_SELF_CHECK_FAILED' };
  }
}

export async function inspectRuntimeHooks(adapter, targetDir, { selfCheck = false, hookMode } = {}) {
  const configTarget = hookConfigTarget(adapter);
  const configured = Boolean(configTarget && await pathExists(path.join(targetDir, configTarget)));
  const mechanism = adapter.hookActivation;
  let status = 'unknown';
  let verification = configTarget
    ? 'Confirm that the host loaded ' + configTarget + ' for this project.'
    : 'No project Hook configuration is installed.';
  if (mechanism === 'unsupported') {
    status = 'unsupported';
    verification = 'This host does not support Vibe-Harness runtime Hooks.';
  } else if (mechanism === 'manual-trust') {
    status = 'unknown';
    verification = 'Run /hooks in Codex and verify the current project Hook definitions are trusted.';
  } else if (configured) {
    status = 'configured-unverified';
  }
  const report = {
    configured,
    declaredEvents: { ...adapter.hookEvents },
    pathResolution: 'git-root',
    activation: { mechanism, status, verification },
  };
  if (selfCheck) report.selfCheck = await inspectRuntimeHookSelfCheck(adapter, targetDir, { configured, hookMode });
  return report;
}

export function runtimeHookWarnings(runtimeHooks) {
  const warnings = [];
  if (runtimeHooks.configured && runtimeHooks.activation.status !== 'unsupported') {
    warnings.push({
      code: 'HOOK_ACTIVATION_UNVERIFIED',
      message: runtimeHooks.activation.verification,
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
