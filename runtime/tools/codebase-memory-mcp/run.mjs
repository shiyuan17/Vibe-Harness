#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(toolDir, 'node_modules/codebase-memory-mcp/bin.js');
const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
});
child.once('error', (error) => {
  console.error(`Unable to start codebase-memory-mcp: ${error.code ?? 'START_FAILED'}`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
