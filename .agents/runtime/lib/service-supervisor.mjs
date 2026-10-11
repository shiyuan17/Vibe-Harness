import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';

import { signalTree as signalProcessTree, treeGone as processTreeGone } from './services.mjs';

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
// A Windows tree proof spawns a PowerShell process, so the wait between two
// proofs is a poll interval rather than a fixed number of probes.
const PROOF_POLL_MS = 200;
const TERMINATION_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGBREAK'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True once `proof()` reports the whole owned tree gone, or when the budget runs out. */
async function waitForProof(proof, budgetMs) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (proof()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(PROOF_POLL_MS, Math.max(1, deadline - Date.now())));
  }
}

function startService(input) {
  const cwd = realpathSync(input.cwd);
  const fingerprint = createHash('sha256').update(JSON.stringify([cwd, input.tokens])).digest('hex');
  const child = spawn(input.tokens[0] === 'node' ? process.execPath : input.tokens[0], input.tokens.slice(1), {
    cwd, env: { ...process.env, PORT: String(input.port) }, stdio: 'ignore', windowsHide: true,
    detached: process.platform !== 'win32',
  });
  let exited = false;
  let stopping = false;
  let reaping = null;
  let idle = null;
  const startedAt = new Date().toISOString();
  const identity = { pid: child.pid, supervisorPid: process.pid, cwd, commandFingerprint: fingerprint, startedAt };
  const blocked = (reason) => ({ ...identity, status: 'blocked', reason });

  /** Signal the whole owned tree: the detached group on Unix, `taskkill /t` on Windows. */
  const signalTree = (signal) => signalProcessTree(child.pid, signal);
  /**
   * True only while some part of the owned tree can still be observed.
   *
   * `exited` is deliberately not part of this answer: a launcher that exits
   * after spawning a server leaves descendants that only the tree probe can
   * see, so the root child's exit decides *when* to reap, never whether the
   * tree is gone.
   */
  const treeGone = () => processTreeGone(child.pid);

  const stayResident = () => {
    if (idle) return;
    idle = setTimeout(() => server.close(() => process.exit(0)), IDLE_LIFETIME_MS);
    idle.unref();
  };
  /** Graceful signal, wait, forced kill, wait: the proof `stop`/`status` report. */
  const reapTree = () => {
    if (reaping) return reaping;
    const attempt = (async () => {
      if (treeGone()) return true;
      signalTree('SIGTERM');
      if (await waitForProof(treeGone, REAP_STAGE_MS)) return true;
      signalTree('SIGKILL');
      return waitForProof(treeGone, REAP_STAGE_MS);
    })();
    reaping = attempt.finally(() => { reaping = null; });
    return reaping;
  };
  const reply = (socket, payload) => socket.end(`${JSON.stringify(payload)}\n`);
  const settle = (socket, gone) => {
    reply(socket, gone ? { ...identity, status: 'stopped' } : blocked('descendants-survive'));
    // A terminal "stopped" ends this supervisor: an exited service must not keep
    // a detached node process and its endpoint resident. A surviving tree keeps
    // being served so `stop` can retry, bounded by the idle lifetime below.
    if (gone) server.close(() => process.exit(0));
    else { stopping = false; stayResident(); }
  };
  /** Prove the tree gone for the launcher over IPC, before an endpoint exists. */
  const abort = async () => {
    const gone = await reapTree();
    if (!gone) stayResident();
    return gone ? { ...identity, status: 'stopped' } : blocked('descendants-survive');
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
        reply(socket, blocked('ownership-mismatch')); return;
      }
      stopping = true;
      settle(socket, await reapTree());
    });
  });
  /**
   * Retire the owned tree on every way out of this process.
   *
   * The launcher kills this supervisor when its startup handshake times out,
   * and exiting on the signal alone would leave the detached service behind.
   * The tree is signalled and proven gone first, exactly like an explicit stop.
   */
  const releaseAndExit = async (code) => {
    if (idle) { clearTimeout(idle); idle = null; }
    await reapTree();
    process.exit(code);
  };
  for (const signal of TERMINATION_SIGNALS.filter((name) => name !== 'SIGBREAK' || process.platform === 'win32')) {
    process.on(signal, () => { void releaseAndExit(0); });
  }
  // The startup handshake runs over IPC before the control endpoint exists, so
  // a launcher that times out asks for the same proof here instead of killing
  // the supervisor and orphaning whatever the service already spawned.
  process.on('message', async (message) => {
    if (!message || message.action !== 'abort') return;
    const result = await abort();
    try { process.send?.(result); } catch { /* the launcher is already gone */ }
    if (result.status === 'stopped') {
      const timer = setTimeout(() => process.exit(0), 25);
      timer.unref();
    }
  });
  child.once('error', () => { server.close(); process.exit(1); });
  child.once('exit', () => {
    exited = true;
    stayResident();
  });
  child.once('spawn', () => {
    // The launcher needs the service identity before the endpoint can answer:
    // that identity is what lets it reclaim this tree if the handshake times out.
    try { process.send?.({ ...identity, status: 'spawned' }); } catch { /* the handshake is already abandoned */ }
    // A bind failure, or a control socket that cannot be restricted to its
    // owner, must not orphan the tree: the same proof `stop` uses runs before
    // the caller is told anything.
    server.once('error', async () => {
      const gone = await reapTree();
      if (gone) { process.exit(1); return; }
      // Descendants survived both signals. Exiting here would leave them with no
      // owner and no handle, so the supervisor stays resident and reports the
      // surviving tree to the launcher over IPC instead of exiting.
      try { process.send?.({ ...identity, status: 'blocked', reason: 'control-endpoint-unavailable' }); } catch { /* the launcher is gone */ }
      stayResident();
    });
    server.listen(input.endpoint, () => {
      // The unix control socket sits in the shared temp directory, where any
      // local user can enumerate it. The unauthenticated status/stop protocol
      // reveals the ownership fields and `connect(2)` only needs write
      // permission, so a socket that cannot be restricted to its owner is
      // treated like a bind failure instead of being published as it is.
      if (process.platform !== 'win32') {
        try { chmodSync(input.endpoint, 0o600); } catch { server.emit('error', new Error('Service control socket could not be restricted to its owner.')); return; }
      }
      try { process.send?.({ ...identity, status: 'running' }); } catch { /* the handshake is already abandoned */ }
      process.disconnect?.();
    });
  });
}

process.once('message', (input) => { startService(input); });
