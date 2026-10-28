import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

/** Snapshot-local Merkle hashes: stream each real file once, never reuse across snapshots. */
export function dependencyFingerprint(projectDir, config = {}, checks = []) {
  const startedAt = Date.now();
  const roots = new Set(['.', ...(config.worktree?.dependencyRoots ?? []), ...checks.map((check) => check.cwd ?? '.')]);
  const hash = createHash('sha256').update('dependency-merkle-v2\n');
  const memo = new Map();
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let count = 0;
  let files = 0;
  let bytes = 0;
  let memoHits = 0;
  const walk = (file, ancestors = new Set()) => {
    if (++count > 500000) throw new Error('dependency fingerprint exceeds file limit');
    const info = lstatSync(file);
    const real = realpathSync(file);
    if (ancestors.has(real)) return { digest: 'cycle', cyclic: true };
    if (memo.has(real)) { memoHits += 1; return memo.get(real); }
    const next = new Set(ancestors).add(real);
    const target = info.isSymbolicLink() ? lstatSync(real) : info;
    const content = createHash('sha256');
    let cyclic = false;
    if (target.isDirectory()) {
      content.update('directory\n');
      for (const child of readdirSync(real).sort()) {
        const result = walk(path.join(real, child), next);
        content.update(JSON.stringify([child, result.digest]));
        cyclic ||= result.cyclic;
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
    const result = { digest: content.digest('hex'), cyclic };
    // A cyclic subtree depends on its ancestors; only context-free hashes are memoized.
    if (!cyclic) memo.set(real, result);
    return result;
  };
  const metrics = () => ({ entries: count, files, bytes, memoHits, durationMs: Date.now() - startedAt });
  try {
    for (const root of [...roots].sort()) {
      if (path.isAbsolute(root) || root.split(/[\\/]/u).includes('..')) throw new Error('invalid dependency root');
      const directory = path.join(projectDir, root, 'node_modules');
      hash.update(`${root}:`);
      if (existsSync(directory)) hash.update(walk(directory).digest);
      else hash.update('missing');
    }
    const envPaths = new Set(['.env', '.env.local', config.worktree?.ports?.envFile ?? '.vibe-harness/worktree.env',
      ...(config.worktree?.provision?.envFiles ?? [])]);
    for (const relative of [...envPaths].sort()) {
      if (path.isAbsolute(relative) || relative.split(/[\\/]/u).includes('..')) throw new Error('Invalid environment input');
      hash.update(`${relative}:`);
      const file = path.join(projectDir, relative);
      if (existsSync(file)) hash.update(walk(file).digest);
      else hash.update('missing');
    }
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
