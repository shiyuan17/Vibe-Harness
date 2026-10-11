import { spawn, spawnSync } from 'node:child_process';
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
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
/** True only when no part of the recorded tree can still be observed. */
function treeGone(pid) {
  if (process.platform === 'win32') return !processAlive(pid);
  try { process.kill(-pid, 0); return false; } catch (error) { return error.code !== 'EPERM'; }
}
function signalTree(pid, signal) {
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
  const waitGone = async (budgetMs) => {
    for (let waited = 0; waited < budgetMs; waited += 100) {
      if (treeGone(entry.pid)) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return treeGone(entry.pid);
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
      try { resolve(JSON.parse(buffer)); } catch { resolve({ status: 'blocked', reason: 'invalid-supervisor-response' }); }
    });
    socket.on('error', () => { clearTimeout(timer); resolve({ status: 'blocked', reason: 'supervisor-unavailable' }); });
  });
}
async function stopEntry(entry, write) {
  const observed = await request(entry, 'status');
  if (observed.status === 'stopped') return { ...entry, status: 'stopped', teardownStatus: 'passed' };
    if (SUPERVISOR_UNREACHABLE.has(observed.reason)) {
      return await reclaimTree(entry)
        ? { ...entry, status: 'stopped', teardownStatus: 'passed' }
        : { ...entry, status: 'blocked', teardownStatus: 'blocked', reason: 'service-tree-survives' };
    }
  if (!serviceOwnership(entry, observed)) return { ...entry, status: 'blocked', teardownStatus: 'blocked', reason: 'ownership-unproven' };
  if (!write) return { ...entry, status: 'planned' };
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
      if (retired.status !== 'stopped') return { status: 'blocked', reason: 'service-already-registered', processes: [retired] };
      Object.assign(registered, retired);
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
    const identity = await new Promise((resolve) => { const timer = setTimeout(() => { child.kill(); resolve({ status: 'blocked' }); }, 5000); child.once('message', (message) => { clearTimeout(timer); resolve(message); }); child.once('error', () => { clearTimeout(timer); resolve({ status: 'blocked' }); }); child.send({ cwd, tokens, port, endpoint }); });
    child.unref();
    if (identity.status !== 'running') return { status: 'blocked', reason: 'service-supervisor-start-failed' };
    Object.assign(entry, identity, { endpoint });
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
  if (!existsSync(file)) return { status: 'passed', processes: [] };
  const marker = teardownMarkerPath(file, worktree);
  const operation = async () => {
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
