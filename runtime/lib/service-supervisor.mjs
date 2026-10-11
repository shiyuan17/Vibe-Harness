import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';

import { processStartIdentity, serviceSocketDirectory, signalTree as signalProcessTree, treeGone as processTreeGone } from './services.mjs';

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
// The launcher confirms that it persisted this service identity over the IPC
// channel; without that acknowledgement the tree would have no recorded owner.
const REGISTRATION_ACK_MS = 10000;

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
  // The launcher persists this identity when the handshake cannot complete, and
  // a supervisor that is already gone can only be reclaimed through it, so the
  // OS start identity is captured here — while this process still owns the
  // freshly spawned child — instead of being probed later from the registry,
  // where a recycled PID would then be read as the recorded process.
  const startIdentity = processStartIdentity(child.pid);
  const identity = {
    pid: child.pid,
    supervisorPid: process.pid,
    cwd,
    commandFingerprint: fingerprint,
    startedAt,
    // Neither control endpoint carries OS-level authorization: a Unix socket is
    // restricted after it already accepts, and a named pipe inherits the
    // creating process's default ACL. The protocol therefore authenticates with
    // a per-supervisor secret that only reaches the launcher over the private
    // IPC channel.
    controlToken: randomUUID(),
    ...(startIdentity === 'missing' || startIdentity === 'unreadable' ? {} : { processStartTime: startIdentity }),
  };
  const blocked = (reason) => ({ ...identity, status: 'blocked', reason });
  /** True only for a request that presents every recorded ownership field. */
  const ownsRequest = (request) => request.controlToken === identity.controlToken
    && ['pid', 'supervisorPid', 'cwd', 'commandFingerprint', 'startedAt'].every((key) => request[key] === identity[key])
    && (identity.processStartTime === undefined || request.processStartTime === identity.processStartTime);

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
    // The idle expiry retires the supervisor only once the tree is proven gone:
    // closing the endpoint on a surviving tree would leave a detached service
    // behind with no handle that could ever stop it again.
    idle = setTimeout(async () => {
      idle = null;
      if (await reapTree()) server.close(() => process.exit(0));
      else stayResident();
    }, IDLE_LIFETIME_MS);
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
      // Every request — `status` included — has to present the ownership fields
      // and the per-supervisor token: a `status` reply would otherwise hand a
      // local user the exact fields a `stop` needs to authorize itself.
      if (!ownsRequest(request)) {
        reply(socket, blocked('ownership-mismatch')); return;
      }
      if (request.action === 'status') {
        if (!exited) { reply(socket, { ...identity, status: 'running' }); return; }
        settle(socket, await reapTree());
        return;
      }
      if (request.action !== 'stop' || stopping) {
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
    // Exiting on the signal alone would orphan a live tree and take away the
    // only endpoint that can still retire it, so the supervisor leaves only
    // after the tree is proven gone; a surviving tree keeps it resident so a
    // later `stop` can retry the proof.
    if (await reapTree()) { process.exit(code); return; }
    stayResident();
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
    // The root child's exit is the moment the tree needs reaping, not proof
    // that it is gone: a launcher that exits after spawning a server leaves
    // descendants only the tree probe can see, and nothing else would signal
    // them if no client ever asks for `status` or `stop`.
    void (async () => {
      if (await reapTree()) server.close(() => process.exit(0));
      else stayResident();
    })();
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
    // A Unix socket is created by `listen()` before any permission can be
    // applied to it, and `connect(2)` only needs write permission, so the
    // endpoint is published inside a directory only this user can traverse:
    // there is no interval in which another local user can enumerate or connect
    // to it. A socket that cannot live there is treated like a bind failure
    // instead of being published with broader permissions.
    const endpointDirectory = process.platform === 'win32' ? null : path.dirname(input.endpoint);
    if (endpointDirectory !== null && endpointDirectory !== serviceSocketDirectory()) {
      server.emit('error', new Error('Service control endpoint must live in this user\'s socket directory.'));
      return;
    }
    if (endpointDirectory !== null) {
      try {
        mkdirSync(endpointDirectory, { recursive: true, mode: 0o700 });
        const info = lstatSync(endpointDirectory);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('socket directory is not a directory');
        chmodSync(endpointDirectory, 0o700);
      } catch {
        server.emit('error', new Error('Service control socket directory could not be restricted to its owner.'));
        return;
      }
    }
    server.listen(input.endpoint, () => {
      if (endpointDirectory !== null) {
        try { chmodSync(input.endpoint, 0o600); } catch {
          // The server is already accepting connections; it must not stay
          // listening as an endpoint with the permissions it was created with.
          server.close(() => server.emit('error', new Error('Service control socket could not be restricted to its owner.')));
          return;
        }
      }
      // The launcher confirms that the identity was persisted before this
      // supervisor lets go of the channel. Until then the tree has no recorded
      // owner, so a launcher that dies — or never answers — leaves a service
      // nothing could later stop, and the tree is reaped instead.
      let acked = false;
      const abandon = async () => {
        if (acked) return;
        acked = true;
        clearTimeout(ackTimer);
        process.removeListener('message', onAck);
        process.removeListener('disconnect', onDisconnect);
        server.close();
        if (endpointDirectory !== null) { try { rmSync(input.endpoint, { force: true }); } catch { /* already gone */ } }
        if (await reapTree()) { process.exit(1); return; }
        stayResident();
      };
      const onAck = (message) => {
        if (message?.action !== 'registered') return;
        acked = true;
        clearTimeout(ackTimer);
        process.removeListener('message', onAck);
        process.removeListener('disconnect', onDisconnect);
        process.disconnect?.();
      };
      const onDisconnect = () => { void abandon(); };
      const ackTimer = setTimeout(() => { void abandon(); }, REGISTRATION_ACK_MS);
      ackTimer.unref();
      process.on('message', onAck);
      process.on('disconnect', onDisconnect);
      try { process.send?.({ ...identity, status: 'running' }); } catch { void abandon(); }
    });
  });
}

process.once('message', (input) => { startService(input); });
