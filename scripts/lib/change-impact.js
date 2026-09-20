// Change-impact classification shared by the verification CLIs: maps changed
// git paths to project-owned verification commands. scripts/verify-focused.js
// and scripts/verification-plan.js both consume this module so the impact
// mapping cannot drift between the planner and the focused runner; the risk
// classifier itself lives in verification-plan.js.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function checkStage(command) {
  if (/test:matrix/iu.test(command)) return 'matrix';
  if (/test:e2e/iu.test(command)) return 'e2e';
  if (/test:integration/iu.test(command)) return 'integration';
  if (/smoke:lifecycle/iu.test(command)) return 'smoke';
  if (/test:component/iu.test(command)) return 'component';
  return 'focused';
}

export function buildImpactMapping(paths, commands) {
  const stage = (name) => [...new Set(commands.filter((item) => checkStage(item.command) === name).map((item) => item.command))];
  return paths.map((source) => ({
    source,
    focused: [
      ...stage('focused'),
      ...stage('component'),
    ],
    integration: [...new Set([
      ...stage('integration'),
      ...( /^(?:scripts|runtime|adapters)\//u.test(source) ? ['pnpm test:integration'] : []),
    ])],
    e2e: [...new Set([
      ...stage('e2e'),
      ...( /^(?:scripts|runtime|adapters|\.github\/workflows)\//u.test(source) ? ['pnpm test:e2e'] : []),
    ])],
    matrix: stage('matrix'),
    smoke: [...new Set([
      ...stage('smoke'),
      ...( /^(?:scripts|runtime|adapters|\.github\/workflows)\//u.test(source) ? ['pnpm smoke:lifecycle'] : []),
    ])],
  }));
}

function normalizeGitPath(entry) {
  return entry.replaceAll('\\', '/');
}

export function parseNulPathList(output) {
  return output.split('\0').filter(Boolean).map(normalizeGitPath);
}

export function parseNulPorcelainPaths(output) {
  const entries = output.split('\0');
  const paths = [];
  for (let index = 0; index < entries.length; index++) {
    const record = entries[index];
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const entry = record.slice(3);
    if (entry) paths.push(normalizeGitPath(entry));
    if (/[RC]/u.test(status)) index++;
  }
  return paths;
}

/**
 * Collect changed paths from git: committed and working-tree changes relative
 * to HEAD (or the given base ref), plus untracked paths from status.
 *
 * @param {{base?: string|null, cwd?: string}} [options]
 * @returns {Promise<string[]>} Repo-relative forward-slash paths.
 */
export async function collectChangedPaths({ base = null, cwd = process.cwd() } = {}) {
  const gitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  const diffArgs = base
    ? ['diff', '--name-only', '-z', '--find-renames', base]
    : ['diff', '--name-only', '-z', '--find-renames', 'HEAD'];
  const paths = new Set();
  const [diff, status] = await Promise.all([
    execFileAsync('git', diffArgs, { env: gitEnv, cwd }),
    execFileAsync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { env: gitEnv, cwd }),
  ]);
  for (const entry of parseNulPathList(diff.stdout)) paths.add(entry);
  for (const entry of parseNulPorcelainPaths(status.stdout)) paths.add(entry);
  return [...paths];
}

function changedLineIsComment(line) {
  const value = line.trim();
  return value.length === 0
    || /^\/\//u.test(value)
    || /^#/u.test(value)
    || /^\/\*/u.test(value)
    || /^\*/u.test(value)
    || /^\*\//u.test(value)
    || /^<!--/u.test(value)
    || /^-->/u.test(value);
}

function changedLineIsFormatting(line) {
  return changedLineIsComment(line) || /^[{}()[\];,.:]+$/u.test(line.trim());
}

function changedLinesContainPublicContract(lines) {
  return lines.some((line) => /\b(?:export\s+(?:default\s+)?(?:function|class|const|let|var|type|interface)|module\.exports|exports\.|public\s+(?:class|interface|function)|openapi|graphql|router\.(?:get|post|put|patch|delete))\b/iu.test(line));
}

function changedLinesContainDynamicDependency(lines) {
  return lines.some((line) => /\b(?:dynamic\s+import|require\(|child_process|process\.env|fetch\(|axios\.)/iu.test(line));
}

/**
 * Collect conservative content signals used by the risk classifier. A missing
 * diff (for example an untracked binary) intentionally yields no signal and
 * therefore remains fail-safe at the path-based risk level.
 */
export async function collectChangedDetails({ base = null, cwd = process.cwd() } = {}) {
  const gitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  const diffArgs = base
    ? ['diff', '--no-ext-diff', '--unified=0', '--find-renames', base]
    : ['diff', '--no-ext-diff', '--unified=0', '--find-renames', 'HEAD'];
  const { stdout } = await execFileAsync('git', diffArgs, { env: gitEnv, cwd });
  const details = new Map();
  let currentPath = null;
  for (const line of stdout.split(/\r?\n/u)) {
    const header = line.match(/^\+\+\+ b\/(.+)$/u);
    if (header) {
      currentPath = header[1];
      details.set(currentPath, []);
      continue;
    }
    if (!currentPath || line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue;
    if (line.startsWith('+') || line.startsWith('-')) details.get(currentPath).push(line.slice(1));
  }
  return [...details.entries()].map(([changedPath, lines]) => ({
    changedPath,
    commentsOnly: lines.length > 0 && lines.every(changedLineIsComment),
    formatOnly: lines.length > 0 && lines.every(changedLineIsFormatting),
    publicContract: changedLinesContainPublicContract(lines),
    dynamicDependency: changedLinesContainDynamicDependency(lines),
  }));
}
