import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';

// A supervisor owns exactly one service process tree. The tree is started as a
// detached process-group leader on Unix (`taskkill /t` is the Windows
// equivalent), so "the service is gone" has to be proven for the whole tree —
// the direct child exiting is not proof that a package-manager script's
// descendants are gone. Every terminal status this supervisor reports is
// derived from that proof instead of from the root child's exit alone.
const REAP_STAGE_MS = 2500;
// A tree that survived both signals keeps its supervisor resident so `stop` can
// retry, but not forever: the endpoint is released after this idle lifetime.
const IDLE_LIFETIME_MS = 10 * 60 * 1000;
const SOCKET_TIMEOUT_MS = 15000;

process.once('message', (input) => {
  const cwd = realpathSync(input.cwd);
  const fingerprint = createHash('sha256').update(JSON.stringify([cwd, input.tokens])).digest('hex');
  const child = spawn(input.tokens[0] === 'node' ? process.execPath : input.tokens[0], input.tokens.slice(1), {
    cwd, env: { ...process.env, PORT: String(input.port) }, stdio: 'ignore', windowsHide: true,
    detached: process.platform !== 'win32',
  });
  let exited = false;
  let stopping = false;
  let reapInFlight = null;
  const startedAt = new Date().toISOString();
  const identity = { pid: child.pid, supervisorPid: process.pid, cwd, commandFingerprint: fingerprint, startedAt };
  /** Signal the whole owned tree: the detached group on Unix, `taskkill /t` on Windows. */
  const signalTree = (signal) => {
    if (process.platform === 'win32') {
      execFile('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, timeout: 4000 }, () => {});
      return;
    }
    try { process.kill(-child.pid, signal); } catch { /* the group is already gone */ }
  };
  /**
   * True only while some part of the owned tree can still be observed. Unix
   * answers this from the process group; Windows cannot be asked for a group,
   * so the root child's exit is the observable proof after a forced
   * `taskkill /t`.
   */
  const treeGone = () => {
    if (process.platform === 'win32') return exited;
    try { process.kill(-child.pid, 0); return false; } catch { return true; }
  };
  const waitGone = async (budgetMs) => {
    for (let waited = 0; waited < budgetMs; waited += 100) {
      if (treeGone()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return treeGone();
  };
  /** Graceful signal, wait, forced kill, wait: the proof `stop`/`status` report. */
  const reapTree = () => {
    if (reapInFlight) return reapInFlight;
    const attempt = (async () => {
      if (treeGone()) return true;
      signalTree('SIGTERM');
      if (await waitGone(REAP_STAGE_MS)) return true;
      signalTree('SIGKILL');
      return waitGone(REAP_STAGE_MS);
    })();
    reapInFlight = attempt.finally(() => { reapInFlight = null; });
    return reapInFlight;
  };
  const reply = (socket, payload) => socket.end(`${JSON.stringify(payload)}\n`);
  const settle = (socket, gone) => {
    reply(socket, gone ? { ...identity, status: 'stopped' } : { ...identity, status: 'blocked', reason: 'descendants-survive' });
    // A terminal "stopped" ends this supervisor: an exited service must not keep
    // a detached node process and its endpoint resident. A surviving tree keeps
    // being served so `stop` can retry, bounded by the idle lifetime below.
    if (gone) server.close(() => process.exit(0));
    else stopping = false;
  };
  const server = createServer((socket) => {
    let buffer = '';
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy());
    socket.on('data', async (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 4096) { socket.destroy(); return; }
      if (!buffer.includes('\n')) return;
      let request;
      try { request = JSON.parse(buffer.trim()); } catch { socket.destroy(); return; }
      if (request.action === 'status') {
        if (!exited) { reply(socket, { ...identity, status: 'running' }); return; }
        settle(socket, await reapTree());
        return;
      }
      if (request.action !== 'stop' || stopping
        || ['pid', 'supervisorPid', 'cwd', 'commandFingerprint', 'startedAt'].some((key) => request[key] !== identity[key])) {
        reply(socket, { status: 'blocked', reason: 'ownership-mismatch' }); return;
      }
      stopping = true;
      settle(socket, await reapTree());
    });
  });
  child.once('error', () => { server.close(); process.exit(1); });
  child.once('exit', () => {
    exited = true;
    const idle = setTimeout(() => server.close(() => process.exit(0)), IDLE_LIFETIME_MS);
    idle.unref();
  });
  child.once('spawn', () => {
    // A bind failure must not orphan the tree: the child was started as a
    // detached group leader, so the same proof `stop` uses runs before exiting.
    server.once('error', async () => { await reapTree(); process.exit(1); });
    server.listen(input.endpoint, () => {
      // The unix control socket sits in the shared temp directory, where any
      // local user can enumerate it and the unauthenticated status/stop protocol
      // reveals the ownership fields. connect(2) needs write permission, so
      // 0600 keeps the protocol owner-only; Windows named pipes already default
      // to the creating user's ACL.
      if (process.platform !== 'win32') {
        try { chmodSync(input.endpoint, 0o600); } catch { /* ownership is re-checked by the caller */ }
      }
      process.send?.({ ...identity, status: 'running' });
      process.disconnect?.();
    });
  });
});
