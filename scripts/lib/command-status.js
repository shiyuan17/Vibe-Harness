import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { pathExists } from './manifest.js';

async function packageScripts(targetDir) {
  const packagePath = path.join(targetDir, 'package.json');
  if (!await pathExists(packagePath)) return {};
  try {
    return JSON.parse(await readFile(packagePath, 'utf8')).scripts ?? {};
  } catch {
    return {};
  }
}

export async function inspectValidationCommands({ commands = {}, targetDir }) {
  const scripts = await packageScripts(targetDir);
  const report = {};
  for (const [name, command] of Object.entries(commands)) {
    if (!command) {
      report[name] = { command: null, status: 'not_configured' };
      continue;
    }
    const localNode = command.match(/^node\s+([^\s]+)$/u);
    if (localNode) {
      report[name] = {
        command,
        status: await pathExists(path.resolve(targetDir, localNode[1])) ? 'available' : 'missing',
      };
      continue;
    }
    const packageScript = command.match(/^(?:pnpm|yarn)\s+(?:run\s+)?([^\s]+)$|^npm\s+(?:run\s+)?([^\s]+)$/u);
    if (packageScript) {
      const script = packageScript[1] ?? packageScript[2];
      report[name] = { command, status: Object.hasOwn(scripts, script) ? 'available' : 'missing' };
      continue;
    }
    report[name] = { command, status: 'manual' };
  }
  return report;
}
