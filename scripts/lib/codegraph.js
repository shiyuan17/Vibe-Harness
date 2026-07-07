import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { pathExists } from './manifest.js';

function assertSafePackageVersion(version) {
  if (version === undefined) {
    return;
  }
  if (!/^[a-zA-Z0-9._~+-]+$/u.test(version)) {
    throw new Error(`Invalid CodeGraph CLI version: ${version}`);
  }
}

function runCommand(command, args, options = {}) {
  const logPath = process.env.LOOPENGINE_MOCK_COMMAND_LOG;
  if (logPath) {
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify({ args, command })}\n`, 'utf8');
    if (process.env.LOOPENGINE_MOCK_FAIL_COMMAND === command) {
      return { status: 1, stderr: `mock ${command} failure`, stdout: '' };
    }
    if (process.env.LOOPENGINE_MOCK_MISSING_COMMAND === command) {
      return { error: { code: 'ENOENT', message: `mock ${command} missing` }, status: null, stderr: '', stdout: '' };
    }
    if (command === 'codegraph' && args[0] === '--version') {
      return { status: 0, stderr: '', stdout: `${process.env.LOOPENGINE_MOCK_CODEGRAPH_VERSION ?? '1.2.0'}\n` };
    }
    return { status: 0, stderr: '', stdout: '' };
  }

  if (process.platform === 'win32' && ['codegraph', 'npm'].includes(command)) {
    const commandLine = [command, ...args].join(' ');
    return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', commandLine], {
      encoding: 'utf8',
      ...options,
    });
  }

  return spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
}

function installPackage(version) {
  return `@colbymchenry/codegraph@${version ?? 'latest'}`;
}

export function codegraphInstallCommand(version) {
  return ['npm', 'install', '-g', installPackage(version)];
}

export async function installCodeGraphCli({ dryRun = false, version } = {}) {
  assertSafePackageVersion(version);
  const command = codegraphInstallCommand(version);
  if (dryRun) {
    return {
      command,
      dryRun: true,
      installed: false,
    };
  }

  const install = runCommand(command[0], command.slice(1));
  if (install.status !== 0) {
    throw new Error(`CodeGraph CLI install failed: ${install.stderr || install.stdout || `exit ${install.status}`}`);
  }

  const verified = await inspectCodeGraphCli();
  if (!verified.cli.installed) {
    throw new Error(`CodeGraph CLI verification failed: ${verified.cli.error ?? 'codegraph --version failed'}`);
  }

  return {
    command,
    dryRun: false,
    installed: true,
    version: verified.cli.version,
  };
}

export async function inspectCodeGraphCli() {
  const result = runCommand('codegraph', ['--version']);
  if (result.status !== 0) {
    return {
      cli: {
        error: result.error?.message || result.stderr || result.stdout || `exit ${result.status}`,
        installed: false,
        version: null,
      },
    };
  }

  return {
    cli: {
      installed: true,
      version: String(result.stdout).trim(),
    },
  };
}

export async function inspectCodeGraph({ targetDir }) {
  const cli = await inspectCodeGraphCli();
  const resolvedTarget = path.resolve(targetDir);
  return {
    ...cli,
    project: {
      initialized: await pathExists(path.join(resolvedTarget, '.codegraph')),
      targetDir: resolvedTarget,
    },
  };
}
