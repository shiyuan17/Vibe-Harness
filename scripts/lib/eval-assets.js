import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const ASSET_GROUPS = {
  config: ['vibe-harness.config.json', 'manifests', 'schemas'],
  hooks: ['runtime/hooks', '.agents/runtime/hooks'],
  rules: ['docs/rules', 'roles', 'docs/agent-roles', '.agents/roles', '.codex/agents', '.claude/agents', '.gemini/agents', '.cursor/agents', '.qoder/agents', '.zcode/plugins/vibe-harness-roles', '.agents/agents', '.opencode/agents'],
  skills: ['skills', '.agents/skills'],
};

// Single source for the group set: drift comparison and contract tests
// import this list instead of restating the names, and the eval schemas pin
// the same set, so changing it is a cross-file contract change.
export const EVAL_ASSET_GROUP_NAMES = Object.freeze(Object.keys(ASSET_GROUPS));

async function collect(rootDir, relative) {
  const absolute = path.join(rootDir, relative);
  let metadata;
  try {
    metadata = await lstat(absolute);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (metadata.isSymbolicLink()) return [];
  if (metadata.isFile()) return [{ absolute, relative: relative.replaceAll('\\', '/') }];
  if (!metadata.isDirectory()) return [];
  const files = [];
  const entries = await readdir(absolute, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) continue;
    files.push(...await collect(rootDir, path.join(relative, entry.name)));
  }
  return files;
}

/**
 * Git normalizes text to LF on commit, so the same content is stored as CRLF in
 * a Windows worktree and as LF in a Linux checkout. Hashing raw worktree bytes
 * therefore made the fingerprint depend on the checkout form instead of the
 * content. Normalize text to LF; keep byte-exact content for anything Git
 * treats as binary (embedded NUL) or that is not valid UTF-8.
 *
 * @param {Buffer} buffer
 * @returns {Buffer}
 */
export function canonicalAssetBytes(buffer) {
  if (buffer.includes(0)) return buffer;
  const text = buffer.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buffer)) return buffer;
  const normalized = text.replaceAll('\r\n', '\n');
  return normalized === text ? buffer : Buffer.from(normalized, 'utf8');
}

async function hashGroup(rootDir, paths) {
  const groups = await Promise.all(paths.map((relative) => collect(rootDir, relative)));
  const files = groups.flat().sort((left, right) => left.relative.localeCompare(right.relative));
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.relative);
    hash.update('\0');
    hash.update(canonicalAssetBytes(await readFile(file.absolute)));
    hash.update('\0');
  }
  return { fileCount: files.length, hash: hash.digest('hex') };
}

export async function createEvalAssetFingerprint(rootDir) {
  const entries = [];
  for (const [name, paths] of Object.entries(ASSET_GROUPS)) {
    entries.push([name, await hashGroup(rootDir, paths)]);
  }
  const groups = Object.fromEntries(entries);
  const aggregate = createHash('sha256');
  for (const name of Object.keys(groups).sort()) {
    aggregate.update(name);
    aggregate.update('\0');
    aggregate.update(groups[name].hash);
    aggregate.update('\0');
  }
  return { aggregateHash: aggregate.digest('hex'), groups };
}
