import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { assertInsideDir, assertPortableRelativePath } from './manifest.js';
import { sanitizeEvalValue, scoreCase } from './eval-scoring.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_LIMIT = 1024 * 1024;
const CREDENTIAL_ERROR = /\b(?:api[-_ ]?key|auth(?:entication|orization)?|credentials?|login|unauthorized)\b/iu;

function splitCommand(command) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|([^\s]+)/gu;
  for (const match of command.matchAll(pattern)) tokens.push(match[1] ?? match[2] ?? match[3]);
  if (tokens.length === 0) throw new Error('Evaluation runner command is empty.');
  return tokens;
}

async function createWorkspace(definition) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'loopengine-eval-case-'));
  for (const file of definition.input.fixture?.files ?? []) {
    assertPortableRelativePath(file.path, 'evaluation fixture file');
    const target = path.resolve(workspace, file.path);
    assertInsideDir(workspace, target, 'evaluation fixture file');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, 'utf8');
  }
  return workspace;
}

function validateObservation(value, caseId, governanceHash) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'runner output must be an object';
  if (value.schemaVersion !== 1) return 'runner output schemaVersion must be 1';
  if (value.caseId !== caseId) return 'runner output caseId does not match request';
  if (value.governanceHash !== governanceHash) return 'runner output governanceHash does not match request';
  for (const field of ['runner', 'model', 'agentVersion', 'governanceHash', 'output']) {
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
    tokens = splitCommand(command);
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
      env: process.env,
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
        terminateChildTree(child);
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
        observation = JSON.parse(text);
      } catch {
        return finish({ code: 'EVAL_RUNNER_INVALID_OUTPUT', diagnostic: 'runner stdout must contain exactly one JSON object' });
      }
      const error = validateObservation(observation, request.case.id, request.governanceHash);
      if (error) return finish({ code: 'EVAL_RUNNER_INVALID_OUTPUT', diagnostic: error });
      return finish({
        observation,
        process: { exitCode: exitCode ?? 1, signal: signal ?? null },
        stderr: stderr.toString('utf8'),
      });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChildTree(child);
    }, timeoutMs);
    child.stdin.end(JSON.stringify(request));
  });
}

function terminateChildTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

export async function runEvaluationCase({ command, definition, governanceHash = 'fixture-v1', repetition = 1, runId = 'online', timeoutMs = DEFAULT_TIMEOUT_MS }) {
  let workspace;
  let report;
  try {
    workspace = await createWorkspace(definition);
    const request = {
      schemaVersion: 1,
      runId,
      repetition,
      workspace,
      governanceHash,
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
      const caseResult = scoreCase({ definition, observation: result.observation });
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
        code: 'EVAL_WORKSPACE_CLEANUP_FAILED',
        diagnostics: sanitizeEvalValue([error.message]),
        status: 'degraded',
        workspace,
      };
    }
  }
  return report;
}
