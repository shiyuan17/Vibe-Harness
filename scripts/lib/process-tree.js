/**
 * Cross-platform process-tree termination.
 *
 * Terminates a child process and its entire descendant tree with a graceful
 * SIGTERM -> SIGKILL escalation on POSIX, and `taskkill /t /f` on Windows.
 * Waits for the child to close (with a 500ms timeout) before returning so that
 * callers can safely clean up resources (e.g. temporary directories) without
 * racing against file handles still held by descendants.
 */

import { spawn } from 'node:child_process';

const CLOSE_GRACE_MS = 500;

/**
 * Terminate a child process tree. Resolves once the child has exited or the
 * grace timeout elapses. Safe to call on a process that has already exited.
 *
 * @param {import('node:child_process').ChildProcess} child - The child process to terminate.
 * @returns {Promise<void>}
 */
export async function terminateProcessTree(child) {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    await Promise.race([
      new Promise((resolve) => child.once('close', resolve)),
      new Promise((resolve) => setTimeout(resolve, CLOSE_GRACE_MS)),
    ]);
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
    return;
  }
  const killedTree = await new Promise((resolve) => {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', () => resolve(false));
    killer.once('close', (code) => resolve(code === 0));
  });
  if (!killedTree && child.exitCode === null) child.kill('SIGKILL');
  await Promise.race([
    new Promise((resolve) => child.once('close', resolve)),
    new Promise((resolve) => setTimeout(resolve, CLOSE_GRACE_MS)),
  ]);
}
