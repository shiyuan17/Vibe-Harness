import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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
// Asking the recorded port whether the service it started is still serving: a
// refusal is the answer, a timeout or any other failure is "cannot tell".
const PORT_PROBE_TIMEOUT_MS = 1000;
// Replacements of the registry file are retried instead of failing the command:
// Windows keeps a destination that another handle has open (an indexer or a
// scanner) locked for a moment, and a start that could not persist its own
// registration would have to be torn down again.
const REGISTRY_RENAME_ATTEMPTS = 5;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Every field a supervisor echoes back and a caller has to prove it recorded.
// `processStartTime` is the OS start identity of the owned root, and
// `controlToken` is the per-supervisor secret the control endpoint requires, so
// a local user who can enumerate the endpoint cannot replay the ownership
// fields learnt from a `status` reply to authorize a `stop`.
export const SUPERVISOR_IDENTITY_KEYS = Object.freeze([
  'pid', 'supervisorPid', 'cwd', 'commandFingerprint', 'startedAt', 'processStartTime', 'controlToken',
]);
// The start handshake covers spawning the service, binding the control endpoint
// and answering it; the abort that follows asks the same supervisor to prove the
// tree gone before a failed start is reported as clean.
const SUPERVISOR_START_TIMEOUT_MS = 20000;
const SUPERVISOR_ABORT_TIMEOUT_MS = 30000;
// A Windows process tree cannot be asked for a group the way a Unix process
// group can: `WMI` is walked from the recorded root, because a launcher that
// exits while the server it spawned keeps running leaves descendants whose
// only link to the root is that parent field.
// The walk runs over two snapshots separated by a settle delay: one snapshot is
// a race, because a descendant created after it was taken is absent from it and
// an empty set would then be read as "the tree is gone". Unioning two
// observations makes an empty answer mean "nothing was observed twice".
// The probe travels as base64 of its request, like the member probe below: the
// expected root identity comes from the registry, which a local user can edit,
// and interpolating it into PowerShell source would make a tampered entry
// executable. Decoding a fixed script keeps every field out of the code path.
//
// Two things are decided inside the probe, where the observations are made:
//   * the recorded root identity is compared before the walk, so a recycled PID
//     never becomes the root of a walk (the tree such a number leads is not this
//     tree's to observe or kill), and
//   * each member is admitted with the time of the snapshot it was seen in, so a
//     PID read again at the end of the walk has to be the process that was
//     observed then — a replacement created after that snapshot is not a member.
const WINDOWS_TREE_PROBE = [
  "$request = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('<REQUEST>')))",
  "$ErrorActionPreference = 'Stop'",
  '$root = [int]$request.root',
  '$expected = [string]$request.startIdentity',
  "if ($expected -ne '') {",
  '  $rootProcess = Get-Process -Id $root -ErrorAction SilentlyContinue',
  '  if ($rootProcess) {',
  "    try { $rootActual = $rootProcess.StartTime.ToUniversalTime().ToString('o') } catch { $rootActual = '' }",
  "    if ($rootActual -ne '' -and $rootActual -ne $expected) { Write-Error 'root-process-reused'; exit 1 }",
  '  }',
  '}',
  'function Snapshot { @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId) }',
  "$ids = New-Object 'System.Collections.Generic.HashSet[int]'",
  '$seen = @{}',
  '$probeStart = (Get-Date).ToUniversalTime()',
  '[void]$ids.Add([int]$root)',
  '$seen[[int]$root] = $probeStart',
  'for ($pass = 0; $pass -lt 2; $pass += 1) {',
  '  $stamp = (Get-Date).ToUniversalTime()',
  '  $all = @(Snapshot)',
  '  do { $added = 0; foreach ($process in $all) { if ($ids.Contains([int]$process.ParentProcessId) -and $ids.Add([int]$process.ProcessId)) { $added += 1; $seen[[int]$process.ProcessId] = $stamp } } } while ($added -gt 0)',
  '  if ($pass -eq 0) { Start-Sleep -Milliseconds 150 }',
  '}',
  '$live = @()',
  'foreach ($id in $ids) {',
  '  $process = Get-Process -Id $id -ErrorAction SilentlyContinue',
  '  if (-not $process) { continue }',
  '  try {',
  '    $started = $process.StartTime.ToUniversalTime()',
  "    if ($started -gt $seen[$id]) { if ($id -eq $root) { Write-Error 'root-process-reused'; exit 1 } else { continue } }",
  "    $live += \"$id=\" + $started.ToString('o')",
  '  } catch { $live += "$id=" }',
  '}',
  'Write-Output ($live -join ",")',
].join('\n');

// The tree probe above only walks the ancestry of the recorded root, so a
// descendant whose intermediate parent exited is no longer reachable through it.
// Members observed while the tree was alive are therefore kept by the caller and
// asked about as `{pid, startIdentity}` records: a recycled PID is then rejected
// by the identity instead of being killed as if it were part of this tree.
//
// The records travel as base64 of their JSON. They come from the registry and
// from supervisor replies that a local user can read and edit, and the probe is
// PowerShell source: interpolating an identity into it would let a tampered
// registry run commands. Decoding a fixed script from an opaque payload keeps
// every field out of the code path.
const WINDOWS_MEMBER_PROBE = [
  "$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('<MEMBERS>'))",
  "$ErrorActionPreference = 'Stop'",
  // Windows PowerShell 5.1 emits the JSON array as one pipeline object.
  // Assign it first so foreach enumerates its members rather than a nested array.
  '$members = ConvertFrom-Json $json',
  '$live = @()',
  'foreach ($item in $members) {',
  '  try { $process = Get-Process -Id ([int]$item.pid) -ErrorAction Stop } catch {',
  "    if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { continue }",
  '    throw',
  '  }',
  "  if ($process.StartTime.ToUniversalTime().ToString('o') -eq $item.startIdentity) { $live += [int]$item.pid }",
  '}',
  'Write-Output ($live -join ",")',
].join('\n');

function windowsProbeRunner(probe) {
  return probe ?? ((command) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true,
  }));
}

function parsePidList(output) {
  const text = String(output ?? '').trim();
  return text === ''
    ? []
    : text.split(',').map((value) => Number.parseInt(value.trim(), 10)).filter((value) => Number.isSafeInteger(value) && value > 0);
}

/**
 * `pid=start-identity` records from one probe.
 *
 * An empty identity means the process is there but its start time could not be
 * read (a protected or other-user process): that member is alive and cannot be
 * told apart from a recycled PID, which is exactly why it is reported instead of
 * being dropped.
 */
function parseMemberRecords(output) {
  const text = String(output ?? '').trim();
  if (text === '') return [];
  return text.split(',').map((entry) => {
    const [rawPid, identity] = entry.trim().split('=', 2);
    const pid = Number.parseInt(rawPid, 10);
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    return { pid, startIdentity: typeof identity === 'string' && identity !== '' ? identity : null };
  }).filter(Boolean);
}

/** The PowerShell program of one Windows tree walk, so callers can run it async. */
export function windowsTreeProbeCommand(rootPid, startIdentity = '') {
  const request = Buffer.from(JSON.stringify({
    root: rootPid,
    startIdentity: typeof startIdentity === 'string' ? startIdentity : '',
  }), 'utf8').toString('base64');
  return WINDOWS_TREE_PROBE.replace('<REQUEST>', request);
}

/**
 * A recorded start identity as a value the tree probe can compare, or ''.
 *
 * `missing` and `unreadable` are the probes' non-token answers: they travel in
 * the control protocol, but comparing them would either always fail or always
 * pass, so only a real token is handed to the walk.
 */
export function startIdentityToken(value) {
  return typeof value === 'string' && value !== '' && value !== 'missing' && value !== 'unreadable' ? value : '';
}

/** The members described by one tree-walk output. */
export function parseTreeMembers(output) {
  return parseMemberRecords(output);
}

/**
 * True for a member list read from caller-readable state (the registry, or a
 * supervisor reply): a PID without a usable start identity carries no ownership
 * and is dropped rather than trusted.
 */
export function validTreeMembers(value) {
  if (!Array.isArray(value)) return [];
  const members = new Map();
  for (const member of value) {
    if (member === null || typeof member !== 'object' || Array.isArray(member)) continue;
    if (!Number.isSafeInteger(member.pid) || member.pid <= 0) continue;
    if (typeof member.startIdentity !== 'string' || member.startIdentity === '') continue;
    members.set(member.pid, { pid: member.pid, startIdentity: member.startIdentity });
  }
  return [...members.values()];
}

// The Unix control socket is published inside a directory only its owner can
// traverse. The socket file is created by `listen()` before any chmod can run,
// so a shared temp directory would leave a window in which another local user
// can enumerate and connect to an endpoint that has no other authorization.
const SOCKET_DIRECTORY_PREFIX = 'vibe-harness-sockets-';

/** The owner-only directory the Unix control sockets live in. */
export function serviceSocketDirectory() {
  const owner = typeof process.getuid === 'function' ? process.getuid() : 'default';
  return path.join(tmpdir(), `${SOCKET_DIRECTORY_PREFIX}${owner}`);
}

/** A control endpoint name in this user's namespace. */
export function serviceEndpoint(namespace = randomUUID()) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\vibe-harness-${namespace}`
    : path.join(serviceSocketDirectory(), `vibe-harness-${namespace}.sock`);
}

/**
 * True only for an endpoint this user's supervisor could have published.
 *
 * The registry is caller-readable state, so the endpoint name in it is
 * untrusted input: anything else may name an unrelated socket owned by someone
 * else whose `stop` would then be authorized by this process.
 */
function validServiceEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint === '') return false;
  if (process.platform === 'win32') return /^\\\\\.\\pipe\\vibe-harness-[0-9a-f-]{1,64}$/iu.test(endpoint);
  return path.dirname(endpoint) === serviceSocketDirectory()
    && /^vibe-harness-[0-9a-f-]{1,64}\.sock$/iu.test(path.basename(endpoint));
}

/**
 * Every live member of the process tree rooted at `rootPid`, or null.
 *
 * Null means the probe could not answer. It is deliberately not an empty list:
 * "no survivors observed" and "could not observe" are different facts, and only
 * the first one is proof that a tree is gone. Each member carries the start
 * identity read in the same snapshot, so a later decision about that PID can be
 * made against the process it was, not the number it was.
 */
export function windowsTreeMembers(rootPid, { probe = undefined, startIdentity = '' } = {}) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) return [];
  const run = windowsProbeRunner(probe);
  let output;
  try {
    output = run(windowsTreeProbeCommand(rootPid, startIdentity));
  } catch {
    return null;
  }
  return parseMemberRecords(output);
}

/**
 * Every live PID of the process tree rooted at `rootPid`, or null.
 *
 * The PID-only view of `windowsTreeMembers`, for callers that only need the
 * liveness answer.
 */
export function windowsTreePids(rootPid, { probe = undefined, startIdentity = '' } = {}) {
  const members = windowsTreeMembers(rootPid, { probe, startIdentity });
  return members === null ? null : members.map((member) => member.pid);
}

/**
 * The members of one explicit set that are still the recorded processes.
 *
 * Each member is matched against its recorded start identity in the probe
 * itself, so a PID that has been recycled to an unrelated process is reported as
 * absent — the number is gone from this tree's point of view. Null means the
 * probe could not answer at all.
 */
export function windowsConfirmedMembers(members, { probe = undefined } = {}) {
  const targets = validTreeMembers(members);
  if (targets.length === 0) return [];
  const run = windowsProbeRunner(probe);
  const encoded = Buffer.from(JSON.stringify(targets), 'utf8').toString('base64');
  try {
    const alive = parsePidList(run(WINDOWS_MEMBER_PROBE.replace('<MEMBERS>', encoded)));
    return targets.filter((member) => alive.includes(member.pid));
  } catch {
    return null;
  }
}

/**
 * The live members of a Windows tree, including the ones it was already observed
 * to hold.
 *
 * A descendant whose launcher exited before the first snapshot cannot be
 * connected to the root by parent fields ever again, so the ancestry walk alone
 * would report an empty tree while that process is still serving. `tracked`
 * carries what earlier observations saw — with the start identity of each of
 * those processes — and the result is the union of the current walk and the
 * recorded members that still match their own identity.
 */
export function windowsTreeLive(rootPid, tracked = [], { probe = undefined, startIdentity = '' } = {}) {
  const walked = windowsTreeMembers(rootPid, { probe, startIdentity });
  if (walked === null) return null;
  const known = validTreeMembers(tracked).filter((member) => !walked.some((candidate) => candidate.pid === member.pid));
  if (known.length === 0) return walked;
  const alive = windowsConfirmedMembers(known, { probe });
  return alive === null ? null : [...walked, ...alive];
}

/**
 * True only when no part of the recorded tree can still be observed.
 *
 * Unix answers from the process group, and only `ESRCH` is proof: `EPERM` means
 * the group still exists and merely cannot be signalled by this user. Windows
 * answers from the tree probe above, so a root that exited while a descendant
 * survived is not reported as gone.
 *
 * A recorded root identity turns a recycled PID into an unanswerable probe: the
 * tree a replacement number leads is not this tree's, so nothing is concluded
 * about it (the walk refuses instead of reporting it as gone).
 *
 * A PID that is not a positive integer answers nothing: an entry recorded
 * without one describes a tree whose start was never proven gone, so reading it
 * as "gone" would let a later start shadow a service that is still serving.
 */
export function treeGone(pid, { probe = undefined, tracked = [], startIdentity = '' } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (process.platform === 'win32') {
    const live = windowsTreeLive(pid, tracked, { probe, startIdentity });
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
  if (process.platform === 'linux') {
    // `/proc/<pid>/stat` field 22 is the process start time in clock ticks
    // since boot: a kernel token, so a recycled PID cannot reproduce it. The
    // command name is free-form and may contain spaces or parentheses, so the
    // fixed fields are read after the last `)`.
    let stat;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch (error) {
      return error.code === 'ENOENT' ? 'missing' : 'unreadable';
    }
    const close = stat.lastIndexOf(')');
    const startTicks = close === -1 ? undefined : stat.slice(close + 2).trim().split(' ')[19];
    return startTicks !== undefined && /^[0-9]+$/u.test(startTicks) ? `linux-start:${startTicks}` : 'unreadable';
  }
  // The remaining Unix hosts expose no kernel start token through a portable
  // command: `ps -o lstart=` has one-second precision, and a start time repeated
  // with the parent and the executable is a tuple a recycled PID can reproduce.
  // A PID that is provably gone is still reported as `missing` — that answer
  // authorizes nothing but "there is nothing here" — while a live PID is
  // `unreadable`, so `reclaimTree()` stays blocked instead of signalling a
  // process whose ownership it cannot prove.
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return 'missing';
  }
  return 'unreadable';
}
/**
 * Signal the recorded tree, and report whether anything was signalled.
 *
 * A Windows tree cannot be signalled by group, so each PID the tree walk or the
 * tracked set still sees is killed directly — `taskkill /t` would walk down from
 * a root that may already be gone. Nothing is signalled when the probe cannot
 * answer: the recorded PID may have been reused, and a transient probe failure
 * is not evidence that this process owns it.
 */
export function signalTree(pid, signal, { tracked = [], probe = undefined, startIdentity = '' } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (process.platform === 'win32') {
    const observed = windowsTreeLive(pid, tracked, { probe, startIdentity });
    if (observed === null || observed.length === 0) return false;
    // A member whose identity could not be read is not signalled: a number that
    // cannot be told apart from a recycled one is not this tree's to kill. The
    // tree then stays "not proven gone", which is the safe answer.
    const confirmed = observed.filter((member) => typeof member.startIdentity === 'string' && member.startIdentity !== '');
    if (confirmed.length === 0) return false;
    for (const member of confirmed) {
      spawnSync('taskkill.exe', ['/pid', String(member.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true, timeout: 4000 });
    }
    return confirmed.length === observed.length;
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false; // the group is already gone
  }
}
/**
 * True when something accepts TCP connections on `port`, false when nothing
 * does, null when the question cannot be answered.
 *
 * Only asked where a Windows ancestry walk cannot answer — a recorded root that
 * is already gone leaves nothing to walk — so the port is the remaining
 * observable that says whether the service this entry started is still serving.
 * A refused or unroutable connection is the "nothing is listening" answer; any
 * other failure is reported as unknown, which keeps the entry blocked.
 */
function portListening(port, { host = '127.0.0.1', timeoutMs = PORT_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) { resolve(null); return; }
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (value, { abort = true } = {}) => {
      if (settled) return;
      settled = true;
      if (abort) {
        socket.destroy();
      } else {
        // A listener that answered the probe is closed politely: draining the
        // reply and half-closing avoids the RST an abort with unread data in
        // flight provokes, which the service would observe as a spurious
        // `ECONNRESET` inside its own accept loop.
        socket.on('data', () => {});
        socket.end();
        socket.unref();
      }
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(null));
    socket.once('connect', () => finish(true, { abort: false }));
    socket.once('error', (error) => {
      const code = error?.code;
      finish(code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' ? false : null);
    });
  });
}

/** A service terminal state needs tree evidence and, on Windows, a released port. */
export async function serviceTreeGone(entry) {
  if (!treeGone(entry.pid, {
    tracked: validTreeMembers(entry.treeMembers),
    startIdentity: startIdentityToken(entry.processStartTime),
  })) return false;
  return process.platform !== 'win32' || await portListening(entry.port) === false;
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
  // Descendants observed while the tree was still alive travel with the entry:
  // on Windows an ancestry walk cannot reconnect a process whose intermediate
  // parent has exited, so the recorded samples — each with its own start
  // identity — are the only handle left on it.
  const tracked = validTreeMembers(entry.treeMembers);
  const identity = processStartIdentity(entry.pid);
  // A missing root PID is not proof the tree is gone: a launcher or group
  // leader can exit while the descendants it spawned keep the group alive, and
  // that tree is exactly what a restart must not shadow.
  if (identity === 'missing') {
    // Unix answers from the process group, which the descendants stay in even
    // after its leader exited, so `ESRCH` is proof there.
    if (process.platform !== 'win32') return treeGone(entry.pid, { tracked });
    // Windows has no process group, and the ancestry walk starts at the recorded
    // root: with that root gone the walk answers nothing, so an empty answer is
    // the absence of a probe rather than evidence about a descendant. Two
    // observables remain, and both have to agree before the entry is retired:
    // the members recorded while the tree was alive are asked about by their own
    // identity (an ancestry walk can no longer reach them), and the recorded port
    // is asked whether anything still accepts connections on it — a service that
    // outlived its root is exactly what a replacement must not shadow.
    const alive = windowsConfirmedMembers(tracked);
    if (alive === null || alive.length > 0) return false;
    return await portListening(entry.port) === false;
  }
  if (identity === 'unreadable' || typeof entry.processStartTime !== 'string' || entry.processStartTime !== identity) return false;
  const waitGone = async (budgetMs) => {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      if (await serviceTreeGone(entry)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(200, Math.max(1, deadline - Date.now()))));
    }
  };
  const recordedIdentity = startIdentityToken(entry.processStartTime);
  if (await serviceTreeGone(entry)) return true;
  signalTree(entry.pid, 'SIGTERM', { tracked, startIdentity: recordedIdentity });
  if (await waitGone(ORPHAN_REAP_STAGE_MS)) return true;
  signalTree(entry.pid, 'SIGKILL', { tracked, startIdentity: recordedIdentity });
  return waitGone(ORPHAN_REAP_STAGE_MS);
}
/**
 * The canonical spelling of a worktree path, for comparing one recorded path
 * against another.
 *
 * Windows exposes a single directory under more than one name: an 8.3 short
 * name (`RUNNER~1`), a junction, or a case the caller typed differently. The
 * ordinary realpath walk keeps whichever spelling it was handed, so a registry
 * entry written for this worktree can carry a different string than the path
 * this command resolved for the same directory — and comparing the two as text
 * would report a registered service as belonging to another worktree. The
 * native call returns the canonical spelling, and the longest existing ancestor
 * is canonicalized with the rest appended, so a worktree that has already been
 * removed keeps a stable key instead of falling back to a typed alias.
 */
function canonicalWorktree(value) {
  const typed = path.resolve(String(value ?? ''));
  const suffix = [];
  let current = typed;
  for (;;) {
    try {
      const canonical = realpathSync.native ? realpathSync.native(current) : realpathSync(current);
      return suffix.length === 0 ? canonical : path.join(canonical, ...suffix);
    } catch (error) {
      if (error.code !== 'ENOENT') return typed;
      const parent = path.dirname(current);
      if (parent === current) return typed;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function teardownMarkerPath(file, worktree) {
  const resolved = canonicalWorktree(worktree);
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return path.join(path.dirname(file), `teardown-${createHash('sha256').update(key).digest('hex').slice(0, 16)}.json`);
}
/**
 * Persist the registry through an exclusively created temporary file.
 *
 * The lock file already serializes writers, so the only failure left is a
 * replacement the OS refuses: on Windows a destination that another handle has
 * open (an indexer, a scanner) is locked for a moment, which is why the rename
 * is retried and the exhausted path then still replaces the destination by name
 * — after proving it is a regular file. Copying over the destination is not the
 * fallback: `copyFileSync` follows a destination symlink, so a registry swapped
 * for a link after it was read would be written through to an arbitrary file.
 */
async function writeRegistry(file, registry) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(registry, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(temporary, file);
      return;
    } catch (error) {
      if (attempt >= REGISTRY_RENAME_ATTEMPTS) {
        const existing = lstatSync(file, { throwIfNoEntry: false });
        if (existing && !existing.isFile()) {
          try { unlinkSync(temporary); } catch { /* the temporary file is gone */ }
          throw error;
        }
        try {
          unlinkSync(file);
        } catch { /* the destination is already gone */ }
        try {
          renameSync(temporary, file);
        } catch {
          try { unlinkSync(temporary); } catch { /* the temporary file is gone */ }
          throw error;
        }
        return;
      }
      await sleep(25 * (attempt + 1));
    }
  }
}

/**
 * True only when every recorded ownership field — including the per-supervisor
 * control token and the OS start identity — is echoed back exactly.
 *
 * The control endpoint has no OS-level authorization, so this comparison is what
 * authorizes acting on a reply. It is deliberately independent of the reported
 * status: both the `running` answer and the terminal `stopped` answer have to
 * prove the same identity before they are believed.
 */
function identityProven(entry, observed) {
  // Every field has to be present on both sides: an "absent on both sides"
  // exception would let a tampered or legacy entry without `controlToken` (or
  // without the OS start identity) be answered by whatever process binds the
  // recorded endpoint and omits the same fields, so the reply would authorize an
  // action while proving nothing.
  const matches = SUPERVISOR_IDENTITY_KEYS.every((key) => entry[key] !== undefined
    && observed[key] !== undefined && entry[key] === observed[key]);
  return matches && Number.isSafeInteger(entry.pid) && entry.pid > 0;
}

export function serviceOwnership(entry, observed) {
  // `controlToken` is what keeps a local user who can reach the endpoint from
  // replaying the ownership fields of a `status` reply into a `stop`, and every
  // field has to be present on both sides for the same reason.
  return identityProven(entry, observed) && observed.status === 'running';
}
function request(entry, action, timeoutMs = 7000) {
  return new Promise((resolve) => {
    if (!Number.isSafeInteger(entry.pid) || entry.pid <= 0 || !validServiceEndpoint(entry.endpoint)) {
      resolve({ status: 'blocked', reason: 'invalid-supervisor-endpoint' }); return;
    }
    const socket = createConnection(entry.endpoint);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ status: 'blocked', reason: 'supervisor-timeout' });
    }, Math.max(1, Math.min(7000, timeoutMs)));
    socket.on('connect', () => socket.write(JSON.stringify({ action, ...Object.fromEntries(SUPERVISOR_IDENTITY_KEYS.map((key) => [key, entry[key]])) }) + '\n'));
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
async function stopEntry(entry, write, timeoutMs = 7000) {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  const remaining = () => Math.max(1, deadline - Date.now());
  // A retired endpoint may already belong to someone else. Revalidate the
  // recorded tree locally; never fabricate a supervisor reply from the cache.
  if (entry.status === 'stopped' && entry.teardownStatus === 'passed') {
    // A replacement can legitimately own the old port or PID by now. A prior
    // terminal result is rechecked by its recorded identities, not a fresh walk
    // from a recycled root or a port that belongs to the replacement.
    const token = startIdentityToken(entry.processStartTime);
    const members = process.platform === 'win32' && token && Number.isSafeInteger(entry.pid) && entry.pid > 0
      ? windowsConfirmedMembers([{ pid: entry.pid, startIdentity: token }, ...validTreeMembers(entry.treeMembers)])
      : null;
    const gone = members !== null ? members.length === 0 : await serviceTreeGone(entry);
    return gone
      ? { ...entry, reason: null }
      : { ...entry, status: 'blocked', teardownStatus: 'blocked', reason: 'service-tree-survives' };
  }
  // The terminal answers carry the same identity evidence as `running`: a
  // `stopped` reply is only accepted from the supervisor the entry recorded.
  const withEvidence = (value, observed) => (Array.isArray(observed?.treeMembers)
    ? { ...value, treeMembers: validTreeMembers(observed.treeMembers) } : value);
  // The tree evidence of every sample seen in this call, so a reclaim that
  // cannot ask the supervisor again still asks about descendants that an
  // ancestry walk can no longer reach.
  const trackedWith = (...sources) => {
    const members = new Map();
    for (const source of sources) for (const member of validTreeMembers(source)) members.set(member.pid, member);
    return [...members.values()];
  };
  const observed = await request(entry, 'status', remaining());
  if (observed.status === 'stopped') {
    // The endpoint name is per user, not per supervisor, so after the recorded
    // supervisor exited another process can bind the same endpoint and answer
    // `stopped` for a tree that is still serving. Only the identity proves who
    // answered, exactly as it does for `running`.
    if (!identityProven(entry, observed)) return withEvidence({ ...entry, status: 'blocked', teardownStatus: 'blocked', reason: 'ownership-unproven' }, observed);
    if (!await serviceTreeGone({ ...entry, treeMembers: trackedWith(entry.treeMembers, observed.treeMembers) })) {
      return withEvidence({ ...entry, status: 'blocked', teardownStatus: 'blocked', reason: 'service-tree-survives' }, observed);
    }
    return withEvidence({ ...entry, status: 'stopped', teardownStatus: write ? 'passed' : 'unverified', reason: null }, observed);
  }
  if (SUPERVISOR_UNREACHABLE.has(observed.reason)) {
    // Reclaiming signals a process tree, so a dry run reports what a write would
    // do instead of doing it: `runtime service stop` without `--write` and
    // `teardownServices(..., false)` must stay free of side effects.
    if (!write) return { ...entry, status: 'planned', teardownStatus: 'unverified', reason: observed.reason };
    if (Date.now() >= deadline) return { ...entry, status: 'blocked', teardownStatus: 'blocked', reason: 'cleanup-timeout' };
    return await reclaimTree(entry)
      ? { ...entry, status: 'stopped', teardownStatus: 'passed', reason: null }
      : { ...entry, status: 'blocked', teardownStatus: 'blocked', reason: 'service-tree-survives' };
  }
  if (!identityProven(entry, observed) || !['running', 'stopping', 'blocked'].includes(observed.status)) {
    return { ...entry, status: 'blocked', teardownStatus: 'blocked', reason: 'ownership-unproven' };
  }
  if (!write) return { ...entry, status: 'planned', teardownStatus: 'unverified' };
  if (Date.now() >= deadline) return { ...entry, status: 'blocked', teardownStatus: 'blocked', reason: 'cleanup-timeout' };
  const stopped = await request(entry, 'stop', remaining());
  if (stopped.status === 'stopped') {
    if (!identityProven(entry, stopped)) return withEvidence({ ...entry, status: 'blocked', teardownStatus: 'blocked', reason: 'ownership-unproven' }, stopped);
    // The identity proves who answered, not that the tree is really gone: a
    // process that binds the recorded endpoint can echo the recorded fields and
    // answer `stopped` for a tree that is still serving. The answer is therefore
    // only evidence together with an observation that no part of the recorded
    // tree is left.
    const tracked = trackedWith(entry.treeMembers, observed.treeMembers, stopped.treeMembers);
    if (!await serviceTreeGone({ ...entry, treeMembers: tracked })) {
      return withEvidence({ ...entry, status: 'blocked', teardownStatus: 'blocked', reason: 'service-tree-survives' }, stopped);
    }
    return withEvidence({ ...entry, status: 'stopped', teardownStatus: 'passed', reason: null }, stopped);
  }
  if (SUPERVISOR_UNREACHABLE.has(stopped.reason)) {
    // The successful `status` reply above is newer evidence than the registry
    // entry, so its tree members travel into the reclaim: on Windows a
    // descendant whose launcher exited is only known through those samples.
    if (Date.now() >= deadline) return { ...entry, status: 'blocked', teardownStatus: 'blocked', reason: 'cleanup-timeout' };
    return await reclaimTree({ ...entry, treeMembers: trackedWith(entry.treeMembers, observed.treeMembers) })
      ? { ...entry, status: 'stopped', teardownStatus: 'passed', reason: null }
      : { ...entry, status: 'blocked', teardownStatus: 'blocked', reason: 'service-tree-survives' };
  }
  return withEvidence({ ...entry, status: 'blocked', teardownStatus: 'blocked', reason: stopped.reason ?? 'service-tree-survives' }, stopped);
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
    // The startup handshake shares this channel, so a `spawned` or `running`
    // message queued before the abort was sent must not be mistaken for its
    // answer: only the terminal abort result settles this wait.
    const onMessage = (reply) => {
      if (reply?.status === 'spawned' || reply?.status === 'running') return;
      finish(reply && typeof reply === 'object' ? reply : { status: 'unreachable' });
    };
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
async function abortStart(child, spawned, spawnedStartTime) {
  const reply = await ipcRequest(child, { action: 'abort' }, SUPERVISOR_ABORT_TIMEOUT_MS);
  if (reply.status === 'stopped') return { status: 'stopped' };
  if (spawned && Number.isSafeInteger(spawned.pid) && spawned.pid > 0) {
    // Only the identity captured when `spawned` was received is usable: probing
    // the PID here could read a replacement process that took the number over
    // while the abort waited, and reclaiming would then signal a stranger.
    const gone = await reclaimTree({
      pid: spawned.pid,
      processStartTime: spawnedStartTime,
      // Every member already reported travels with the abort: this reclaim
      // cannot ask the supervisor again, and on Windows a descendant whose
      // intermediate parent exited is only reachable through those samples.
      treeMembers: spawned.treeMembers,
    });
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
  const worktree = canonicalWorktree(project);
  const marker = teardownMarkerPath(file, worktree);
  const operation = async () => {
    const registry = readRegistry(file);
    if (action !== 'start') {
      const selected = registry.processes.filter((entry) => canonicalWorktree(entry.worktree) === worktree && (!args.service || entry.serviceId === args.service));
      if (args.service && !selected.length) return { status: 'blocked', reason: 'service-not-registered', processes: [] };
      const results = [];
      for (const entry of selected) {
        const result = action === 'stop' || entry.status === 'stopped' && entry.teardownStatus === 'passed'
          ? await stopEntry(entry, args.write) : await request(entry, 'status');
        if (action === 'status' && result.status === 'running' && !serviceOwnership(entry, result)) result.status = 'blocked';
        results.push({ ...entry, ...result });
        if (args.write && action === 'stop') Object.assign(entry, result);
      }
      if (args.write && action === 'stop') await writeRegistry(file, registry);
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
    for (const registered of registry.processes.filter((item) => canonicalWorktree(item.worktree) === worktree && item.serviceId === service.id && item.status !== 'stopped')) {
      // A live service is what "already registered" refuses: a start must never
      // silently replace a service that is still answering. Only a registration
      // whose supervisor can no longer answer for it is reclaimed, so a crashed
      // service does not block every later start forever.
      const observed = await request(registered, 'status');
      if (observed.status === 'running' && serviceOwnership(registered, observed)) {
        return { status: 'blocked', reason: 'service-already-registered', processes: [registered] };
      }
      // Reclaiming signals a process and rewrites the registry, so a start
      // without `--write` only reports what it would have to reclaim: the
      // dry-run answer is the caller's chance to see the plan before any of it
      // happens.
      if (!args.write) return { status: 'planned', reason: 'service-reclaim-required', processes: [registered] };
      const retired = await stopEntry(registered, true);
      Object.assign(registered, retired);
      // Persisted before the replacement is started: a registration that is
      // already retired must never still read as active because the start
      // failed (or threw) after this point.
      await writeRegistry(file, registry);
      if (retired.status !== 'stopped') return { status: 'blocked', reason: 'service-already-registered', processes: [retired] };
    }
    const portsFile = path.join(path.dirname(file), 'worktree-ports.json');
    const ports = existsSync(portsFile) ? JSON.parse(readFileSync(portsFile, 'utf8')).entries : [];
    const assignment = ports?.find((entry) => path.resolve(entry.path ?? '') === worktree);
    const port = Number(args.port ?? assignment?.ports?.PORT ?? Object.values(assignment?.ports ?? {})[0]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('A registered port or --port is required');
    const entry = { taskId: args.task?.[0] ?? assignment?.id ?? 'local', serviceId: service.id, worktree, port, commandFingerprint: fingerprint, cwd, status: 'planned', teardownStatus: 'unverified', stopOnTeardown: service.stopOnTeardown };
    if (!args.write) return { status: 'planned', processes: [entry] };
    const endpoint = serviceEndpoint();
    const child = spawn(process.execPath, [fileURLToPath(new URL('./service-supervisor.mjs', import.meta.url))], { cwd, detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    // The supervisor reports the service identity as soon as the tree is spawned
    // and the endpoint only once it answers, so a handshake that times out still
    // leaves the caller with the identity needed to reclaim what it started.
    let spawned = null;
    let spawnedStartTime = null;
    const identity = await new Promise((resolve) => {
      const timer = setTimeout(() => settle({ status: 'timeout' }), SUPERVISOR_START_TIMEOUT_MS);
      const settle = (message) => { clearTimeout(timer); child.removeListener('message', onMessage); resolve(message); };
      const onMessage = (message) => {
        if (message?.status === 'spawned') {
          spawned = message;
          // Captured here, while the child is still the process this start
          // spawned: reading the OS identity later — after a 30 s abort wait —
          // could read a recycled PID and authorize signalling a stranger.
          spawnedStartTime = typeof message.processStartTime === 'string'
            ? message.processStartTime : processStartIdentity(message.pid);
          return;
        }
        if (message && typeof message === 'object') settle(message);
      };
      child.on('message', onMessage);
      child.once('error', () => settle({ status: 'blocked' }));
      child.once('exit', () => settle({ status: 'blocked', reason: 'supervisor-exited' }));
      try { child.send({ cwd, tokens, port, endpoint }); } catch { settle({ status: 'blocked' }); }
    });
    child.unref();
    if (identity.status !== 'running') {
      const terminal = identity.status === 'stopped' && spawned && identityProven(spawned, identity)
        && await serviceTreeGone({ ...entry, ...identity });
      const aborted = terminal ? { status: 'stopped' } : await abortStart(child, spawned, spawnedStartTime);
      if (aborted.status !== 'stopped') {
        // The tree could not be proven gone, so it is registered as blocked: a
        // later start or teardown reclaims it through the identity recorded
        // here instead of starting a second service beside a live one.
        const pending = { ...entry, ...(spawned ?? identity), endpoint, status: 'blocked', teardownStatus: 'unverified', reason: aborted.reason };
        registry.processes.push(pending);
        await writeRegistry(file, registry);
        return { status: 'blocked', reason: 'service-start-unproven', processes: [pending] };
      }
      return { status: 'blocked', reason: 'service-supervisor-start-failed', processes: [
        terminal ? { ...entry, ...identity, teardownStatus: 'passed' } : entry,
      ] };
    }
    // The supervisor read the OS start identity at spawn time; that value is
    // authoritative here because the child may already have exited and had its
    // PID reused by now.
    const startIdentity = typeof identity.processStartTime === 'string' ? identity.processStartTime : processStartIdentity(identity.pid);
    Object.assign(entry, identity, {
      endpoint,
      // The PID alone is only safe to signal while it can still be told apart
      // from a recycled one, so the OS start identity is recorded alongside it.
      // The probes' non-token answers are recorded like a token: the control
      // protocol compares every field on both sides, and a field present on one
      // side only would leave every later status and stop unprovable —
      // `identityProven()` refuses exactly that. Whether the recorded value can
      // authorize acting on the number is decided where it is used.
      processStartTime: startIdentity,
    });
    registry.processes.push(entry);
    try {
      await writeRegistry(file, registry);
    } catch (error) {
      // The service is live while its registration could not be persisted, so
      // the stop result is not optional: a discarded `blocked` would orphan a
      // tree that no later start or teardown could discover.
      const stopped = await stopEntry(entry, true);
      Object.assign(entry, stopped);
      if (stopped.status === 'stopped') throw error;
      try { await writeRegistry(file, registry); } catch { /* the registry is still unwritable */ }
      throw Object.assign(new Error(`${error.message}; the started service tree is not proven stopped (${stopped.reason ?? 'service-tree-survives'})`), {
        code: 'SERVICE_START_PERSIST_FAILED', processes: [entry],
      });
    }
    // The supervisor holds the IPC channel until this acknowledgement, so a
    // launcher that dies before the identity is durable gets its tree reaped
    // instead of leaving a live service nothing could stop.
    try { child.send({ action: 'registered' }); } catch { /* the supervisor already left */ }
    let healthy = false;
    const healthcheck = service.healthcheck.replaceAll('${PORT}', String(port));
    for (let attempt = 0; attempt < 10; attempt += 1) { try { healthy = (await fetch(healthcheck, { redirect: 'error', signal: AbortSignal.timeout(400) })).ok; } catch {} if (healthy) break; await new Promise((resolve) => setTimeout(resolve, 100)); }
    healthy = healthy && serviceOwnership(entry, await request(entry, 'status'));
    if (!healthy) { Object.assign(entry, await stopEntry(entry, true)); await writeRegistry(file, registry); }
    return { status: healthy ? 'passed' : 'blocked', reason: healthy ? null : 'healthcheck-failed', processes: [entry] };
  };
  return { schemaVersion: 1, command: 'runtime', subcommand: `service ${action}`, ...(args.write && action !== 'status' ? await locked(file, operation) : await operation()) };
}

export async function teardownServices(project, worktree, write = true, { timeoutMs = 7000 } = {}) {
  const file = registryPath(project);
  const marker = teardownMarkerPath(file, worktree);
  const operation = async () => {
    const deadline = Date.now() + Math.max(1, timeoutMs);
    // A registry that does not exist yet is still read through the lock and
    // still leaves the marker: a `service start --write` racing this teardown
    // creates the first registry entry, and without either barrier it would
    // survive the worktree removal that the caller performs after `passed`.
    const registry = readRegistry(file); const results = [];
    const worktreeKey = canonicalWorktree(worktree);
    for (const entry of registry.processes.filter((item) => canonicalWorktree(item.worktree) === worktreeKey)) {
      const remaining = Math.max(0, deadline - Date.now());
      const result = remaining === 0
        ? { ...entry, status: 'blocked', teardownStatus: 'blocked', reason: 'cleanup-timeout' }
        : entry.status === 'stopped' || entry.stopOnTeardown
          ? await stopEntry(entry, write, remaining)
          : { ...entry, status: 'blocked', reason: 'service-opted-out-of-teardown' };
      // stopEntry revalidates cached terminal entries as well as supervisor and
      // orphan-reclaim results. Repeating the same full tree walk here adds cost
      // and can mistake a replacement PID for the already retired service.
      results.push(result); if (write) Object.assign(entry, result);
    }
    if (write && results.length) await writeRegistry(file, registry);
    const status = results.some((entry) => entry.status === 'blocked') ? 'blocked' : 'passed';
    // Written before the lock is released so a concurrent `service start`
    // cannot slip between teardown and the caller's worktree removal.
    if (write && status === 'passed') {
      // The marker name is deterministic and lives in a directory the worktree
      // controls, so writing through an existing symlink would let a crafted
      // marker redirect this write over any file the invoking user can write.
      // An exclusively created temporary file plus a rename never follows one.
      const temporary = `${marker}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify({ createdAt: new Date().toISOString(), worktree: path.resolve(worktree) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      renameSync(temporary, marker);
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
