// Worktree port segmentation and environment facts.
//
// docs/rules/git-rules.md §Worktree reserves the main checkout's
// `[base, base+blockSize-1]` range for the main checkout itself and gives the
// n-th worktree the next block, so several worktrees can run a dev server at
// the same time without sharing a port. The allocation is recorded in
// `.vibe-harness/worktree-ports.json` inside the main checkout; the registry is
// the only source of truth, so a conflict is decided from declared facts and
// never from `netstat`/`lsof`.
//
// This module only reads the filesystem. Allocation writes nothing: the caller
// owns the lock and the write, so the development-side audit and the
// project-side runner report the same facts from the same code.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { pathKey } from './worktree-audit.mjs';

export const PORT_REGISTRY_RELATIVE_PATH = '.vibe-harness/worktree-ports.json';
export const PORT_LOCK_RELATIVE_PATH = '.vibe-harness/worktree-ports.lock';
export const DEFAULT_PORT_BLOCK_SIZE = 10;
export const DEFAULT_PORT_ENV_FILE = '.vibe-harness/worktree.env';
export const DEFAULT_PORT_VARIABLE = 'PORT';
export const FALLBACK_PORT_BASE = 3000;

/** A variable name that carries a port: `PORT`, `WEB_PORT`, `PORT_1`, `API_PORT`. */
const PORT_VARIABLE_PATTERN = /(?:^|_)PORT(?:_|$)/u;
const ENV_FILE_PATTERN = /^\.env(?:\.[A-Za-z0-9._-]+)?$/u;

export function isPortVariable(name) {
  return PORT_VARIABLE_PATTERN.test(String(name ?? ''));
}

/** Parse `NAME=value` lines, ignoring comments and blank lines. */
export function parseEnvAssignments(text) {
  const values = new Map();
  for (const raw of String(text ?? '').split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) continue;
    const value = match[2].trim().replace(/^(['"])(.*)\1$/u, '$2');
    values.set(match[1], value);
  }
  return values;
}

/** Port variable names declared by one env file, in file order. */
export function portVariablesOfEnvText(text) {
  const names = [];
  for (const name of parseEnvAssignments(text).keys()) {
    if (isPortVariable(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

function readTextIfExists(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** Every `.env*` file of the main checkout, sorted for deterministic output. */
export function mainCheckoutEnvFiles(projectDir) {
  try {
    return readdirSync(projectDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && ENV_FILE_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Port variables and base value declared by the main checkout's `.env*` files. */
export function envFilePortFacts(projectDir, files) {
  const names = [];
  let base = null;
  for (const file of files) {
    const text = readTextIfExists(path.join(projectDir, file));
    if (text === null) continue;
    for (const [name, value] of parseEnvAssignments(text)) {
      if (!isPortVariable(name)) continue;
      if (!names.includes(name)) names.push(name);
      const parsed = Number.parseInt(value, 10);
      if (base === null && Number.isInteger(parsed) && parsed > 0 && parsed < 65_536) base = parsed;
    }
  }
  return { base, files, names };
}

/** Port variables and base value declared by the project's package.json scripts. */
export function packageScriptPortFacts(packageJson) {
  const names = [];
  let base = null;
  for (const script of Object.values(packageJson?.scripts ?? {})) {
    if (typeof script !== 'string') continue;
    for (const match of script.matchAll(/(?:--port|-p)[=\s]+(\d{2,5})/gu)) {
      const parsed = Number.parseInt(match[1], 10);
      if (Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 && base === null) base = parsed;
    }
    for (const match of script.matchAll(/([A-Z][A-Z0-9_]*)\s*=/gu)) {
      if (isPortVariable(match[1]) && !names.includes(match[1])) names.push(match[1]);
    }
  }
  return { base, names };
}

/**
 * Infer the port variables to segment and the base port, following the order in
 * the worktree configuration contract: configured variables, then the declared
 * env files, then the main checkout's `.env*` files, then package.json scripts,
 * with `['PORT']` and 3000 as the last resort.
 */
export function inferPortPlan(projectDir, { declaredVariables = [], provisionEnvFiles = [], configuredBase = null } = {}) {
  const names = [];
  const addAll = (values) => {
    for (const value of values) if (!names.includes(value)) names.push(value);
  };
  addAll(declaredVariables.filter(isPortVariable));

  const provisionPorts = [];
  for (const file of provisionEnvFiles) {
    const text = readTextIfExists(path.join(projectDir, file));
    if (text === null) continue;
    provisionPorts.push(...portVariablesOfEnvText(text));
  }
  addAll(provisionPorts);

  const mainEnvFiles = mainCheckoutEnvFiles(projectDir);
  const envFacts = envFilePortFacts(projectDir, mainEnvFiles);
  addAll(envFacts.names);

  const packageJson = (() => {
    try {
      return JSON.parse(readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
    } catch {
      return {};
    }
  })();
  const scriptFacts = packageScriptPortFacts(packageJson);
  addAll(scriptFacts.names);

  if (names.length === 0) names.push(DEFAULT_PORT_VARIABLE);
  const base = configuredBase ?? envFacts.base ?? scriptFacts.base ?? FALLBACK_PORT_BASE;
  return { base, files: mainEnvFiles, variables: names };
}

function isPositiveInteger(value, { max = Number.MAX_SAFE_INTEGER, min = 1 } = {}) {
  return Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Validate a worktree port registry document.
 *
 * @param {unknown} value
 * @returns {{ok: boolean, registry?: Record<string, any>, error?: string, code?: string}}
 */
export function validatePortRegistry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'the port registry must be a JSON object.', ok: false };
  const registry = /** @type {Record<string, any>} */ (value);
  if (registry.schemaVersion !== 1) return { error: 'the port registry needs schemaVersion 1.', ok: false };
  if (!isPositiveInteger(registry.base, { max: 65_535 })) return { error: 'the port registry needs a base port between 1 and 65535.', ok: false };
  if (!isPositiveInteger(registry.blockSize, { max: 1_000 })) return { error: 'the port registry needs a blockSize between 1 and 1000.', ok: false };
  if (!Array.isArray(registry.variables) || registry.variables.length === 0 || registry.variables.some((item) => !isPortVariable(item))) {
    return { error: 'the port registry needs at least one port variable name.', ok: false };
  }
  if (!Array.isArray(registry.entries)) return { error: 'the port registry needs an entries array.', ok: false };
  const blocks = new Map();
  const ports = new Map();
  for (const entry of registry.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { error: 'every port registry entry must be an object.', ok: false };
    if (typeof entry.id !== 'string' || entry.id.trim() === '') return { error: 'every port registry entry needs an id.', ok: false };
    if (!isPositiveInteger(entry.block, { max: 100_000 })) return { error: `port registry entry ${entry.id} needs a block number >= 1.`, ok: false };
    if (!entry.ports || typeof entry.ports !== 'object' || Array.isArray(entry.ports)) return { error: `port registry entry ${entry.id} needs a ports object.`, ok: false };
    for (const [name, port] of Object.entries(entry.ports)) {
      if (!isPortVariable(name) || !isPositiveInteger(port, { max: 65_535 })) {
        return { error: `port registry entry ${entry.id} has an invalid port for ${name}.`, ok: false };
      }
      const owner = ports.get(port);
      if (owner && owner !== entry.id) {
        return { error: `port ${port} is claimed by both ${owner} and ${entry.id}.`, ok: false, code: 'WORKTREE_PORT_CONFLICT' };
      }
      ports.set(port, entry.id);
    }
    const owner = blocks.get(entry.block);
    if (owner && owner !== entry.id) {
      return { error: `block ${entry.block} is claimed by both ${owner} and ${entry.id}.`, ok: false, code: 'WORKTREE_PORT_CONFLICT' };
    }
    blocks.set(entry.block, entry.id);
  }
  return { ok: true, registry: /** @type {Record<string, any>} */ (value) };
}

/** Read the main checkout's registry; `null` when it does not exist yet. */
export function readPortRegistry(projectDir) {
  const file = path.join(projectDir, PORT_REGISTRY_RELATIVE_PATH);
  if (!existsSync(file)) return { code: null, exists: false, path: PORT_REGISTRY_RELATIVE_PATH, registry: null, error: null };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return { code: 'WORKTREE_PORT_REGISTRY_INVALID', exists: true, path: PORT_REGISTRY_RELATIVE_PATH, registry: null, error: `the port registry is not valid JSON: ${error.message}` };
  }
  const validated = validatePortRegistry(parsed);
  if (!validated.ok) {
    return {
      code: validated.code ?? 'WORKTREE_PORT_REGISTRY_INVALID',
      error: validated.error,
      exists: true,
      path: PORT_REGISTRY_RELATIVE_PATH,
      registry: null,
    };
  }
  return { code: null, exists: true, path: PORT_REGISTRY_RELATIVE_PATH, registry: parsed, error: null };
}

/** Ports of one block: variable i takes `blockStart + i`. */
export function portsForBlock(base, blockSize, block, variables) {
  const blockStart = base + block * blockSize;
  return Object.fromEntries(variables.map((name, index) => [name, blockStart + index]));
}

/**
 * Allocate (or reuse) the block of one worktree.
 *
 * The main checkout keeps block 0 (`[base, base+blockSize-1]`), so the first
 * worktree starts at block 1.
 */
export function allocatePortBlock(registry, { id, variables }) {
  const entries = Array.isArray(registry.entries) ? [...registry.entries] : [];
  const used = new Set(entries.filter((entry) => entry.id !== id).map((entry) => entry.block));
  const existing = entries.find((entry) => entry.id === id);
  let block = existing?.block ?? 1;
  while (!existing && used.has(block)) block += 1;
  return block;
}

/** Render the worktree env file contents (variables, then the identity pair). */
export function renderWorktreeEnv({ block, id, ports }) {
  const lines = Object.entries(ports).map(([name, port]) => `${name}=${port}`);
  lines.push(`VIBE_HARNESS_WORKTREE_ID=${id}`);
  lines.push(`VIBE_HARNESS_WORKTREE_BLOCK=${block}`);
  return `${lines.join('\n')}\n`;
}

/** True when `file` is covered by the main checkout's ignore files. */
export function isIgnoredPath(projectDir, file) {
  const normalized = String(file).replaceAll('\\', '/').replace(/^\.\//u, '');
  for (const ignoreFile of ['.gitignore', 'info/exclude']) {
    const text = readTextIfExists(
      ignoreFile === 'info/exclude'
        ? path.join(projectDir, '.git', 'info', 'exclude')
        : path.join(projectDir, ignoreFile),
    );
    if (text === null) continue;
    for (const raw of text.split(/\r?\n/u)) {
      const pattern = raw.trim();
      if (pattern === '' || pattern.startsWith('#') || pattern.startsWith('!')) continue;
      const anchored = pattern.startsWith('/');
      const body = pattern.replace(/^\//u, '').replace(/\/+$/u, '');
      if (body === '') continue;
      const exact = normalized === body || normalized.startsWith(`${body}/`) || normalized.endsWith(`/${body}`);
      if (exact) return true;
      if (!anchored && body.includes('*')) {
        const regex = new RegExp(`(^|/)${body.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('[^/]*')}($|/)`, 'u');
        if (regex.test(normalized)) return true;
      }
    }
  }
  return false;
}

/**
 * Port and environment facts for every existing worktree.
 *
 * The result is keyed by `pathKey(worktree.path)` and carries only observed
 * facts: which block the registry assigns, whether the worktree env file exists
 * and matches, and whether the declared env files and dependency roots are
 * present. Nothing here infers whether a command ran.
 *
 * A registry that cannot be read or that hands one block or port to two owners
 * is a fact about the main checkout rather than about one worktree, so it is
 * returned once in `registryProblems` and reported even when no worktree
 * exists yet.
 *
 * @param {object} input
 * @param {string} input.projectDir
 * @param {{primary?: boolean, path: string, branch?: string|null}[]} input.entries
 * @param {{registry?: Record<string, any>|null, code?: string|null, error?: string|null, path?: string}|null} [input.registryInfo]
 * @param {{dependencyRoots?: string[], envFile?: string, envFiles?: string[]}} [input.settings]
 */
export function collectWorktreePortEvidence({ projectDir, entries, registryInfo, settings = {} }) {
  const evidence = new Map();
  const registryProblems = [];
  const summary = [];
  const registry = registryInfo?.registry ?? null;
  if (registryInfo?.error) {
    registryProblems.push({
      code: registryInfo.code === 'WORKTREE_PORT_CONFLICT' ? 'WORKTREE_PORT_CONFLICT' : 'WORKTREE_PORT_REGISTRY_INVALID',
      message: `${registryInfo.path}: ${registryInfo.error}`,
      severity: 'error',
    });
  }
  for (const entry of entries) {
    if (entry.primary || !entry.path || !existsSync(entry.path)) continue;
    const facts = [];
    const envFile = settings.envFile ?? DEFAULT_PORT_ENV_FILE;
    const record = registry?.entries?.find((item) => item.id === path.basename(entry.path)
      || (item.path && pathKey(item.path) === pathKey(entry.path))
      || (item.branch && item.branch === entry.branch));
    if (record) {
      const ports = record.ports ?? {};
      summary.push({ block: record.block, id: record.id, path: entry.path, ports });
      const envPath = path.join(entry.path, envFile);
      if (!existsSync(envPath)) {
        facts.push({ code: 'WORKTREE_PORT_ENV_MISSING', message: `${entry.path}: ${envFile} is missing; run \`run.mjs worktree bootstrap --write\` for this worktree`, severity: 'error' });
      } else {
        const values = parseEnvAssignments(readTextIfExists(envPath) ?? '');
        const drift = [];
        for (const [name, port] of Object.entries(ports)) {
          if (values.get(name) !== String(port)) drift.push(`${name} expected ${port}, found ${values.get(name) ?? '(absent)'}`);
        }
        if (values.get('VIBE_HARNESS_WORKTREE_BLOCK') !== String(record.block)) {
          drift.push(`VIBE_HARNESS_WORKTREE_BLOCK expected ${record.block}, found ${values.get('VIBE_HARNESS_WORKTREE_BLOCK') ?? '(absent)'}`);
        }
        if (drift.length > 0) {
          facts.push({ code: 'WORKTREE_PORT_ENV_DRIFT', message: `${entry.path}: ${envFile} disagrees with the port registry (${drift.join('; ')})`, severity: 'warning' });
        }
      }
    }
    for (const file of settings.envFiles ?? []) {
      if (existsSync(path.join(entry.path, file))) continue;
      facts.push({ code: 'WORKTREE_ENV_MISSING', message: `${entry.path}: declared env file ${file} is absent`, severity: 'warning' });
    }
    for (const file of [envFile, ...(settings.envFiles ?? [])]) {
      if (existsSync(path.join(entry.path, file)) && !isIgnoredPath(projectDir, file)) {
        facts.push({ code: 'WORKTREE_ENV_NOT_IGNORED', message: `${file} is not ignored by ${path.join(projectDir, '.gitignore')}; a per-worktree env file must not be committed`, severity: 'warning' });
      }
    }
    for (const root of settings.dependencyRoots ?? []) {
      if (!existsSync(path.join(projectDir, root, 'node_modules'))) {
        facts.push({ code: 'WORKTREE_MAIN_DEPENDENCIES_MISSING', message: `${root === '.' ? '' : `${root}/`}node_modules is absent in the main checkout; run the project's install command there before bootstrapping worktrees`, severity: 'warning' });
      }
    }
    if (facts.length > 0) evidence.set(pathKey(entry.path), facts);
  }
  return { evidence, registryProblems, summary };
}
