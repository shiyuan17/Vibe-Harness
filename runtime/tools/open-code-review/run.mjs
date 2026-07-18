#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveOcrEndpoint } from './ocr-config.mjs';

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(toolDir, 'node_modules/@alibaba-group/open-code-review/bin/ocr.js');
const allowedEnvironmentNames = new Set([
  'ALL_PROXY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'APPDATA', 'COMSPEC', 'HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'LOCALAPPDATA', 'NO_PROXY', 'OCR_LLM_AUTH_HEADER', 'OCR_LLM_EXTRA_HEADERS', 'OCR_LLM_MODEL',
  'OCR_LLM_PROTOCOL', 'OCR_LLM_TIMEOUT', 'OCR_LLM_TOKEN', 'OCR_LLM_URL', 'OCR_USE_ANTHROPIC',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'PATH', 'Path', 'PATHEXT', 'PROGRAMDATA', 'ProgramData',
  'SHELL', 'SSL_CERT_DIR', 'SSL_CERT_FILE', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE',
  'WINDIR', 'all_proxy', 'https_proxy', 'http_proxy', 'no_proxy',
]);
const inheritedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => allowedEnvironmentNames.has(name)),
);
const endpoint = await resolveOcrEndpoint({ env: inheritedEnvironment, homeDir: homedir() });
const childEnvironment = { ...inheritedEnvironment, ...(endpoint.env ?? {}) };
const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: childEnvironment,
  stdio: 'inherit',
  windowsHide: true,
});
child.once('error', (error) => {
  console.error(`Unable to start Open Code Review: ${error.code ?? 'START_FAILED'}`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
