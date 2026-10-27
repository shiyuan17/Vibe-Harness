import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { runGit } from './cli-runtime.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
export function candidateResourceId(candidate) {
  const name = path.basename(candidate);
  return /^\.vibe-harness-land-batch-[a-z0-9-]+$/iu.test(name)
    ? `candidate-${name.replace('.vibe-harness-land-batch-', '')}`
    : `candidate-legacy-${digest(path.resolve(candidate)).slice(0, 32)}`;
}
async function resourceStore(projectDir, candidate) {
  const common = await runGit(['rev-parse', '--git-common-dir'], projectDir);
  if (!common.ok) throw new Error('Candidate resource repository unavailable');
  const repository = realpathSync(path.resolve(projectDir, common.stdout.trim()));
  const directory = path.join(repository, 'vibe-harness-candidate-resources');
  mkdirSync(directory, { recursive: true });
  if (lstatSync(directory).isSymbolicLink()) throw new Error('Resource registry must not be a link');
  const id = candidateResourceId(candidate);
  if (!/^candidate-[a-z0-9-]+$/iu.test(id)) throw new Error('Invalid candidate resource identity');
  return { file: path.join(directory, `${id}.json`), repository: digest(repository), id };
}
function atomicJson(file, value) {
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error('Resource record must not be a link');
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
  renameSync(temporary, file);
}
export async function readCandidateResources(projectDir, candidate) {
  const store = await resourceStore(projectDir, candidate);
  if (!existsSync(store.file)) return null;
  if (lstatSync(store.file).isSymbolicLink()) throw new Error('Resource record must not be a link');
  const context = JSON.parse(readFileSync(store.file, 'utf8'));
  if (context.repository !== store.repository || context.id !== store.id
    || path.resolve(context.path) !== path.resolve(candidate)) throw new Error('Resource ownership mismatch');
  return context;
}
/** The common-dir journal survives worktree deletion. Write intent before effects. */
export async function saveCandidateResources(projectDir, candidate, context) {
  const store = await resourceStore(projectDir, candidate);
  if (context.id !== store.id || path.resolve(context.path) !== path.resolve(candidate)) throw new Error('Resource ownership mismatch');
  const record = { ...context, repository: store.repository,
    holder: { pid: process.pid, hostname: hostname() }, updatedAt: new Date().toISOString() };
  atomicJson(store.file, record);
  if (existsSync(candidate)) {
    const directory = path.join(candidate, '.vibe-harness');
    mkdirSync(directory, { recursive: true });
    if (lstatSync(directory).isSymbolicLink()) throw new Error('Candidate state must not be a link');
    atomicJson(path.join(directory, 'candidate-resources.json'), record);
  }
  return record;
}
