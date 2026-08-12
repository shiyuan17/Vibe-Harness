import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeAstGrepArgs } from './args.mjs';

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const binaryName = process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep';
const binary = path.join(toolDir, 'node_modules', '@ast-grep', 'cli', binaryName);
const input = process.argv.slice(2);
const args = normalizeAstGrepArgs(input);
const child = spawn(binary, args, {
  cwd: process.cwd(),
  env: process.env,
  shell: false,
  stdio: 'inherit',
  windowsHide: true,
});
child.once('error', (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.once('close', (code) => { process.exitCode = code ?? 1; });
