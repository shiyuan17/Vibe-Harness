// Test cost tiers for installed projects.
//
// `vibe-harness verify --project` historically executed the four configured
// commands (lint/typecheck/test/eval) as one undifferentiated batch, so a
// project that also declared an end-to-end or matrix suite had no way to run a
// fast loop while implementing and defer the expensive evidence. This module
// owns the tier vocabulary, the conservative derivation from project facts and
// the scheduling states used by the async deep receipt.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { pathExists } from './manifest.js';

/** @typedef {'quick'|'standard'|'deep'} ValidationTier */

/** @type {readonly ValidationTier[]} */
export const VALIDATION_TIERS = Object.freeze(['quick', 'standard', 'deep']);

/**
 * The tier a run executes when the caller does not name one. The fast layer is
 * the default path: the remaining layers are evidence the caller has to ask
 * for, so a plain `verify` can never pay for the deep matrix by accident.
 *
 * @type {ValidationTier}
 */
export const DEFAULT_VALIDATION_TIER = 'quick';

/**
 * The verification scope each tier blocks. The wording is the contract the
 * installed rules and templates repeat, so a tier never silently changes what
 * it gates.
 */
export const VALIDATION_TIER_BLOCKING_SCOPE = Object.freeze({
  quick: 'quick 失败阻塞当前实施单元',
  standard: 'standard 失败阻塞合并或完成声明',
  deep: 'deep 失败阻塞集成、发布或依赖该证据的完成声明',
});

/**
 * Derivation order per tier. The order is the declared contract: `quick` starts
 * with static checks and the unit/component layers, `standard` holds the
 * integration boundaries, and `deep` holds the end-to-end, matrix, smoke,
 * performance and benchmark suites.
 */
const TIER_SCRIPT_PATTERNS = Object.freeze({
  quick: [/^lint$/u, /^(?:check:type|typecheck|ts:check)$/u, /^test:unit$/u, /^test:component$/u],
  standard: [/^test:integration$/u, /^test:contract$/u, /^test:api$/u],
  deep: [
    /^test:e2e$/u,
    /^test:matrix$/u,
    /^test:smoke$/u,
    /^smoke(?::[^\s]+)?$/u,
    /^test:perf$/u,
    /^bench(?::[^\s]+)?$/u,
  ],
});

/**
 * Explicitly configured commands keep working, so they also seed a tier: the
 * static/unit commands stay on the fast loop and the eval contract replay joins
 * the deferred layer.
 */
const CONFIGURED_COMMAND_TIERS = Object.freeze({
  lint: 'quick',
  typecheck: 'quick',
  test: 'quick',
  eval: 'deep',
});

/** @returns {{quick: string[], standard: string[], deep: string[]}} */
export function emptyValidationTiers() {
  return { quick: [], standard: [], deep: [] };
}

/** @param {unknown} value @returns {{quick: string[], standard: string[], deep: string[]}} */
export function normalizeValidationTiers(value) {
  const tiers = emptyValidationTiers();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return tiers;
  for (const tier of VALIDATION_TIERS) {
    const list = Array.isArray(value[tier]) ? value[tier] : [];
    tiers[tier] = [...new Set(list
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean))];
  }
  return tiers;
}

/** @param {unknown} value @param {string} label */
export function assertValidationTiers(value, label = 'validationCommands.tiers') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!VALIDATION_TIERS.some((tier) => tier === key)) throw new Error(`${label}.${key} is not allowed`);
  }
  for (const tier of VALIDATION_TIERS) {
    if (!Object.hasOwn(value, tier)) continue;
    const list = value[tier];
    if (!Array.isArray(list)) throw new Error(`${label}.${tier} must be an array`);
    if (list.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
      throw new Error(`${label}.${tier} must contain non-empty command strings`);
    }
    if (new Set(list).size !== list.length) throw new Error(`${label}.${tier} must not contain duplicates`);
  }
}

/** @param {unknown} value */
export function validationTiersDeclared(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && VALIDATION_TIERS.every((tier) => Object.hasOwn(value, tier));
}

/** @param {any} tiers */
export function validationTiersEmpty(tiers) {
  return VALIDATION_TIERS.every((tier) => (tiers?.[tier] ?? []).length === 0);
}

function packageScriptCommand(packageManager, scriptName) {
  if (packageManager === 'npm') return scriptName === 'test' ? 'npm test' : `npm run ${scriptName}`;
  if (packageManager === 'yarn') return `yarn ${scriptName}`;
  return `${packageManager} ${scriptName}`;
}

/**
 * Derive tiers from the project's own facts.
 *
 * Only commands whose meaning is unambiguous are derived: declared package
 * scripts by name, and the two Maven/.NET entry points whose scope is fixed by
 * the tool itself. An unknown script name is left out instead of being guessed
 * into a tier.
 *
 * @param {{packageManager?: string, scripts?: Record<string, any>, configuredCommands?: Record<string, any>, stacks?: {maven?: boolean, dotnet?: boolean}}} facts
 */
export function deriveValidationTiers({
  packageManager = 'pnpm',
  scripts = {},
  configuredCommands = {},
  stacks = {},
} = {}) {
  const tiers = emptyValidationTiers();
  const reasons = emptyValidationTiers();
  const add = (tier, command, reason) => {
    const value = typeof command === 'string' ? command.trim() : '';
    if (!value || tiers[tier].includes(value)) return;
    tiers[tier].push(value);
    reasons[tier].push(`${value} ← ${reason}`);
  };

  for (const [name, tier] of Object.entries(CONFIGURED_COMMAND_TIERS)) {
    add(tier, configuredCommands?.[name], `vibe-harness.config.json validationCommands.${name}`);
  }
  const scriptNames = Object.keys(scripts ?? {}).filter((name) => typeof scripts[name] === 'string');
  for (const tier of VALIDATION_TIERS) {
    for (const pattern of TIER_SCRIPT_PATTERNS[tier]) {
      for (const scriptName of scriptNames) {
        if (pattern.test(scriptName)) add(tier, packageScriptCommand(packageManager, scriptName), `package.json scripts.${scriptName}`);
      }
    }
  }
  if (stacks.maven) {
    add('standard', 'mvn test', 'pom.xml');
    add('deep', 'mvn verify', 'pom.xml');
  }
  if (stacks.dotnet) {
    add('standard', 'dotnet test', 'solution/csproj');
  }
  return { reasons, tiers };
}

/**
 * Resolve the effective tiers: an explicitly declared tier wins, a missing
 * tier falls back to derivation.
 *
 * @param {{configuredTiers?: unknown, derived?: {tiers: object, reasons: object}}} options
 */
export function resolveValidationTiers({ configuredTiers, derived } = {}) {
  const configured = configuredTiers && typeof configuredTiers === 'object' && !Array.isArray(configuredTiers)
    ? configuredTiers
    : null;
  const derivedTiers = normalizeValidationTiers(derived?.tiers);
  const derivedReasons = derived?.reasons ?? emptyValidationTiers();
  const tiers = emptyValidationTiers();
  const tierReasons = emptyValidationTiers();

  for (const tier of VALIDATION_TIERS) {
    if (configured && Object.hasOwn(configured, tier)) {
      tiers[tier] = normalizeValidationTiers({ [tier]: configured[tier] })[tier];
      tierReasons[tier] = tiers[tier].length > 0
        ? tiers[tier].map((command) => `${command} ← vibe-harness.config.json validationCommands.tiers.${tier}`)
        : ['显式配置为空数组，该层被禁用'];
      continue;
    }
    tiers[tier] = [...derivedTiers[tier]];
    tierReasons[tier] = [...(derivedReasons[tier] ?? [])];
  }

  const tierSource = validationTiersDeclared(configured)
    ? 'explicit'
    : (validationTiersEmpty(tiers) ? 'empty' : 'derived');
  return { tierReasons, tierSource, tiers };
}

async function readJsonIfExists(filePath) {
  if (!(await pathExists(filePath))) return null;
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Bounded stack scan for the tier derivation.
 *
 * `init` runs before anything else exists, so it cannot reuse the project
 * profile. The scan stays shallow and marker-based: a root-level pom.xml, or a
 * solution/project file in the first two levels. Anything deeper would make
 * `init` walk an arbitrary tree to answer a question about declared commands.
 */
async function hasDotnetMarker(targetDir) {
  const marker = /\.(?:sln|csproj)$/iu;
  for (const directory of [targetDir, ...(await listDirectories(targetDir))]) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((entry) => entry.isFile() && marker.test(entry.name))) return true;
  }
  return false;
}

async function listDirectories(targetDir) {
  try {
    const entries = await readdir(targetDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map((entry) => path.join(targetDir, entry.name));
  } catch {
    return [];
  }
}

/** @param {string} targetDir */
export async function readProjectTierFacts(targetDir) {
  const pkg = await readJsonIfExists(path.join(targetDir, 'package.json'));
  const declaredManager = typeof pkg?.packageManager === 'string' ? pkg.packageManager.split('@')[0] : null;
  const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts !== null ? pkg.scripts : {};
  const [hasPnpmLock, hasYarnLock, hasNpmLock, hasMaven] = await Promise.all([
    pathExists(path.join(targetDir, 'pnpm-lock.yaml')),
    pathExists(path.join(targetDir, 'yarn.lock')),
    pathExists(path.join(targetDir, 'package-lock.json')),
    pathExists(path.join(targetDir, 'pom.xml')),
  ]);
  return {
    packageManager: declaredManager
      ?? (hasPnpmLock ? 'pnpm' : (hasYarnLock ? 'yarn' : (hasNpmLock ? 'npm' : (pkg ? 'npm' : null)))),
    scripts,
    stacks: {
      dotnet: await hasDotnetMarker(targetDir),
      maven: hasMaven,
    },
  };
}

/**
 * Plan the upgrade migration: only tier keys the project config does not
 * declare are added. An existing array — including an empty one, which is how a
 * project disables a tier on purpose — is never overwritten.
 *
 * @param {{configuredTiers?: unknown, derivedTiers?: any}} options
 */
export function planValidationTierMigration({ configuredTiers, derivedTiers } = {}) {
  const existing = configuredTiers && typeof configuredTiers === 'object' && !Array.isArray(configuredTiers)
    ? configuredTiers
    : {};
  const derived = normalizeValidationTiers(derivedTiers);
  const merged = emptyValidationTiers();
  const addedTiers = [];
  for (const tier of VALIDATION_TIERS) {
    if (Object.hasOwn(existing, tier)) {
      merged[tier] = Array.isArray(existing[tier]) ? [...existing[tier]] : [];
      continue;
    }
    merged[tier] = [...derived[tier]];
    addedTiers.push(tier);
  }
  if (addedTiers.length === 0) return null;
  return { addedTiers, tiers: merged };
}

/** @param {unknown} value @returns {'quick'|'standard'|'deep'} */
export function normalizeTierOption(value) {
  const token = typeof value === 'string' ? value.trim().toLowerCase() : '';
  // No `all` alias: under cumulative tier semantics it would silently mean
  // `deep`, and a caller that wants every declared layer should say so.
  if (token === 'quick' || token === 'standard' || token === 'deep') return token;
  throw new Error(`--tier must be one of quick, standard, deep; received ${JSON.stringify(value)}.`);
}

/** @param {'quick'|'standard'|'deep'} tier */
export function cumulativeTierNames(tier) {
  const index = VALIDATION_TIERS.indexOf(tier);
  return index < 0 ? [...VALIDATION_TIERS] : VALIDATION_TIERS.slice(0, index + 1);
}

/**
 * Cheapest tier that actually holds a command, or null when the project
 * declares no command in any layer.
 *
 * @param {unknown} tiers
 * @returns {'quick'|'standard'|'deep'|null}
 */
export function cheapestNonEmptyTier(tiers) {
  const normalized = normalizeValidationTiers(tiers);
  return VALIDATION_TIERS.find((tier) => normalized[tier].length > 0) ?? null;
}

/**
 * Next layer above `tier` that holds a command. This is the layer whose
 * evidence is still missing, so a receipt points at it instead of always
 * pointing at `deep`.
 *
 * @param {'quick'|'standard'|'deep'} tier @param {unknown} tiers
 * @returns {'quick'|'standard'|'deep'|null}
 */
export function nextNonEmptyTier(tier, tiers) {
  const start = VALIDATION_TIERS.indexOf(tier);
  if (start < 0) return null;
  const normalized = normalizeValidationTiers(tiers);
  for (let index = start + 1; index < VALIDATION_TIERS.length; index += 1) {
    if (normalized[VALIDATION_TIERS[index]].length > 0) return VALIDATION_TIERS[index];
  }
  return null;
}

/**
 * Resolve the layer a run executes.
 *
 * Three cases, in order: a project that declares no command in any layer keeps
 * the risk-plan path (`tier: null`) so an undeclared tier surface never turns
 * into a silent empty run; an explicit `--tier` is honored exactly, empty layer
 * included; an unnamed run starts at the fast layer and only falls back to the
 * cheapest non-empty layer when the fast layer has no command. The fallback is
 * reported back so the receipt can say which layer actually ran and why.
 *
 * @param {{explicit?: boolean, tier?: ValidationTier|null, tiers?: unknown}} [options]
 * @returns {{fallback: {from: ValidationTier, to: ValidationTier, reason: string}|null, tier: ValidationTier|null}}
 */
export function resolveExecutionTier({ explicit = false, tier = null, tiers = null } = {}) {
  const requested = tier ?? DEFAULT_VALIDATION_TIER;
  if (cheapestNonEmptyTier(tiers) === null) return { fallback: null, tier: null };
  const normalized = normalizeValidationTiers(tiers);
  if (normalized[requested].length > 0 || explicit) return { fallback: null, tier: requested };
  const to = cheapestNonEmptyTier(normalized);
  return {
    fallback: {
      from: requested,
      reason: `${requested} 层未声明命令，回退到最便宜的非空层`,
      to,
    },
    tier: to,
  };
}

/**
 * Stable check id for a command: the four configured commands keep their
 * historical ids, every other command gets a slug derived from itself.
 *
 * @param {string} command @param {Record<string, any>} commandStatus
 */
export function checkIdForCommand(command, commandStatus = {}) {
  for (const [name, item] of Object.entries(commandStatus ?? {})) {
    if (item?.command === command) return name;
  }
  const slug = String(command).trim()
    .replace(/^(?:pnpm|npm|yarn|npx|node)\s+(?:run\s+)?/u, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .toLowerCase();
  return slug || 'check';
}

/**
 * Select the commands a tier run executes and the checks it defers.
 *
 * @param {{tier: 'quick'|'standard'|'deep', tiers: any, commandStatus?: Record<string, any>}} options
 */
export function selectTierChecks({ tier, tiers, commandStatus = {} }) {
  const active = new Set(cumulativeTierNames(tier));
  const normalized = normalizeValidationTiers(tiers);
  const selectedChecks = [];
  const deferredChecks = [];
  const seen = new Set();
  for (const name of VALIDATION_TIERS) {
    for (const command of normalized[name]) {
      const id = checkIdForCommand(command, commandStatus);
      if (seen.has(id)) continue;
      seen.add(id);
      const check = {
        id,
        blockingScope: VALIDATION_TIER_BLOCKING_SCOPE[name],
        command,
        costTier: name,
        reason: `${name} 层验证命令`,
        // A configured command that the project cannot run (missing script,
        // manual entry) must still block instead of being executed blindly:
        // the tier selection carries the inspected status through.
        ...(commandStatus?.[id]?.status ? { status: commandStatus[id].status } : {}),
      };
      if (active.has(name)) selectedChecks.push(check);
      else deferredChecks.push(check);
    }
  }
  return { deferredChecks, selectedChecks };
}
