import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { assertInsideDir, assertPortableRelativePath } from './manifest.js';
import { safeJsonParse } from './safe-json.js';
import { assertSafeCommand } from './shell-command.js';
import { terminateProcessTree } from './process-tree.js';
import { sanitizeEvalValue, scoreCase } from './eval-scoring.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_LIMIT = 1024 * 1024;
const CREDENTIAL_ERROR = /\b(?:api[-_ ]?key|auth(?:entication|orization)?|credentials?|login|unauthorized)\b/iu;
const evaluationEnvironmentNames = new Set([
  'ALL_PROXY', 'ANTHROPIC_API_KEY', 'APPDATA', 'AZURE_OPENAI_API_KEY', 'CODEX_CLI_VERSION',
  'CODEX_HOME', 'CODEX_MODEL', 'COMSPEC', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'HOME',
  'HTTPS_PROXY', 'HTTP_PROXY', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOCALAPPDATA',
  'CODEX_REASONING_EFFORT', 'VIBE_HARNESS_CODEX_COMMAND', 'VIBE_HARNESS_EVAL_AUTH_FILE', 'VIBE_HARNESS_EVAL_CODEX_BACKEND',
  'VIBE_HARNESS_EVAL_PROVIDER_NAME', 'VIBE_HARNESS_EVAL_PROVIDER_REQUIRES_AUTH', 'VIBE_HARNESS_EVAL_PROVIDER_WIRE_API',
  'VIBE_HARNESS_EVAL_RUNTIME_SOURCE', 'VIBE_HARNESS_EVAL_TRUST_PROJECT_HOOKS', 'VIBE_HARNESS_WSL_CODEX_COMMAND',
  'NO_PROXY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'PATH', 'Path',
  'PATHEXT', 'PROGRAMDATA', 'ProgramData', 'SHELL', 'SSL_CERT_DIR', 'SSL_CERT_FILE', 'SystemRoot',
  'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'WINDIR', 'all_proxy', 'https_proxy', 'http_proxy',
  'no_proxy',
]);

function evaluationEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => evaluationEnvironmentNames.has(name)));
}

async function createWorkspace(definition) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'vibe-harness-eval-case-'));
  for (const relative of definition.input.fixture?.allowedWritePaths ?? []) {
    assertPortableRelativePath(relative, 'evaluation allowed write path');
    assertInsideDir(workspace, path.resolve(workspace, relative), 'evaluation allowed write path');
  }
  for (const file of definition.input.fixture?.files ?? []) {
    assertPortableRelativePath(file.path, 'evaluation fixture file');
    const target = path.resolve(workspace, file.path);
    assertInsideDir(workspace, target, 'evaluation fixture file');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, 'utf8');
  }
  return workspace;
}

function validateObservation(value, caseId, configHash) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'runner output must be an object';
  if (value.schemaVersion !== 1) return 'runner output schemaVersion must be 1';
  if (value.caseId !== caseId) return 'runner output caseId does not match request';
  if (value.configHash !== configHash) return 'runner output configHash does not match request';
  for (const field of ['runner', 'model', 'agentVersion', 'configHash', 'output']) {
    if (typeof value[field] !== 'string') return `runner output ${field} must be a string`;
  }
  for (const field of ['events', 'artifacts', 'diagnostics']) {
    if (!Array.isArray(value[field]) || value[field].some((item) => typeof item !== 'string')) {
      return `runner output ${field} must be a string array`;
    }
  }
  if (!Number.isInteger(value.exitCode) || value.exitCode < 0) return 'runner output exitCode must be a non-negative integer';
  return null;
}

function executeRunner({ command, request, timeoutMs }) {
  let tokens;
  try {
    tokens = assertSafeCommand(command);
  } catch (error) {
    return Promise.resolve({ code: 'EVAL_RUNNER_UNAVAILABLE', diagnostic: error.message });
  }
  const [program, ...args] = tokens;
  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    let overflow = false;
    const child = spawn(program, args, {
      cwd: request.workspace,
      detached: process.platform !== 'win32',
      env: evaluationEnvironment(process.env),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const append = (current, chunk) => {
      const next = Buffer.concat([current, chunk]);
      if (next.length > OUTPUT_LIMIT) {
        overflow = true;
        void terminateProcessTree(child);
      }
      return next.subarray(0, OUTPUT_LIMIT);
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => finish({ code: 'EVAL_RUNNER_UNAVAILABLE', diagnostic: error.message }));
    child.on('close', (exitCode, signal) => {
      if (timedOut) return finish({ code: 'EVAL_RUNNER_TIMEOUT', diagnostic: `runner timed out after ${timeoutMs}ms` });
      if (overflow) return finish({ code: 'EVAL_RUNNER_OUTPUT_LIMIT', diagnostic: 'runner output exceeded 1 MiB' });
      const text = stdout.toString('utf8').trim();
      if (!text && exitCode === 2) {
        const diagnostic = stderr.toString('utf8') || 'runner unavailable';
        return finish({
          code: CREDENTIAL_ERROR.test(diagnostic)
            ? 'EVAL_RUNNER_CREDENTIALS_MISSING'
            : 'EVAL_RUNNER_UNAVAILABLE',
          diagnostic,
        });
      }
      let observation;
      try {
        observation = safeJsonParse(text);
      } catch {
        return finish({ code: 'EVAL_RUNNER_INVALID_OUTPUT', diagnostic: 'runner stdout must contain exactly one JSON object' });
      }
      const error = validateObservation(observation, request.case.id, request.configHash);
      if (error) return finish({ code: 'EVAL_RUNNER_INVALID_OUTPUT', diagnostic: error });
      return finish({
        observation,
        process: { exitCode: exitCode ?? 1, signal: signal ?? null },
        stderr: stderr.toString('utf8'),
      });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child);
    }, timeoutMs);
    child.stdin.end(JSON.stringify(request));
  });
}

export async function runEvaluationCase({ command, definition, configHash = 'fixture-v1', repetition = 1, runId = 'online', timeoutMs = DEFAULT_TIMEOUT_MS, judge }) {
  let workspace;
  let report;
  try {
    workspace = await createWorkspace(definition);
    const request = {
      schemaVersion: 1,
      runId,
      repetition,
      workspace,
      configHash,
      case: definition,
    };
    const result = await executeRunner({ command, request, timeoutMs });
    if (!result.observation) {
      report = {
        code: result.code,
        diagnostics: sanitizeEvalValue([result.diagnostic]),
        status: 'degraded',
        workspace,
      };
    } else {
      const caseResult = await scoreCase({ definition, observation: result.observation, judge });
      report = {
        caseResult,
        diagnostics: sanitizeEvalValue([
          ...result.observation.diagnostics,
          ...(result.stderr ? [result.stderr] : []),
        ]),
        observation: sanitizeEvalValue(result.observation),
        process: result.process,
        status: 'ready',
        workspace,
      };
    }
  } catch (error) {
    report = {
      code: 'EVAL_FIXTURE_INVALID',
      diagnostics: sanitizeEvalValue([error.message]),
      status: 'degraded',
      workspace,
    };
  }
  if (workspace) {
    try {
      await rm(workspace, { force: true, maxRetries: 20, recursive: true, retryDelay: 250 });
    } catch (error) {
      return {
        ...report,
        cleanupWarning: sanitizeEvalValue([error.message]),
        workspace,
      };
    }
  }
  return report;
}
