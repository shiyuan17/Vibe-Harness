#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(toolDir, 'node_modules/@alibaba-group/open-code-review/bin/ocr.js');
const allowedEnvironmentNames = new Set([
  'ALL_PROXY', 'ANTHROPIC_API_KEY', 'APPDATA', 'COMSPEC', 'HOME', 'HTTPS_PROXY', 'HTTP_PROXY',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'LOCALAPPDATA', 'NO_PROXY', 'OCR_LLM_MODEL', 'OCR_LLM_TOKEN',
  'OCR_LLM_URL', 'OPENAI_API_KEY', 'PATH', 'Path', 'PATHEXT', 'PROGRAMDATA', 'ProgramData',
  'SHELL', 'SSL_CERT_DIR', 'SSL_CERT_FILE', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE',
  'WINDIR', 'all_proxy', 'https_proxy', 'http_proxy', 'no_proxy',
]);
const childEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => allowedEnvironmentNames.has(name)),
);
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
