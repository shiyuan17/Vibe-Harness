#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, chmod, copyFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { protectedConfigChanged, snapshotProtectedConfig } from './lib/protected-config.mjs';
import { runHiddenTests } from './lib/hidden-tests.mjs';

const LIMIT = 1024 * 1024;
const CREDENTIAL_ERROR = /\b(?:api[-_ ]?key|auth(?:entication|orization)?|credentials?|login|unauthorized)\b/iu;
const codexEnvironmentNames = new Set([
  'ALL_PROXY', 'APPDATA', 'AZURE_OPENAI_API_KEY', 'CODEX_HOME', 'COMSPEC', 'HOME',
  'HTTPS_PROXY', 'HTTP_PROXY', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOCALAPPDATA', 'NO_PROXY',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'PATH', 'Path', 'PATHEXT', 'PROGRAMDATA', 'ProgramData',
  'SHELL', 'SSL_CERT_DIR', 'SSL_CERT_FILE', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE',
  'WINDIR', 'all_proxy', 'https_proxy', 'http_proxy', 'no_proxy',
]);

function codexEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => codexEnvironmentNames.has(name)));
}

async function stdin() {
  let body = '';
  for await (const chunk of process.stdin) {
    body += chunk;
    if (Buffer.byteLength(body) > LIMIT) throw new Error('runner request exceeds 1 MiB');
  }
  return JSON.parse(body);
}

function execute(program, args, cwd, environment) {
  return new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const child = spawn(program, args, {
      cwd,
      env: { ...codexEnvironment(process.env), ...environment },
      shell: false,
      windowsHide: true,
    });
    const append = (value, chunk) => {
      const next = Buffer.concat([value, chunk]);
      if (next.length > LIMIT) child.kill();
      return next.subarray(0, LIMIT);
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stderr: stderr.toString('utf8'), stdout: stdout.toString('utf8') }));
    child.stdin.end();
  });
}

function providerArgs() {
  const baseUrl = process.env.OPENAI_BASE_URL;
  if (!baseUrl) return [];
  const parsed = new URL(baseUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('OPENAI_BASE_URL must use http or https');
  return [
    '-c', 'model_provider="cognis-env"',
    '-c', 'model_providers.cognis-env.name="cognis-env"',
    '-c', `model_providers.cognis-env.base_url=${JSON.stringify(parsed.toString().replace(/\/$/u, ''))}`,
    '-c', 'model_providers.cognis-env.wire_api="responses"',
    '-c', 'model_providers.cognis-env.env_key="OPENAI_API_KEY"',
    '-c', 'model_providers.cognis-env.requires_openai_auth=false',
  ];
}

async function resolveCodexCommand() {
  const configured = process.env.COGNIS_CODEX_COMMAND;
  if (configured?.toLowerCase().endsWith('.mjs') || configured?.toLowerCase().endsWith('.js')) {
    return { args: [configured], program: process.execPath };
  }
  if (process.platform !== 'win32') return { args: [], program: configured ?? 'codex' };
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const wrappers = [];
  if (configured?.toLowerCase().endsWith('.cmd') && path.isAbsolute(configured)) wrappers.push(configured);
  if (!configured || configured.toLowerCase() === 'codex.cmd') {
    wrappers.push(...pathEntries.map((entry) => path.join(entry, 'codex.cmd')));
  }
  for (const wrapper of wrappers) {
    const script = path.join(path.dirname(wrapper), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    try {
      await access(wrapper);
      await access(script);
      return { args: [script], program: process.execPath };
    } catch {}
  }
  if (configured && !configured.toLowerCase().endsWith('.cmd')) return { args: [], program: configured };
  for (const entry of pathEntries) {
    const executable = path.join(entry, 'codex.exe');
    try {
      await access(executable);
      return { args: [], program: executable };
    } catch {}
  }
  return { args: [], program: 'codex.exe' };
}

async function provisionAuthentication(codexHome) {
  const source = process.env.COGNIS_EVAL_AUTH_FILE;
  if (!source) return;
  if (!path.isAbsolute(source)) throw new Error('COGNIS_EVAL_AUTH_FILE must be absolute');
  const details = await stat(source);
  if (!details.isFile()) throw new Error('COGNIS_EVAL_AUTH_FILE must reference a file');
  const target = path.join(codexHome, 'auth.json');
  await copyFile(source, target);
  await chmod(target, 0o600);
}

async function artifacts(root, current = root) {
  const output = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (['.codex-eval-home', '.cognis-eval-user-home', '.git', 'node_modules'].includes(entry.name)) continue;
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) output.push(...await artifacts(root, full));
    else if (entry.isFile()) output.push(path.relative(root, full).replaceAll('\\', '/'));
  }
  return output.sort();
}

function transcript(stdout) {
  const events = [];
  const commands = [];
  const errorCategories = [];
  const messages = [];
  const hookReasonCodes = [];
  const toolTypes = [];
  let sessionId = null;
  let totalTokens = 0;
  let toolCalls = 0;
  for (const line of stdout.split(/\r?\n/u).filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      sessionId ??= event.thread_id ?? event.thread?.id ?? event.session_id ?? null;
      if (typeof event.type === 'string') events.push(event.type);
      if (typeof event.item?.type === 'string') {
        events.push(event.item.type);
        if (!['agent_message', 'reasoning'].includes(event.item.type)) toolTypes.push(event.item.type);
        if (event.item.type === 'error') {
          const errorText = [
            event.item.message,
            event.item.text,
            event.error?.message,
            typeof event.message === 'string' ? event.message : event.message?.content,
          ].filter((value) => typeof value === 'string').join(' ');
          if (/plan mode|read[- ]only|cannot edit|editing is disabled/iu.test(errorText)) errorCategories.push('mode-restricted');
          else if (/subagent|child agent|spawn|collaboration/iu.test(errorText)) errorCategories.push('agent-tool');
          else if (/hook|denied|permission|policy/iu.test(errorText)) errorCategories.push('policy-denied');
          else if (/not found|unavailable|unknown tool|unsupported/iu.test(errorText)) errorCategories.push('tool-unavailable');
          else errorCategories.push('tool-error');
        }
      }
      if (event.type === 'item.completed' && !['agent_message', 'reasoning'].includes(event.item?.type)) toolCalls += 1;
      const command = event.item?.command ?? event.command;
      if (typeof command === 'string') commands.push(command);
      if (event.type === 'turn.completed' && event.usage) {
        totalTokens += Number(event.usage.input_tokens ?? 0) + Number(event.usage.output_tokens ?? 0);
      }
      const text = event.item?.text ?? event.message?.content ?? event.text;
      if (typeof text === 'string') {
        messages.push(text);
        for (const match of text.matchAll(/\[COGNIS_POLICY:([A-Z0-9_]+)\]/gu)) hookReasonCodes.push(match[1]);
      }
    } catch {
      messages.push(line);
    }
  }
  return {
    commands,
    errorCategories: [...new Set(errorCategories)],
    events: [...new Set(events)],
    hookReasonCodes: [...new Set(hookReasonCodes)],
    messages,
    output: messages.join('\n'),
    sessionId,
    totalTokens,
    toolCalls,
    toolTypes: [...new Set(toolTypes)],
  };
}

async function fixtureEvents(request) {
  const events = [];
  for (const file of request.case.input?.fixture?.files ?? []) {
    try {
      const current = await readFile(path.join(request.workspace, file.path), 'utf8');
      if (current !== file.content) events.push('existing-file-overwritten');
    } catch {
      events.push('existing-file-overwritten');
    }
  }
  return events;
}

try {
  const request = await stdin();
  if (![1, 2].includes(request?.schemaVersion) || typeof request?.workspace !== 'string' || typeof request?.case?.input?.scenario !== 'string') {
    throw new Error('invalid runner request');
  }
  const command = await resolveCodexCommand();
  const model = process.env.CODEX_MODEL;
  if (!model) throw new Error('CODEX_MODEL is required');
  const codexHome = path.join(request.workspace, '.codex-eval-home');
  const userHome = path.join(request.workspace, '.cognis-eval-user-home');
  await Promise.all([mkdir(codexHome, { recursive: true }), mkdir(userHome, { recursive: true })]);
  await provisionAuthentication(codexHome);
  const isolatedEnvironment = { CODEX_HOME: codexHome, HOME: userHome, USERPROFILE: userHome };
  const protectedBefore = await snapshotProtectedConfig({ codexHome, userHome });
  const version = await execute(command.program, [...command.args, '--version'], request.workspace, isolatedEnvironment);
  if (version.code !== 0) throw new Error('Codex CLI is unavailable');
  const reasoningEffort = process.env.CODEX_REASONING_EFFORT ?? 'medium';
  if (!['low', 'medium', 'high', 'xhigh'].includes(reasoningEffort)) throw new Error('CODEX_REASONING_EFFORT is invalid');
  const trustedHooks = process.env.COGNIS_EVAL_TRUST_PROJECT_HOOKS === '1'
    ? ['--dangerously-bypass-hook-trust']
    : [];
  const sharedArgs = [
    '--json', '--skip-git-repo-check', '--ignore-user-config', ...trustedHooks,
    '--disable', 'apps', '--disable', 'plugins', '--disable', 'remote_plugin',
    '--disable', 'browser_use', '--disable', 'computer_use', '--disable', 'image_generation',
    '--disable', 'in_app_browser', '--disable', 'goals', '--disable', 'workspace_dependencies',
    '--model', model, '-c', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
    '-c', 'sandbox_mode="workspace-write"',
    ...providerArgs(),
  ];
  const invocationArgs = request.sessionId
    ? [...command.args, 'exec', 'resume', ...sharedArgs, request.sessionId, request.case.input.scenario]
    : [...command.args, 'exec', ...sharedArgs, '--sandbox', 'workspace-write',
      ...(request.schemaVersion === 1 ? ['--ephemeral'] : []),
      '-C', request.workspace, request.case.input.scenario];
  const result = await execute(command.program, invocationArgs, request.workspace, isolatedEnvironment);
  if (result.code !== 0 && CREDENTIAL_ERROR.test(`${result.stderr}\n${result.stdout}`)) {
    throw new Error('Codex credentials are missing or invalid');
  }
  const parsed = transcript(result.stdout);
  const semanticEvents = [...await fixtureEvents(request), ...await runHiddenTests(request, isolatedEnvironment)];
  const protectedAfter = await snapshotProtectedConfig({ codexHome, userHome });
  if (protectedConfigChanged(protectedBefore, protectedAfter)) semanticEvents.push('global-agent-write');
  const observation = {
    schemaVersion: request.schemaVersion,
    caseId: request.case.id,
    runner: `codex-reference@${request.schemaVersion}`,
    model,
    agentVersion: version.stdout.trim() || 'codex-cli',
    configHash: request.configHash,
    events: [...new Set([...parsed.events, ...semanticEvents])],
    output: parsed.output,
    metrics: {
      commands: parsed.commands,
      errorCategories: parsed.errorCategories,
      hookReasonCodes: parsed.hookReasonCodes,
      messages: parsed.messages,
      totalTokens: parsed.totalTokens,
      toolCalls: parsed.toolCalls,
      toolTypes: parsed.toolTypes,
    },
    sessionId: parsed.sessionId ?? request.sessionId ?? null,
    artifacts: await artifacts(request.workspace),
    exitCode: result.code,
    diagnostics: result.stderr ? ['Codex CLI returned diagnostics.'] : [],
  };
  process.stdout.write(JSON.stringify(observation));
} catch (error) {
  process.stderr.write(`Codex evaluation runner unavailable: ${error.message}\n`);
  process.exitCode = 2;
}
