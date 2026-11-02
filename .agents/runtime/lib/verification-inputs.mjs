import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

/** Snapshot-local graph hash. Hash physical nodes once, including every link edge. */
export function dependencyFingerprint(projectDir, config = {}, checks = []) {
  const startedAt = Date.now();
  const roots = new Set(['.', ...(config.worktree?.dependencyRoots ?? []), ...checks.map((check) => check.cwd ?? '.')]);
  const nodes = new Map();
  const visited = new Set();
  const projectRoot = realpathSync(projectDir);
  const normalize = (value) => {
    const normalized = value.replaceAll('\\', '/').replace(/\/+$/u, '');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const nodeId = (real) => {
    const relative = path.relative(projectRoot, real);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      ? `inside:${normalize(relative || '.')}` : `outside:${normalize(real)}`;
  };
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let count = 0;
  let files = 0;
  let bytes = 0;
  let memoHits = 0;
  const walk = (file) => {
    const real = realpathSync(file);
    const id = nodeId(real);
    if (visited.has(id)) { memoHits += 1; return; }
    if (++count > 500000) throw new Error('dependency fingerprint exceeds unique node limit');
    visited.add(id);
    const info = lstatSync(file);
    const target = info.isSymbolicLink() ? lstatSync(real) : info;
    const content = createHash('sha256');
    if (target.isDirectory()) {
      content.update('directory\n');
      for (const child of readdirSync(real).sort()) {
        const entry = path.join(real, child);
        content.update(JSON.stringify([child, lstatSync(entry).isSymbolicLink(), nodeId(realpathSync(entry))]));
        walk(entry);
      }
    } else if (target.isFile()) {
      files += 1;
      content.update(`file:${target.mode & 0o111}:`);
      const descriptor = openSync(real, 'r');
      try {
        let length;
        while ((length = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
          content.update(buffer.subarray(0, length));
          bytes += length;
        }
      } finally { closeSync(descriptor); }
    } else throw new Error('unsupported dependency entry');
    nodes.set(id, content.digest('hex'));
  };
  const metrics = () => ({ entries: count, files, bytes, memoHits, durationMs: Date.now() - startedAt });
  try {
    const rootsInput = [];
    for (const root of [...roots].sort()) {
      if (path.isAbsolute(root) || root.split(/[\\/]/u).includes('..')) throw new Error('invalid dependency root');
      const directory = path.join(projectDir, root, 'node_modules');
      if (existsSync(directory)) {
        rootsInput.push([`${root}:node_modules`, nodeId(realpathSync(directory)), lstatSync(directory).isSymbolicLink()]);
        walk(directory);
      } else rootsInput.push([`${root}:node_modules`, 'missing']);
    }
    const envPaths = new Set(['.env', '.env.local', config.worktree?.ports?.envFile ?? '.vibe-harness/worktree.env',
      ...(config.worktree?.provision?.envFiles ?? [])]);
    for (const relative of [...envPaths].sort()) {
      if (path.isAbsolute(relative) || relative.split(/[\\/]/u).includes('..')) throw new Error('Invalid environment input');
      const file = path.join(projectDir, relative);
      if (existsSync(file)) {
        rootsInput.push([relative, nodeId(realpathSync(file)), lstatSync(file).isSymbolicLink()]);
        walk(file);
      } else rootsInput.push([relative, 'missing']);
    }
    const hash = createHash('sha256').update('dependency-graph-v3\n');
    hash.update(JSON.stringify(rootsInput));
    for (const entry of [...nodes].sort(([left], [right]) => left.localeCompare(right))) hash.update(JSON.stringify(entry));
    return { available: true, fingerprint: hash.digest('hex'), ...metrics() };
  } catch (error) {
    return { available: false, fingerprint: null, ...metrics(), reason: error.message };
  }
}

export function candidateEnvironment(projectDir) {
  try {
    const file = path.join(projectDir, '.vibe-harness/candidate-resources.json');
    if (lstatSync(file).isSymbolicLink()) throw new Error('candidate context is a link');
    const context = JSON.parse(readFileSync(file, 'utf8'));
    if (context.schemaVersion !== 1 || typeof context.id !== 'string'
      || path.resolve(context.path) !== path.resolve(projectDir)) throw new Error('candidate identity mismatch');
    return { context, environment: {
      VIBE_HARNESS_WORKSPACE_ID: context.id,
      VIBE_HARNESS_RESOURCE_NAMESPACE: context.namespace,
      VIBE_HARNESS_CACHE_DIR: path.join(projectDir, '.vibe-harness/cache'),
      ...Object.fromEntries(Object.entries(context.ports ?? {}).map(([name, value]) => [name, String(value)])),
    } };
  } catch (error) {
    if (error.code === 'ENOENT') return { context: null, environment: {} };
    throw error;
  }
}

export function resourceFingerprintInput(projectDir) {
  const context = candidateEnvironment(projectDir).context;
  return context ? { id: context.id, path: context.path, namespace: context.namespace,
    ports: context.ports, dependencyMode: context.dependencyMode } : null;
}
