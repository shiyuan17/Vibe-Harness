import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  commandTokens,
  SHELL_WRITE_VERB_PATTERN,
  shellSegments,
} from './read-only-commands.mjs';

const TASKS_RELATIVE_DIR = '.vibe-harness/tasks';
const PATH_KEY_PATTERN = /^(?:file_?path|path|target|destination|directory(?:_?path)?|dir|source|old_?path|new_?path|from|to)$/iu;
const WRITE_TOOL_PATTERN = /(?:apply_?patch|write|edit|delete|remove|move|rename|create|mkdir)/iu;
const INTERPRETER_PATTERN = /(?:^|[;&|(]\s*)(?:node|nodejs|deno|bun|python(?:\d+(?:\.\d+)?)?|py|pwsh|powershell|perl|ruby)\b/iu;
const SCRIPT_WRITE_PATTERN = /(?:writeFile(?:Sync)?|appendFile(?:Sync)?|unlink(?:Sync)?|rename(?:Sync)?|symlink(?:Sync)?|rm(?:Sync)?|rmdir(?:Sync)?|write_text|write_bytes|open\s*\([^)]*['"][wax+]+['"]|Set-Content|Out-File|Add-Content|Clear-Content|fs\.(?:promises\.)?(?:writeFile|appendFile|unlink|rename|symlink|rm))/iu;
const VERSION_ONLY_PATTERN = /(?:^|\s)(?:--version|-v)\b/iu;

/**
 * Write verbs whose operands name the file that changes. The truth source for
 * "does this command write?" is `read-only-commands.mjs`; this table only
 * recovers *which paths* the command names, so the two can never disagree about
 * the verdict, only about the operand list.
 */
const WRITE_VERBS = new Set([
  'set-content', 'add-content', 'clear-content', 'out-file', 'new-item',
  'remove-item', 'move-item', 'copy-item', 'rename-item', 'mkdir', 'md',
  'rmdir', 'rd', 'touch', 'truncate', 'rm', 'mv', 'cp', 'tee', 'install',
  'chmod', 'chown', 'ln', 'mklink', 'dd', 'rsync', 'del', 'erase', 'copy',
  'move',
]);
const LAUNCHERS = new Set([
  'git', 'npm', 'pnpm', 'npx', 'yarn', 'bun', 'deno', 'gradle', 'gradlew',
  'make', 'cargo', 'dotnet', 'go', 'python', 'python3', 'py', 'perl', 'ruby',
]);
const REDIRECT_PATTERN = /(?:^|[\s\d])>{1,2}\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gu;
const NESTED_PAYLOAD_PATTERN = /-(?:Command|CommandWithArgs|c|e)\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/giu;
const SCRIPT_PATH_PATTERN = /(?:writeFile(?:Sync)?|appendFile(?:Sync)?|unlink(?:Sync)?|rename(?:Sync)?|symlink(?:Sync)?|rm(?:Sync)?|rmdir(?:Sync)?|write_text|write_bytes|remove|Set-Content|Out-File|Add-Content|Clear-Content)\s*\(?[^)\n]{0,80}?['"]([^'"]+)['"]/giu;
const ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/u;

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function collectStructuredPaths(value, paths = [], key = '') {
  if (typeof value === 'string') {
    if (PATH_KEY_PATTERN.test(key)) paths.push(value);
    return paths;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStructuredPaths(item, paths, key);
    return paths;
  }
  if (!isObject(value)) return paths;
  for (const [nestedKey, nestedValue] of Object.entries(value)) {
    collectStructuredPaths(nestedValue, paths, nestedKey);
  }
  return paths;
}

function collectPatchText(input) {
  const toolInput = input?.toolInput;
  if (!isObject(toolInput)) return [];
  return ['input', 'patch']
    .filter((key) => typeof toolInput[key] === 'string')
    .map((key) => toolInput[key]);
}

// Only real shell/command payloads count as shell text: file content and patch
// bodies may quote frozen paths (a document about the freeze, a test fixture)
// without being a write to them.
function collectShellText(input) {
  const toolInput = input?.toolInput;
  if (!isObject(toolInput)) return '';
  return ['command', 'cmd']
    .filter((key) => typeof toolInput[key] === 'string')
    .map((key) => toolInput[key])
    .join('\n');
}

function mentionsFrozenPath(projectRoot, text, frozenPaths) {
  const haystack = text.replaceAll('\\', '/');
  return frozenPaths.some((frozen) => {
    const normalized = frozen.replaceAll('\\', '/');
    const absolute = path.resolve(projectRoot, normalized).replaceAll('\\', '/');
    return haystack.includes(normalized) || haystack.includes(absolute);
  });
}

function patchPaths(command) {
  return [...command.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gmu)].map((match) => match[1].trim());
}

function basenameToken(token) {
  return token
    .replaceAll('\\', '/')
    .split('/')
    .at(-1)
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat)$/u, '');
}

/** `-Recurse`, `--force`, `-rf` and cmd's `/s` are flags, not operands. */
function isFlagToken(token) {
  return /^--?[A-Za-z0-9]/u.test(token) || /^\/[A-Za-z]$/u.test(token);
}

function verbOperands(tokens, index) {
  const operands = [];
  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor];
    if (isFlagToken(token)) continue;
    const assignment = /^(?:of|out|output|destination|dest|target)=(.+)$/iu.exec(token);
    operands.push(assignment ? assignment[1] : token);
  }
  return operands;
}

/**
 * Recovers the paths a single shell segment may write to. Redirections are
 * judged by their target rather than by their presence, so streaming a frozen
 * test's output into a log stays possible; write verbs are judged by their own
 * operands, so `... | tee report.txt` no longer inherits the frozen path named
 * earlier on the same command line.
 *
 * @param {string} segment
 * @returns {string[]}
 */
function segmentWriteTargets(segment) {
  const targets = [];
  for (const match of segment.matchAll(REDIRECT_PATTERN)) {
    const target = match[1] ?? match[2] ?? match[3];
    if (target && !target.startsWith('&')) targets.push(target);
  }
  const tokens = commandTokens(segment);
  let start = 0;
  while (start < tokens.length && ASSIGNMENT_PATTERN.test(tokens[start])) start += 1;
  const head = start < tokens.length ? basenameToken(tokens[start]) : '';
  if (WRITE_VERBS.has(head)) targets.push(...verbOperands(tokens, start));
  if (LAUNCHERS.has(head) && start + 1 < tokens.length && WRITE_VERBS.has(basenameToken(tokens[start + 1]))) {
    targets.push(...verbOperands(tokens, start + 1));
  }
  if (head === 'sed' && tokens.slice(start + 1).some((token) => token.startsWith('-i'))) {
    targets.push(...verbOperands(tokens, start));
  }
  for (const match of segment.matchAll(NESTED_PAYLOAD_PATTERN)) {
    const payload = match[1] ?? match[2] ?? match[3];
    if (payload) targets.push(...segmentWriteTargets(payload));
  }
  for (const match of segment.matchAll(SCRIPT_PATH_PATTERN)) targets.push(match[1]);
  return targets;
}

/**
 * True when the segment uses a write verb. Redirection alone does not count:
 * `node --test tests/frozen.test.js > log.txt` redirects the test's *output*,
 * and that target is checked separately.
 *
 * @param {string} segment
 * @returns {boolean}
 */
function segmentHasWriteVerb(segment) {
  if (SHELL_WRITE_VERB_PATTERN.test(segment)) return true;
  // Nested shells hide the verb inside a quoted payload, where the
  // token-anchored truth source cannot see it: `pwsh -Command "Set-Content ..."`.
  for (const match of segment.matchAll(NESTED_PAYLOAD_PATTERN)) {
    const payload = match[1] ?? match[2] ?? match[3];
    if (payload && SHELL_WRITE_VERB_PATTERN.test(payload)) return true;
  }
  return false;
}

function normalizedRelative(projectRoot, candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') return null;
  const absolute = path.resolve(projectRoot, candidate);
  const relative = path.relative(path.resolve(projectRoot), absolute).replaceAll('\\', '/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return null;
  return relative.replace(/^\.\//u, '');
}

function intersects(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

async function existingRealPath(candidate) {
  try {
    return await realpath(candidate);
  } catch {
    return null;
  }
}

async function candidateMatchesFrozen(projectRoot, candidate, frozenPaths, frozenRealPaths) {
  const relative = normalizedRelative(projectRoot, candidate);
  if (!relative) return false;
  if (frozenPaths.some((frozen) => intersects(relative, frozen))) return true;
  const candidateReal = await existingRealPath(path.resolve(projectRoot, candidate));
  if (!candidateReal) return false;
  return frozenRealPaths.some((frozen) => frozen && (candidateReal === frozen || candidateReal.startsWith(`${frozen}${path.sep}`) || frozen.startsWith(`${candidateReal}${path.sep}`)));
}

async function readFrozenPaths(projectRoot) {
  const directory = path.join(projectRoot, TASKS_RELATIVE_DIR);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { paths: [], realPaths: [] };
    throw Object.assign(new Error('Unable to read frozen test state.'), { code: 'FROZEN_TEST_STATE_UNAVAILABLE', cause: error });
  }
  const paths = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    let anchor;
    try {
      anchor = JSON.parse(await readFile(path.join(directory, entry.name), 'utf8'));
    } catch (error) {
      throw Object.assign(new Error(`Unable to read frozen test state ${entry.name}.`), { code: 'FROZEN_TEST_STATE_UNAVAILABLE', cause: error });
    }
    for (const unit of Array.isArray(anchor?.units) ? anchor.units : []) {
      if (unit?.testFreeze?.status !== 'frozen' || !Array.isArray(unit.testFreeze.paths)) continue;
      for (const candidate of unit.testFreeze.paths) {
        const relative = normalizedRelative(projectRoot, candidate);
        if (relative) paths.push(relative);
      }
    }
  }
  const unique = [...new Set(paths)].sort();
  const realPaths = await Promise.all(unique.map((relative) => existingRealPath(path.join(projectRoot, relative))));
  return { paths: unique, realPaths };
}

/**
 * @param {string} reasonCode
 * @param {string} reason
 * @returns {{ action: 'deny', reasonCode: string, reason: string }}
 */
function deny(reasonCode, reason) {
  return { action: 'deny', reasonCode, reason };
}

/**
 * Denies a write to a frozen acceptance asset. The verdict for a shell command
 * is "a write verb names a frozen asset, or a resolved write target is one";
 * mentions inside interpreter code are judged by the literal paths the code
 * hands to file APIs. Redirection is judged by its target, so running and
 * reading a frozen test (`node --test tests/frozen.test.js > log.txt`) keeps
 * working while the freeze is active. Arbitrary code whose target cannot be
 * resolved from the command line stays outside the Hook's coverage, which is
 * recorded as an explicit boundary instead of a blanket fail-closed rule that
 * would also block the fix and its re-verification.
 *
 * @param {{ toolName?: unknown, toolInput?: unknown }} input
 * @param {string} projectRoot
 * @returns {Promise<{ action: 'allow' } | { action: 'deny', reasonCode: string, reason: string }>}
 */
export async function evaluateFrozenTestWrite(input, projectRoot) {
  let frozen;
  try {
    frozen = await readFrozenPaths(projectRoot);
  } catch (error) {
    return deny(error.code ?? 'FROZEN_TEST_STATE_UNAVAILABLE', error.message);
  }
  if (frozen.paths.length === 0) return { action: 'allow' };
  const toolName = String(input?.toolName ?? '');
  const structured = collectStructuredPaths(input?.toolInput);
  const patchCandidates = collectPatchText(input).flatMap((value) => patchPaths(value));
  const shellText = collectShellText(input);
  const segments = shellSegments(shellText).map((segment) => segment.trim()).filter((segment) => segment !== '');

  // A patch header or a structured edit field names its target outright.
  for (const candidate of [...structured, ...patchCandidates]) {
    if (await candidateMatchesFrozen(projectRoot, candidate, frozen.paths, frozen.realPaths)) {
      return deny('FROZEN_TEST_WRITE', `Frozen test asset write denied: ${candidate}`);
    }
  }
  for (const segment of segments) {
    for (const target of segmentWriteTargets(segment)) {
      if (await candidateMatchesFrozen(projectRoot, target, frozen.paths, frozen.realPaths)) {
        return deny('FROZEN_TEST_WRITE', `Frozen test asset write denied: ${target}`);
      }
    }
    // A write-shaped command that names a frozen asset is a write attempt on it
    // even when no operand could be recovered:
    // `pwsh -Command "Set-Content tests/frozen.test.js changed"`.
    if (segmentHasWriteVerb(segment) && mentionsFrozenPath(projectRoot, segment, frozen.paths)) {
      return deny('FROZEN_TEST_WRITE', 'Frozen test asset write denied: the command names a frozen test asset.');
    }
    if (INTERPRETER_PATTERN.test(segment)
      && !VERSION_ONLY_PATTERN.test(segment)
      && SCRIPT_WRITE_PATTERN.test(segment)
      && mentionsFrozenPath(projectRoot, segment, frozen.paths)) {
      return deny('FROZEN_TEST_WRITE', 'Frozen test asset write denied: the inline code names a frozen test asset.');
    }
  }
  // Only a structured write request fails closed on an unresolvable target: its
  // payload must name a path, so a missing target means the request was not
  // understood, not that it is provably safe. Shell commands are judged by the
  // explicit rules above; "cannot resolve the target" is a recorded coverage
  // boundary, because denying it would also deny running and re-verifying the
  // frozen test while the freeze is active.
  if (segments.length === 0 && structured.length === 0 && patchCandidates.length === 0 && WRITE_TOOL_PATTERN.test(toolName)) {
    return deny('FROZEN_TEST_WRITE_TARGET_UNKNOWN', 'Frozen test assets are protected; the write target could not be determined safely.');
  }
  return { action: 'allow' };
}
