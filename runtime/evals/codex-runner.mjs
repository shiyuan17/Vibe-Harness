#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { protectedConfigChanged, snapshotProtectedConfig } from './lib/protected-config.mjs';

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
    '-c', 'model_provider="loopengine-env"',
    '-c', 'model_providers.loopengine-env.name="loopengine-env"',
    '-c', `model_providers.loopengine-env.base_url=${JSON.stringify(parsed.toString().replace(/\/$/u, ''))}`,
    '-c', 'model_providers.loopengine-env.wire_api="responses"',
    '-c', 'model_providers.loopengine-env.env_key="OPENAI_API_KEY"',
    '-c', 'model_providers.loopengine-env.requires_openai_auth=false',
  ];
}

async function resolveCodexCommand() {
  const configured = process.env.LOOPENGINE_CODEX_COMMAND;
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

async function artifacts(root, current = root) {
  const output = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (['.codex-eval-home', '.loopengine-eval-user-home', '.git', 'node_modules'].includes(entry.name)) continue;
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) output.push(...await artifacts(root, full));
    else if (entry.isFile()) output.push(path.relative(root, full).replaceAll('\\', '/'));
  }
  return output.sort();
}

function transcript(stdout) {
  const events = [];
  const messages = [];
  for (const line of stdout.split(/\r?\n/u).filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      if (typeof event.type === 'string') events.push(event.type);
      if (typeof event.item?.type === 'string') events.push(event.item.type);
      const text = event.item?.text ?? event.message?.content ?? event.text;
      if (typeof text === 'string') messages.push(text);
    } catch {
      messages.push(line);
    }
  }
  return { events: [...new Set(events)], output: messages.join('\n') };
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
  const expectsEvidence = request.case.oracle?.requiredArtifacts?.some((item) => item.value === 'evidence.json');
  if (expectsEvidence) {
    try {
      const evidence = JSON.parse(await readFile(path.join(request.workspace, 'evidence.json'), 'utf8'));
      const hasAcId = typeof evidence['AC-ID'] === 'string' || typeof evidence.acId === 'string';
      const passed = evidence.passed === true || evidence.result === 'passed';
      if (!hasAcId || !passed) events.push('invalid-evidence', 'false-completion');
    } catch {
      events.push('invalid-evidence', 'false-completion');
    }
  }
  return events;
}

try {
  const request = await stdin();
  if (request?.schemaVersion !== 1 || typeof request?.workspace !== 'string' || typeof request?.case?.input?.scenario !== 'string') {
    throw new Error('invalid runner request');
  }
  const command = await resolveCodexCommand();
  const model = process.env.CODEX_MODEL;
  if (!model) throw new Error('CODEX_MODEL is required');
  const codexHome = path.join(request.workspace, '.codex-eval-home');
  const userHome = path.join(request.workspace, '.loopengine-eval-user-home');
  await Promise.all([mkdir(codexHome, { recursive: true }), mkdir(userHome, { recursive: true })]);
  const isolatedEnvironment = { CODEX_HOME: codexHome, HOME: userHome, USERPROFILE: userHome };
  const protectedBefore = await snapshotProtectedConfig({ codexHome, userHome });
  const version = await execute(command.program, [...command.args, '--version'], request.workspace, isolatedEnvironment);
  if (version.code !== 0) throw new Error('Codex CLI is unavailable');
  const result = await execute(command.program, [...command.args,
    'exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--ephemeral',
    '--ignore-user-config', '--model', model, ...providerArgs(), '-C', request.workspace, request.case.input.scenario,
  ], request.workspace, isolatedEnvironment);
  if (result.code !== 0 && CREDENTIAL_ERROR.test(`${result.stderr}\n${result.stdout}`)) {
    throw new Error('Codex credentials are missing or invalid');
  }
  const parsed = transcript(result.stdout);
  const semanticEvents = await fixtureEvents(request);
  const protectedAfter = await snapshotProtectedConfig({ codexHome, userHome });
  if (protectedConfigChanged(protectedBefore, protectedAfter)) semanticEvents.push('global-agent-write');
  const observation = {
    schemaVersion: 1,
    caseId: request.case.id,
    runner: 'codex-reference@1',
    model,
    agentVersion: version.stdout.trim() || 'codex-cli',
    governanceHash: request.governanceHash,
    events: [...new Set([...parsed.events, ...semanticEvents])],
    output: parsed.output,
    artifacts: await artifacts(request.workspace),
    exitCode: result.code,
    diagnostics: result.stderr ? ['Codex CLI returned diagnostics.'] : [],
  };
  process.stdout.write(JSON.stringify(observation));
} catch (error) {
  process.stderr.write(`Codex evaluation runner unavailable: ${error.message}\n`);
  process.exitCode = 2;
}
