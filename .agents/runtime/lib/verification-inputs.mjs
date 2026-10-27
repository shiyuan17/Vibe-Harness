import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

/** Hash actual dependency bytes, following package links with cycle detection. */
export function dependencyFingerprint(projectDir, config = {}, checks = []) {
  const roots = new Set(['.', ...(config.worktree?.dependencyRoots ?? []), ...checks.map((check) => check.cwd ?? '.')]);
  const hash = createHash('sha256');
  let count = 0;
  const walk = (file, label, ancestors = new Set()) => {
    if (++count > 500000) throw new Error('dependency fingerprint exceeds file limit');
    const info = lstatSync(file);
    const real = realpathSync(file);
    if (ancestors.has(real)) { hash.update(`${label}:cycle\n`); return; }
    const next = new Set(ancestors).add(real);
    const target = info.isSymbolicLink() ? lstatSync(real) : info;
    if (target.isDirectory()) {
      for (const child of readdirSync(real).sort()) walk(path.join(real, child), `${label}/${child}`, next);
    } else if (target.isFile()) {
      hash.update(`${label}:${target.mode & 0o111}:`);
      hash.update(readFileSync(real));
    } else throw new Error('unsupported dependency entry');
  };
  try {
    for (const root of [...roots].sort()) {
      if (path.isAbsolute(root) || root.split(/[\\/]/u).includes('..')) throw new Error('invalid dependency root');
      const directory = path.join(projectDir, root, 'node_modules');
      hash.update(`${root}:`);
      if (existsSync(directory)) walk(directory, root);
      else hash.update('missing');
    }
    const envPaths = new Set(['.env', '.env.local', config.worktree?.ports?.envFile ?? '.vibe-harness/worktree.env',
      ...(config.worktree?.provision?.envFiles ?? [])]);
    for (const relative of [...envPaths].sort()) {
      if (path.isAbsolute(relative) || relative.split(/[\\/]/u).includes('..')) throw new Error('Invalid environment input');
      hash.update(`${relative}:`);
      const file = path.join(projectDir, relative);
      if (existsSync(file)) walk(file, relative);
      else hash.update('missing');
    }
    return { available: true, fingerprint: hash.digest('hex'), entries: count };
  } catch (error) {
    return { available: false, fingerprint: null, entries: count, reason: error.message };
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
