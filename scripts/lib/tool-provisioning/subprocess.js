import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { pathExists } from '../manifest.js';
import { productIdentity, readProductEnv } from '../product-identity.js';
import { terminateProcessTree } from '../process-tree.js';

const maxDiagnosticOutput = 8 * 1024;
const maxToolOutput = 1024 * 1024;
const execFileAsync = promisify(execFile);
const cognisVersion = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')).version;

function appendOutputTail(current, chunk) {
  const combined = `${current}${chunk.toString('utf8')}`;
  return combined.length > maxDiagnosticOutput ? combined.slice(-maxDiagnosticOutput) : combined;
}

export function toolCommandError(message, code, output, extra = {}) {
  return Object.assign(new Error(message), {
    code,
    outputTruncated: output.truncated,
    stderr: output.stderr,
    stdout: output.stdout,
    ...extra,
  });
}

function redactDiagnosticText(value, targetDir) {
  if (!value) return '';
  const projectPath = path.resolve(targetDir);
  const projectPaths = [projectPath, projectPath.replaceAll('\\', '/')];
  let redacted = String(value);
  for (const projectVariant of projectPaths) {
    const projectPattern = new RegExp(projectVariant.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'giu');
    redacted = redacted.replace(projectPattern, '<project>');
  }
  return redacted
    .replace(/(["'](?:api[-_]?key|password|secret|token)["']\s*:\s*["'])[^"']*(["'])/giu, '$1[REDACTED]$2')
    .replace(/\b((?:api[-_]?key|password|secret|token)=)[^\s/]+/giu, '$1[REDACTED]')
    .replace(/(^|\s)(--?(?:api[-_]?key|password|secret|token)(?:=|\s+))[^\s]+/giu, '$1$2[REDACTED]')
    .replace(/\b((?:api[-_]?key|password|secret|token)\s*:\s*)[^\s,}"']+/giu, '$1[REDACTED]')
    .replace(/\bBearer\s+[^\s]+/giu, 'Bearer [REDACTED]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/giu, '$1[REDACTED]@')
    .replace(/([?&](?:api[-_]?key|password|secret|token)=)[^&#\s]+/giu, '$1[REDACTED]')
    .trim();
}

function lastDiagnosticLine(...values) {
  for (const value of values) {
    const lines = value.split(/\r?\n/gu).map((line) => line.trim()).filter(Boolean);
    const usable = [...lines].reverse().filter((line) => !/^(?:npm (?:error )?A complete log of this run can be found in:|npm warn cleanup|You can install manually:|Try reinstalling:)/iu.test(line));
    const informative = usable.find((line) => /\b(?:error|failed|timeout|e(?:conn|timedout|not|perm|acces|pipe|exist|busy|ai_|host|addr|rr_)[a-z_]*)\b/iu.test(line));
    if (informative) return informative;
    if (usable.length > 0) return usable.at(-1);
    if (lines.length > 0) return lines.at(-1);
  }
  return '';
}

function diagnosticMessage(error, code, stderrTail, stdoutTail) {
  const outputMessage = lastDiagnosticLine(stderrTail, stdoutTail);
  if (outputMessage) return outputMessage;
  if (code === 'TOOL_TIMEOUT') return 'Tool command timed out.';
  if (code === 'TOOL_OUTPUT_LIMIT') return 'Tool command exceeded the output limit.';
  if (code === 'TOOL_START_FAILED' || code === 'MCP_START_FAILED') return 'Tool process could not start.';
  if (code === 'MCP_HANDSHAKE_TIMEOUT') return 'MCP handshake timed out.';
  if (code === 'MCP_STDIN_FAILED') return 'MCP process closed stdin during handshake.';
  if (code === 'INDEX_CORRUPT_REINDEX_REQUIRED') return 'Index database is corrupt; re-index is required.';
  if (code === 'INDEX_PATH_OUTSIDE_ALLOWED_ROOT') return 'Repository path is outside the allowed root.';
  return error?.message || 'Tool command failed.';
}

export function createDiagnostic(error, phase, targetDir) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code)
    ? error.code
    : 'TOOL_PROVISION_FAILED';
  const stderrTail = redactDiagnosticText(error?.stderr, targetDir);
  const stdoutTail = redactDiagnosticText(error?.stdout, targetDir);
  const diagnostic = {
    code,
    message: redactDiagnosticText(diagnosticMessage(error, code, stderrTail, stdoutTail), targetDir),
    phase,
    truncated: Boolean(error?.outputTruncated),
  };
  if (Number.isInteger(error?.exitCode)) diagnostic.exitCode = error.exitCode;
  if (stderrTail) diagnostic.stderrTail = stderrTail;
  if (stdoutTail) diagnostic.stdoutTail = stdoutTail;
  return diagnostic;
}

export async function runToolCommand({ args, command, cwd, env, signal, timeout = 120_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== 'win32',
      env,
      shell: false,
      windowsHide: true,
    });
    let outputSize = 0;
    let settled = false;
    const output = { stderr: '', stdout: '', truncated: false };
    const finish = async (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) await terminateProcessTree(child);
      if (error) reject(error);
      else resolve(output);
    };
    const abort = () => void finish(toolCommandError('Tool command was cancelled.', 'TOOL_CANCELLED', output));
    const timer = setTimeout(() => void finish(toolCommandError('Tool command timed out.', 'TOOL_TIMEOUT', output)), timeout);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const countOutput = (stream, chunk) => {
      outputSize += chunk.length;
      output[stream] = appendOutputTail(output[stream], chunk);
      if (outputSize > maxToolOutput) {
        output.truncated = true;
        void finish(toolCommandError('Tool command output limit exceeded.', 'TOOL_OUTPUT_LIMIT', output));
      }
    };
    child.stdout.on('data', (chunk) => countOutput('stdout', chunk));
    child.stderr.on('data', (chunk) => countOutput('stderr', chunk));
    child.once('error', () => void finish(toolCommandError('Tool command failed to start.', 'TOOL_START_FAILED', output)));
    child.once('close', (code) => {
      if (code === 0) void finish();
      else void finish(toolCommandError('Tool command failed.', 'TOOL_COMMAND_FAILED', output, { exitCode: code }));
    });
  });
}

export const defaultCommandRunner = runToolCommand;

export function boundedTimeout(env, fallback) {
  const timeoutLimit = Number.parseInt(readProductEnv(env, 'TOOL_TIMEOUT_MS').value ?? '', 10);
  return Number.isInteger(timeoutLimit) && timeoutLimit >= 1000
    ? Math.min(fallback, timeoutLimit)
    : fallback;
}

export async function npmInvocation(args) {
  if (process.platform !== 'win32') return { args, command: 'npm' };
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../node_modules/npm/bin/npm-cli.js'),
  ];
  const npmCli = (await Promise.all(candidates.map(async (candidate) => await pathExists(candidate) ? candidate : null))).find(Boolean);
  if (!npmCli) throw Object.assign(new Error('npm is unavailable.'), { code: 'NPM_UNAVAILABLE' });
  return { args: [npmCli, ...args], command: process.execPath };
}

export async function runMcpHandshake(request, { probeTool } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      detached: process.platform !== 'win32',
      env: request.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let buffer = '';
    let settled = false;
    let timer;
    const output = { stderr: '', stdout: '', truncated: false };
    const diagnosticOutput = () => probeTool ? { ...output, stdout: '' } : output;
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', abort);
      void terminateProcessTree(child).then(() => {
        if (error) reject(error);
        else resolve();
      });
    };
    const abort = () => finish(toolCommandError('MCP handshake was cancelled.', 'TOOL_CANCELLED', diagnosticOutput()));
    timer = setTimeout(() => finish(toolCommandError('MCP handshake timed out.', 'MCP_HANDSHAKE_TIMEOUT', diagnosticOutput())), request.timeout);
    child.once('error', () => finish(toolCommandError('MCP process failed to start.', 'MCP_START_FAILED', diagnosticOutput())));
    child.stdin.once('error', () => finish(toolCommandError('MCP process closed stdin during handshake.', 'MCP_STDIN_FAILED', diagnosticOutput())));
    child.once('exit', (code) => {
      if (!settled) finish(toolCommandError('MCP process exited before handshake.', code === 0 ? 'MCP_EARLY_EXIT' : 'MCP_START_FAILED', diagnosticOutput(), { exitCode: code }));
    });
    child.stdout.on('data', (chunk) => {
      output.stdout = appendOutputTail(output.stdout, chunk);
      buffer += chunk.toString('utf8');
      if (buffer.length > 1024 * 1024) {
        output.truncated = true;
        finish(toolCommandError('MCP handshake output limit exceeded.', 'MCP_OUTPUT_LIMIT', diagnosticOutput()));
        return;
      }
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const message = JSON.parse(line);
          if (message.error && [1, 2].includes(message.id)) {
            const operation = message.id === 1 ? 'initialize' : 'tools/list';
            finish(toolCommandError(`MCP ${operation} failed.`, 'MCP_PROTOCOL_ERROR', diagnosticOutput()));
          } else if (message.id === 1) {
            send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            send({ id: 2, jsonrpc: '2.0', method: 'tools/list', params: {} });
          } else if (message.id === 2 && Array.isArray(message.result?.tools)) {
            if (!probeTool) {
              finish();
            } else if (!message.result.tools.some((tool) => tool.name === probeTool)) {
              finish(toolCommandError(`MCP server does not expose ${probeTool}.`, 'MCP_TOOL_MISSING', diagnosticOutput()));
            } else {
              send({ id: 3, jsonrpc: '2.0', method: 'tools/call', params: { arguments: {}, name: probeTool } });
            }
          } else if (message.id === 3) {
            if (message.error || message.result?.isError) {
              finish(toolCommandError('Chrome failed to launch during browser smoke.', 'CHROME_LAUNCH_FAILED', diagnosticOutput()));
            } else {
              finish();
            }
          }
        } catch {
          // Wait for a complete JSON line.
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      output.stderr = appendOutputTail(output.stderr, chunk);
    });
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) {
      abort();
      return;
    }
    send({
      id: 1,
      jsonrpc: '2.0',
      method: 'initialize',
      params: { capabilities: {}, clientInfo: { name: productIdentity.command, version: cognisVersion }, protocolVersion: '2025-03-26' },
    });
  });
}

export async function defaultPhaseRunner(request) {
  if (request.phase === 'mcp-handshake') return runMcpHandshake(request);
  if (request.phase === 'browser-smoke') return runMcpHandshake(request, { probeTool: 'list_pages' });
  return defaultCommandRunner(request);
}

export { execFileAsync, maxDiagnosticOutput };
