import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_OUTPUT_BYTES = 16 * 1024;
const REWRITE_TIMEOUT_MS = 750;
const PROJECT_RUNNER = '.agents/runtime/tools/rtk/run.mjs';
const RETRY_PREFIX = `node "${PROJECT_RUNNER}"`;
const INVALID_STATE = Symbol('invalid-rtk-state');
const shellToolPattern = /(?:bash|shell|powershell|terminal)/iu;
const bypassPattern = /(?:\.agents[\\/]runtime[\\/]tools[\\/]rtk[\\/]run\.mjs|(?:^|[;&|]\s*)rtk(?:\.exe)?\s+proxy\b)/iu;
const sensitivePattern = /(?:^|[;&|]\s*)(?:env|printenv|set)\b|(?:\.env(?:\.|\b)|API[_-]?KEY|TOKEN|SECRET|PASSWORD)|Authorization\s*:/iu;
const rawOutputPattern = /(?:^|[;&|]\s*)(?:cat|type|Get-Content|tail|journalctl)\b|\b(?:docker|kubectl)\s+logs\b/iu;

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return INVALID_STATE;
  }
}

export async function inspectRtkHook(rootDir, { enabled = false } = {}) {
  if (!enabled) return { enabled: false, status: 'disabled', reason: 'RTK hooks are disabled.' };
  const canonical = path.join(rootDir, '.vibe-harness', 'tool-state', 'tools.json');
  const canonicalState = await readJson(canonical);
  if (canonicalState === INVALID_STATE) {
    return { enabled: true, status: 'degraded', reason: 'RTK tool state is invalid.' };
  }
  const state = canonicalState?.tools?.rtk;
  if (state?.status !== 'ready') {
    const status = state?.status ?? 'degraded';
    return { enabled: true, status, reason: `RTK tool state is ${state?.status ?? 'missing'}.` };
  }
  if (state.version !== '0.45.0') {
    return { enabled: true, status: 'degraded', reason: `RTK version ${state.version ?? 'missing'} is not the validated 0.45.0 release.` };
  }
  const runner = path.join(rootDir, PROJECT_RUNNER);
  const binary = path.join(
    rootDir,
    '.agents', 'runtime', 'tools', 'rtk', 'bin',
    process.platform === 'win32' ? 'rtk.exe' : 'rtk',
  );
  if (!(await exists(runner))) return { enabled: true, status: 'degraded', reason: 'Project-local RTK runner is missing.' };
  if (!(await exists(binary))) return { enabled: true, status: 'degraded', reason: 'Project-local RTK binary is missing.' };
  return {
    binary,
    enabled: true,
    reason: 'Project-local RTK 0.45.0 is ready.',
    runner,
    status: 'ready',
  };
}

export async function runRtkRewrite(binary, command, {
  cwd = process.cwd(),
  maxOutputBytes = MAX_OUTPUT_BYTES,
  timeoutMs = REWRITE_TIMEOUT_MS,
} = {}) {
  const { prepareRtkRuntimeEnvironment } = await import('../../lib/rtk-environment.mjs');
  const env = await prepareRtkRuntimeEnvironment(cwd, process.env);
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(binary, ['rewrite', command], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
    });
    const append = (current, chunk) => (current + chunk).slice(0, maxOutputBytes);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk); });
    let timer;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stderr, stdout, timedOut });
    };
    child.once('error', () => finish(null));
    child.once('close', finish);
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(null);
    }, timeoutMs);
    timer.unref?.();
  });
}

function projectRetryCommand(rewritten, original) {
  const normalized = rewritten.trim();
  if (!normalized || /[\r\n]/u.test(normalized)) return null;
  if (!/^rtk(?:\.exe)?\s+[^;&|]+(?:\s*(?:&&|\|\||;|\|)\s*rtk(?:\.exe)?\s+[^;&|]+)*$/iu.test(normalized)) {
    return null;
  }
  let replacements = 0;
  let restored = normalized;
  const converted = normalized.replace(/(^|(?:&&|\|\||;|\|)\s*)rtk(?:\.exe)?\s+/giu, (match, prefix) => {
    replacements += 1;
    return `${prefix}${RETRY_PREFIX} `;
  });
  restored = restored.replace(/(^|(?:&&|\|\||;|\|)\s*)rtk(?:\.exe)?\s+/giu, '$1');
  return replacements > 0 && restored === original.trim() ? converted : null;
}

export async function routeRtkCommand(input, {
  mode = 'guarded',
  projectRoot,
  rtk,
  runner = runRtkRewrite,
} = {}) {
  const toolInput = input.toolInput ?? input.tool_input;
  const command = typeof toolInput?.command === 'string' ? toolInput.command.trim() : '';
  if (!rtk?.enabled || rtk.status !== 'ready' || !command || !shellToolPattern.test(input.toolName ?? input.tool_name ?? '')) {
    return { action: 'allow' };
  }
  if (bypassPattern.test(command) || sensitivePattern.test(command) || rawOutputPattern.test(command)) {
    return { action: 'allow' };
  }
  let result;
  try {
    result = await runner(rtk.binary, command, {
      cwd: projectRoot,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      timeoutMs: REWRITE_TIMEOUT_MS,
    });
  } catch {
    return { action: 'allow' };
  }
  const stdout = String(result?.stdout ?? '').trim();
  if (result?.timedOut || (result?.code === 1 && !stdout)) return { action: 'allow' };
  if (![0, 3].includes(result?.code) || !stdout) return { action: 'allow' };
  const retryCommand = projectRetryCommand(stdout, command);
  if (!retryCommand) return { action: 'allow' };
  const reason = `RTK can reduce this command's output. Use this exact retry command: ${retryCommand}`;
  return {
    action: mode === 'guarded' ? 'deny' : 'warn',
    reason,
    retryCommand,
  };
}

export function rtkSessionContext(state) {
  if (!state?.enabled) return 'RTK hook: disabled.';
  if (state.status !== 'ready') return `RTK hook: ${state.status}. ${state.reason} Use the original command.`;
  return [
    'RTK hook: ready.',
    `Project entry: ${RETRY_PREFIX}.`,
    `For complete raw output, use ${RETRY_PREFIX} proxy <command> [args...].`,
  ].join(' ');
}
