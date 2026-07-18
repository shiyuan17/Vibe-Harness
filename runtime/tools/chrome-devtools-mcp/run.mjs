#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(toolDir, 'node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js');
const args = [
  '--headless',
  '--isolated',
  '--no-usage-statistics',
  '--no-performance-crux',
  '--redact-network-headers',
];
const allowedEnvironmentNames = new Set([
  'APPDATA', 'COMSPEC', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOCALAPPDATA', 'PATH', 'Path',
  'PATHEXT', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'ProgramData', 'ProgramFiles',
  'ProgramFiles(x86)', 'SHELL', 'SystemDrive', 'SystemRoot',
  'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'WINDIR',
]);
const childEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => allowedEnvironmentNames.has(name)),
);
childEnvironment.CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS = '1';
childEnvironment.CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS = '1';

const child = spawn(process.execPath, [entry, ...args], {
  cwd: process.cwd(),
  env: childEnvironment,
  stdio: 'inherit',
  windowsHide: true,
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => child.kill(signal));
}
child.once('error', (error) => {
  console.error(`Unable to start Chrome DevTools MCP: ${error.code ?? 'START_FAILED'}`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
