import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function splitCommand(command) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|([^\s]+)/gu;
  for (const match of command.matchAll(pattern)) tokens.push(match[1] ?? match[2] ?? match[3]);
  if (tokens.length === 0) throw new Error('Validation command is empty.');
  return tokens;
}

function executableFor(program) {
  if (program === 'node') return process.execPath;
  if (process.platform === 'win32' && ['pnpm', 'npm', 'yarn'].includes(program)) return `${program}.cmd`;
  return program;
}

function verificationError(message) {
  const error = new Error(message);
  error.code = 'PROJECT_VERIFICATION_FAILED';
  return error;
}

export async function executeProjectVerification({ allowManual = false, commandStatus, failureMode = 'throw', targetDir }) {
  const order = ['governance', 'lint', 'typecheck'];
  if (failureMode === 'throw') {
    for (const name of order) {
      const item = commandStatus[name];
      if (!item || item.status === 'not_configured') continue;
      if (item.status === 'missing') throw verificationError(`${name} is missing: ${item.command}`);
      if (item.status === 'manual' && !allowManual) {
        throw verificationError(`${name} is manual; pass --allow-manual to execute it explicitly: ${item.command}`);
      }
    }
  }

  const results = {};
  for (const name of order) {
    const item = commandStatus[name] ?? { command: null, status: 'not_configured' };
    if (item.status === 'not_configured') {
      results[name] = item;
      continue;
    }
    if (item.status === 'missing' || (item.status === 'manual' && !allowManual)) {
      results[name] = { command: item.command, status: 'blocked' };
      continue;
    }
    const [program, ...args] = splitCommand(item.command);
    try {
      const result = await execFileAsync(executableFor(program), args, {
        cwd: targetDir,
        maxBuffer: 1024 * 1024 * 8,
        windowsHide: true,
      });
      results[name] = {
        command: item.command,
        exitCode: 0,
        status: 'passed',
        stderr: result.stderr,
        stdout: result.stdout,
      };
    } catch (cause) {
      const exitCode = typeof cause.code === 'number' ? cause.code : 1;
      if (failureMode === 'report') {
        results[name] = {
          command: item.command,
          exitCode,
          status: 'failed',
          stderr: cause.stderr ?? '',
          stdout: cause.stdout ?? '',
        };
        continue;
      }
      throw verificationError(`${name} failed with exit ${exitCode}: ${cause.stderr || cause.message}`);
    }
  }
  return results;
}

