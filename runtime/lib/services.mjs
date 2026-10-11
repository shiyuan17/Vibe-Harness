import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, closeSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDeliveryConfig } from './delivery.mjs';

function registryPath(project) {
  const result = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: project, encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (result.status !== 0) throw new Error('Service registry requires a Git worktree');
  const primary = result.stdout.split(/\r?\n/u)[0].slice('worktree '.length);
  const root = realpathSync(primary);
  const directory = path.join(root, '.vibe-harness');
  if (existsSync(directory) && (lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory)) throw new Error('Service registry directory must not be a link');
  return path.join(directory, 'processes.json');
}

function readRegistry(file) {
  if (!existsSync(file)) return { schemaVersion: 1, processes: [] };
  if (lstatSync(file).isSymbolicLink()) throw new Error('Service registry must not be a link');
  const registry = JSON.parse(readFileSync(file, 'utf8'));
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.processes)) throw new Error('Invalid service registry');
  return registry;
}
// The supervisor protocol answers `status` from the whole owned process tree and
// only these reasons mean "the supervisor could not be reached at all" — the
// reasons an explicit refusal (ownership mismatch) must not be mistaken for.
const SUPERVISOR_UNREACHABLE = new Set([
  'invalid-supervisor-endpoint', 'invalid-supervisor-response', 'supervisor-timeout', 'supervisor-unavailable',
]);
const ORPHAN_REAP_STAGE_MS = 2500;
const PROBE_TIMEOUT_MS = 20000;
// The start handshake covers spawning the service, binding the control endpoint
// and answering it; the abort that follows asks the same supervisor to prove the
// tree gone before a failed start is reported as clean.
const SUPERVISOR_START_TIMEOUT_MS = 20000;
const SUPERVISOR_ABORT_TIMEOUT_MS = 30000;
// A Windows process tree cannot be asked for a group the way a Unix process
// group can: `WMI` is walked from the recorded root, because a launcher that
// exits while the server it spawned keeps running leaves descendants whose
// only link to the root is that parent field.
const WINDOWS_TREE_PROBE = [
  '$root = <PID>',
  '$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)',
  "$ids = New-Object 'System.Collections.Generic.HashSet[int]'",
  '[void]$ids.Add([int]$root)',
  'do { $added = 0; foreach ($process in $all) { if ($ids.Contains([int]$process.ParentProcessId) -and $ids.Add([int]$process.ProcessId)) { $added += 1 } } } while ($added -gt 0)',
  '$live = @()',
  'foreach ($id in $ids) { if (Get-Process -Id $id -ErrorAction SilentlyContinue) { $live += $id } }',
  'Write-Output ($live -join ",")',
].join('\n');

/**
 * Every live PID of the process tree rooted at `rootPid`, or null.
 *
 * Null means the probe could not answer. It is deliberately not an empty list:
 * "no survivors observed" and "could not observe" are different facts, and only
 * the first one is proof that a tree is gone.
 */
export function windowsTreePids(rootPid, { probe = undefined } = {}) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) return [];
  const run = probe ?? ((command) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true,
  }));
  let output;
  try {
    output = run(WINDOWS_TREE_PROBE.replace('<PID>', String(rootPid)));
  } catch {
    return null;
  }
  return String(output ?? '').trim() === ''
    ? []
    : String(output).trim().split(',').map((value) => Number.parseInt(value.trim(), 10)).filter((value) => Number.isSafeInteger(value) && value > 0);
}

/**
 * True only when no part of the recorded tree can still be observed.
 *
 * Unix answers from the process group, and only `ESRCH` is proof: `EPERM` means
 * the group still exists and merely cannot be signalled by this user. Windows
 * answers from the tree probe above, so a root that exited while a descendant
 * survived is not reported as gone.
 */
export function treeGone(pid, { probe = undefined } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  if (process.platform === 'win32') {
    const live = windowsTreePids(pid, { probe });
    return live !== null && live.length === 0;
  }
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

/**
 * A non-reusable, OS-level identity for one process.
 *
 * A registry entry only holds numbers and strings, so by the time a supervisor
 * is gone its PID may belong to an unrelated process. The start time is the
 * cheapest OS-level fact that distinguishes "the process we recorded" from "a
 * process that happens to hold the same PID now". `'missing'` and `'unreadable'`
 * are distinct: only the first one proves there is nothing to reclaim.
 */
export function processStartIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'missing';
  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `try { (Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o') } catch { 'missing' }`,
    ], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true });
    if (result.error || result.status !== 0) return 'unreadable';
    const value = String(result.stdout ?? '').trim();
    return value === '' ? 'unreadable' : value;
  }
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true });
  if (result.error || result.status !== 0) return 'missing';
  const value = String(result.stdout ?? '').trim();
  return value === '' ? 'missing' : value;
}
export function signalTree(pid, signal) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true, timeout: 4000 });
    return;
  }
  try { process.kill(-pid, signal); } catch { /* the group is already gone */ }
}
/**
 * Retire a service whose supervisor can no longer answer for it.
 *
 * A supervisor that exited after proving its tree gone leaves only the registry
 * entry behind. Reclaiming that entry from outside is the same proof, not a
 * weaker one: the tree is signalled and only a tree that is observably gone
 * counts as stopped. A surviving tree stays blocked, so a restart can never
 * shadow a service that still holds its port.
 */
async function reclaimTree(entry) {
  // The endpoint that could revalidate ownership is exactly what is missing
  // here, so the recorded PID is only usable together with the start identity
  // recorded when it was registered. A PID whose start time differs — or cannot
  // be read at all — may belong to an unrelated process by now, and signalling
  // it would be worse than reporting blocked.
  const identity = processStartIdentity(entry.pid);
  if (identity === 'missing') return true;
  if (identity === 'unreadable' || typeof entry.processStartTime !== 'string' || entry.processStartTime !== identity) return false;
  const waitGone = async (budgetMs) => {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      if (treeGone(entry.pid)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(200, Math.max(1, deadline - Date.now()))));
    }
  };
  if (treeGone(entry.pid)) return true;
  signalTree(entry.pid, 'SIGTERM');
  if (await waitGone(ORPHAN_REAP_STAGE_MS)) return true;
  signalTree(entry.pid, 'SIGKILL');
  return waitGone(ORPHAN_REAP_STAGE_MS);
}
function teardownMarkerPath(file, worktree) {
  const resolved = path.resolve(worktree);
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return path.join(path.dirname(file), `teardown-${createHash('sha256').update(key).digest('hex').slice(0, 16)}.json`);
}
function writeRegistry(file, registry) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(registry, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(temporary, file);
}

export function serviceOwnership(entry, observed) {
  return ['pid', 'supervisorPid', 'cwd', 'commandFingerprint', 'startedAt'].every((key) => entry[key] !== undefined && entry[key] === observed[key])
    && Number.isSafeInteger(entry.pid) && entry.pid > 0 && observed.status === 'running';
}
function request(entry, action) {
  return new Promise((resolve) => {
    if (entry.status === 'stopped' && entry.teardownStatus === 'passed') { resolve({ status: 'stopped' }); return; }
    if (!Number.isSafeInteger(entry.pid) || entry.pid <= 0 || typeof entry.endpoint !== 'string'
      || !(entry.endpoint.startsWith('\\\\.\\pipe\\vibe-harness-') || entry.endpoint.startsWith(path.join(tmpdir(), 'vibe-harness-')))) {
      resolve({ status: 'blocked', reason: 'invalid-supervisor-endpoint' }); return;
    }
    const socket = createConnection(entry.endpoint);
    let buffer = '';
    const timer = setTimeout(() => { socket.destroy(); resolve({ status: 'blocked', reason: 'supervisor-timeout' }); }, 7000);
    socket.on('connect', () => socket.write(JSON.stringify({ action, ...Object.fromEntries(['pid', 'supervisorPid', 'cwd', 'commandFingerprint', 'startedAt'].map((key) => [key, entry[key]])) }) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 8192) { clearTimeout(timer); socket.destroy(); resolve({ status: 'blocked' }); return; }
      if (!buffer.includes('\n')) return;
      clearTimeout(timer); socket.destroy();
      // A reply is only usable when it is an object: valid JSON like `null`, a
      // string or an array would otherwise reach the callers, which read the
      // ownership fields off it immediately.
      try {
        const reply = JSON.parse(buffer);
        resolve(reply !== null && typeof reply === 'object' && !Array.isArray(reply)
          ? reply : { status: 'blocked', reason: 'invalid-supervisor-response' });
      } catch { resolve({ status: 'blocked', reason: 'invalid-supervisor-response' }); }
    });
    socket.on('error', () => { clearTimeout(timer); resolve({ status: 'blocked', reason: 'supervisor-unavailable' }); });
  });
}
async function stopEntry(entry, write) {
  const observed = await request(entry, 'status');
  if (observed.status === 'stopped') return { ...entry, status: 'stopped', teardownStatus: write ? 'passed' : 'unverified' };
  if (SUPERVISOR_UNREACHABLE.has(observed.reason)) {
    // Reclaiming signals a process tree, so a dry run reports what a write would
    // do instead of doing it: `runtime service stop` without `--write` and
    // `teardownServices(..., false)` must stay free of side effects.
    if (!write) return { ...entry, status: 'planned', teardownStatus: 'unverified', reason: observed.reason };
    return await reclaimTree(entry)
      ? { ...entry, status: 'stopped', teardownStatus: 'passed' }
      : { ...entry, status: 'blocked', teardownStatus: 'blocked', reason: 'service-tree-survives' };
  }
  if (!serviceOwnership(entry, observed)) return { ...entry, status: 'blocked', teardownStatus: 'blocked', reason: 'ownership-unproven' };
  if (!write) return { ...entry, status: 'planned', teardownStatus: 'unverified' };
  const stopped = await request(entry, 'stop');
  if (stopped.status === 'stopped') return { ...entry, status: 'stopped', teardownStatus: 'passed' };
  if (SUPERVISOR_UNREACHABLE.has(stopped.reason)) {
    return await reclaimTree(entry)
      ? { ...entry, status: 'stopped', teardownStatus: 'passed' }
      : { ...entry, status: 'blocked', teardownStatus: 'blocked', reason: 'service-tree-survives' };
  }
  return { ...entry, status: 'blocked', teardownStatus: 'blocked', reason: stopped.reason ?? 'service-tree-survives' };
}
async function locked(file, operation) {
  mkdirSync(path.dirname(file), { recursive: true });
  let descriptor;
  try { descriptor = openSync(`${file}.lock`, 'wx'); } catch { throw new Error('Service registry is locked'); }
  try { return await operation(); } finally { closeSync(descriptor); unlinkSync(`${file}.lock`); }
}

/** Ask a supervisor that is still connected to prove its tree gone, over IPC. */
function ipcRequest(child, message, timeoutMs) {
  return new Promise((resolve) => {
    if (!child.connected) { resolve({ status: 'unreachable' }); return; }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('message', onMessage);
      resolve(value);
    };
    const onMessage = (reply) => finish(reply && typeof reply === 'object' ? reply : { status: 'unreachable' });
    const timer = setTimeout(() => finish({ status: 'unreachable' }), timeoutMs);
    // The handshake channel is the only handle while the control endpoint does
    // not exist yet, so an unanswered abort ends as unreachable, never as gone.
    child.on('message', onMessage);
    try { child.send(message); } catch { finish({ status: 'unreachable' }); }
  });
}

/**
 * Abandon a start whose identity handshake never completed.
 *
 * The supervisor may have spawned a detached tree before it could report, so a
 * start is only reported as failed once that tree is proven gone. The supervisor
 * is asked to do the reaping — it owns the tree — and the identity the caller
 * already received is the fallback for a channel that is already closed.
 */
async function abortStart(child, spawned) {
  const reply = await ipcRequest(child, { action: 'abort' }, SUPERVISOR_ABORT_TIMEOUT_MS);
  if (reply.status === 'stopped') return { status: 'stopped' };
  if (spawned && Number.isSafeInteger(spawned.pid) && spawned.pid > 0) {
    const gone = await reclaimTree({ pid: spawned.pid, processStartTime: processStartIdentity(spawned.pid) });
    if (gone) return { status: 'stopped' };
  }
  return { status: 'blocked', reason: reply.reason ?? 'service-tree-unproven' };
}

export async function serviceReport(project, args, tokenize) {
  const action = args._[2] ?? 'status';
  if (!['start', 'status', 'stop'].includes(action)) throw new Error('runtime service <start|status|stop>');
  const config = JSON.parse(readFileSync(path.join(project, 'vibe-harness.config.json'), 'utf8'));
  validateDeliveryConfig(config);
  const file = registryPath(project);
  const worktree = realpathSync(project);
  const marker = teardownMarkerPath(file, worktree);
  const operation = async () => {
    const registry = readRegistry(file);
    if (action !== 'start') {
      const selected = registry.processes.filter((entry) => entry.worktree === worktree && (!args.service || entry.serviceId === args.service));
      if (args.service && !selected.length) return { status: 'blocked', reason: 'service-not-registered', processes: [] };
      const results = [];
      for (const entry of selected) {
        const result = action === 'stop' ? await stopEntry(entry, args.write) : await request(entry, 'status');
        if (action === 'status' && result.status === 'running' && !serviceOwnership(entry, result)) result.status = 'blocked';
        results.push({ ...entry, ...result });
        if (args.write && action === 'stop') Object.assign(entry, result);
      }
      if (args.write && action === 'stop') writeRegistry(file, registry);
      return { status: results.some((entry) => entry.status === 'blocked') ? 'blocked' : action === 'stop' && !args.write ? 'planned' : 'passed', processes: results };
    }
    const service = config.worktree?.provision?.services?.find((entry) => entry.id === args.service);
    if (!service) throw new Error('Select a declared --service');
    // A worktree whose services were torn down is waiting for its removal: a
    // start racing that removal would register a live service the caller can
    // no longer see. The marker is written inside the teardown lock, so the
    // window is closed from the first teardown step to the removal.
    if (existsSync(marker)) {
      if (existsSync(worktree)) return { status: 'blocked', reason: 'worktree-teardown-in-progress', processes: [] };
      unlinkSync(marker);
    }
    const cwd = realpathSync(path.resolve(worktree, service.cwd));
    if (path.relative(worktree, cwd).startsWith('..') || path.isAbsolute(path.relative(worktree, cwd))) throw new Error('Service cwd escapes worktree');
    const tokens = tokenize(service.command);
    const fingerprint = createHash('sha256').update(JSON.stringify([cwd, tokens])).digest('hex');
    for (const registered of registry.processes.filter((item) => item.worktree === worktree && item.serviceId === service.id && item.status !== 'stopped')) {
      // A live service is what "already registered" refuses: a start must never
      // silently replace a service that is still answering. Only a registration
      // whose supervisor can no longer answer for it is reclaimed, so a crashed
      // service does not block every later start forever.
      const observed = await request(registered, 'status');
      if (observed.status === 'running' && serviceOwnership(registered, observed)) {
        return { status: 'blocked', reason: 'service-already-registered', processes: [registered] };
      }
      const retired = await stopEntry(registered, true);
      Object.assign(registered, retired);
      // Persisted before the replacement is started: a registration that is
      // already retired must never still read as active because the start
      // failed (or threw) after this point.
      writeRegistry(file, registry);
      if (retired.status !== 'stopped') return { status: 'blocked', reason: 'service-already-registered', processes: [retired] };
    }
    const portsFile = path.join(path.dirname(file), 'worktree-ports.json');
    const ports = existsSync(portsFile) ? JSON.parse(readFileSync(portsFile, 'utf8')).entries : [];
    const assignment = ports?.find((entry) => path.resolve(entry.path ?? '') === worktree);
    const port = Number(args.port ?? assignment?.ports?.PORT ?? Object.values(assignment?.ports ?? {})[0]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('A registered port or --port is required');
    const entry = { taskId: args.task?.[0] ?? assignment?.id ?? 'local', serviceId: service.id, worktree, port, commandFingerprint: fingerprint, cwd, status: 'planned', teardownStatus: 'unverified', stopOnTeardown: service.stopOnTeardown };
    if (!args.write) return { status: 'planned', processes: [entry] };
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\vibe-harness-${randomUUID()}` : path.join(tmpdir(), `vibe-harness-${randomUUID()}.sock`);
    const child = spawn(process.execPath, [fileURLToPath(new URL('./service-supervisor.mjs', import.meta.url))], { cwd, detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    // The supervisor reports the service identity as soon as the tree is spawned
    // and the endpoint only once it answers, so a handshake that times out still
    // leaves the caller with the identity needed to reclaim what it started.
    let spawned = null;
    const identity = await new Promise((resolve) => {
      const timer = setTimeout(() => settle({ status: 'timeout' }), SUPERVISOR_START_TIMEOUT_MS);
      const settle = (message) => { clearTimeout(timer); child.removeListener('message', onMessage); resolve(message); };
      const onMessage = (message) => {
        if (message?.status === 'spawned') { spawned = message; return; }
        if (message && typeof message === 'object') settle(message);
      };
      child.on('message', onMessage);
      child.once('error', () => settle({ status: 'blocked' }));
      child.once('exit', () => settle({ status: 'blocked', reason: 'supervisor-exited' }));
      try { child.send({ cwd, tokens, port, endpoint }); } catch { settle({ status: 'blocked' }); }
    });
    child.unref();
    if (identity.status !== 'running') {
      const aborted = await abortStart(child, spawned);
      if (aborted.status !== 'stopped') {
        // The tree could not be proven gone, so it is registered as blocked: a
        // later start or teardown reclaims it through the identity recorded
        // here instead of starting a second service beside a live one.
        const pending = { ...entry, ...(spawned ?? identity), endpoint, status: 'blocked', teardownStatus: 'unverified', reason: aborted.reason };
        registry.processes.push(pending);
        writeRegistry(file, registry);
        return { status: 'blocked', reason: 'service-start-unproven', processes: [pending] };
      }
      return { status: 'blocked', reason: 'service-supervisor-start-failed', processes: [entry] };
    }
    const startIdentity = processStartIdentity(identity.pid);
    Object.assign(entry, identity, {
      endpoint,
      // The PID alone is only safe to signal while it can still be told apart
      // from a recycled one, so the OS start identity is recorded alongside it.
      ...(startIdentity === 'missing' || startIdentity === 'unreadable' ? {} : { processStartTime: startIdentity }),
    });
    registry.processes.push(entry);
    try { writeRegistry(file, registry); } catch (error) { await stopEntry(entry, true); throw error; }
    let healthy = false;
    const healthcheck = service.healthcheck.replaceAll('${PORT}', String(port));
    for (let attempt = 0; attempt < 10; attempt += 1) { try { healthy = (await fetch(healthcheck, { redirect: 'error', signal: AbortSignal.timeout(400) })).ok; } catch {} if (healthy) break; await new Promise((resolve) => setTimeout(resolve, 100)); }
    healthy = healthy && serviceOwnership(entry, await request(entry, 'status'));
    if (!healthy) { Object.assign(entry, await stopEntry(entry, true)); writeRegistry(file, registry); }
    return { status: healthy ? 'passed' : 'blocked', reason: healthy ? null : 'healthcheck-failed', processes: [entry] };
  };
  return { schemaVersion: 1, command: 'runtime', subcommand: `service ${action}`, ...(args.write && action !== 'status' ? await locked(file, operation) : await operation()) };
}

export async function teardownServices(project, worktree, write = true) {
  const file = registryPath(project);
  const marker = teardownMarkerPath(file, worktree);
  const operation = async () => {
    // A registry that does not exist yet is still read through the lock and
    // still leaves the marker: a `service start --write` racing this teardown
    // creates the first registry entry, and without either barrier it would
    // survive the worktree removal that the caller performs after `passed`.
    const registry = readRegistry(file); const results = [];
    for (const entry of registry.processes.filter((item) => path.resolve(item.worktree) === path.resolve(worktree) && item.status !== 'stopped')) {
      const result = entry.stopOnTeardown ? await stopEntry(entry, write) : { ...entry, status: 'blocked', reason: 'service-opted-out-of-teardown' };
      results.push(result); if (write) Object.assign(entry, result);
    }
    if (write && results.length) writeRegistry(file, registry);
    const status = results.some((entry) => entry.status === 'blocked') ? 'blocked' : 'passed';
    // Written before the lock is released so a concurrent `service start`
    // cannot slip between teardown and the caller's worktree removal.
    if (write && status === 'passed') {
      writeFileSync(marker, JSON.stringify({ createdAt: new Date().toISOString(), worktree: path.resolve(worktree) }, null, 2) + '\n', { flag: 'w', mode: 0o600 });
    }
    return { status, processes: results };
  };
  return write ? locked(file, operation) : operation();
}

/**
 * Release the teardown marker once the caller finished removing the worktree.
 *
 * A marker whose worktree is gone is residue, so `service start` clears it on
 * its own; this is the explicit release for the removal path that already knows
 * the worktree is gone.
 */
export function releaseServiceTeardown(project, worktree) {
  const marker = teardownMarkerPath(registryPath(project), worktree);
  if (!existsSync(marker)) return { released: false };
  unlinkSync(marker);
  return { released: true };
}
