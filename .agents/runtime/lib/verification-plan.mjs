import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { gitTimeoutMs } from './git-timeouts.mjs';
import { normalizeCheckResources } from './check-resources.mjs';

export const VERIFICATION_TIERS = ['quick', 'standard', 'deep'];
const TIER_RANK = Object.freeze(Object.fromEntries(VERIFICATION_TIERS.map((tier, index) => [tier, index])));
export const SLOT_TIERS = Object.freeze({ lint: 'quick', typecheck: 'quick', test: 'quick', eval: 'deep' });
export const SCRIPT_PATTERNS = Object.freeze({
  quick: [/^lint$/u, /^(?:check:type|typecheck|ts:check)$/u, /^test:unit$/u, /^test:component$/u],
  standard: [/^test:integration$/u, /^test:contract$/u, /^test:api$/u],
  deep: [/^test:e2e$/u, /^test:matrix$/u, /^test:smoke$/u, /^smoke(?::[^\s]+)?$/u, /^test:perf$/u, /^bench(?::[^\s]+)?$/u],
});
const BLOCKING_SCOPE = {
  quick: 'quick 失败阻塞当前实施单元',
  standard: 'standard 失败阻塞合并或完成声明',
  deep: 'deep 失败阻塞集成、发布或依赖该证据的完成声明',
};

export function verificationPaths(projectDir, values) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error('--paths requires project-relative paths.');
  }
  return [...new Set(values.map((value) => {
    if (path.isAbsolute(value) || path.win32.isAbsolute(value)) throw new Error('Verification paths must be project-relative.');
    const relative = path.relative(projectDir, path.resolve(projectDir, value));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Verification path escapes the project.');
    }
    return relative.replaceAll('\\', '/');
  }))].sort();
}

export function verificationChanges(projectDir, { paths = undefined, base = undefined } = {}) {
  const git = (args) => execFileSync('git', args, {
    cwd: projectDir, encoding: 'utf8', windowsHide: true, timeout: gitTimeoutMs(),
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let baseSha;
  try {
    baseSha = git(['rev-parse', '--verify', `${base ?? 'HEAD'}^{commit}`]).trim();
  } catch (error) {
    if (base) throw error;
    if (paths !== undefined) return { changedPaths: verificationPaths(projectDir, paths), baseSha: null, selectionMode: 'explicit-paths' };
    return { changedPaths: [], baseSha: null, selectionMode: 'unavailable' };
  }
  if (paths !== undefined) return { changedPaths: verificationPaths(projectDir, paths), baseSha, selectionMode: 'explicit-paths' };
  const changed = git(['diff', '--name-only', '-z', '--no-renames', baseSha, '--']).split('\0').filter(Boolean);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  return { changedPaths: verificationPaths(projectDir, [...changed, ...untracked]), baseSha, selectionMode: 'changed' };
}

export function verificationContextEnvironment(plan) {
  return {
    VIBE_HARNESS_VERIFY_PATHS: JSON.stringify(plan.changedPaths ?? []),
    VIBE_HARNESS_VERIFY_BASE: plan.baseSha ?? '',
    VIBE_HARNESS_VERIFY_SCOPE: plan.scope ?? 'layer',
  };
}

export function verificationCheckEvidence(stdout, stderr = '', executionStatus = 'passed') {
  const marker = '[VIBE_HARNESS_CHECK] ';
  const lines = [stdout, stderr].flatMap((stream) => String(stream ?? '').split(/\r?\n/u))
    .filter((value) => value.startsWith(marker));
  let result = null;
  for (const line of lines) {
    let evidence;
    try {
      evidence = JSON.parse(line.slice(marker.length));
      if (!['not_applicable', 'blocked', 'failed'].includes(evidence?.status) || typeof evidence.reason !== 'string') throw new Error();
    } catch {
      evidence = { status: 'blocked', reason: 'invalid-check-evidence' };
    }
    const rank = { not_applicable: 0, blocked: 1, failed: 2 };
    if (!result || rank[evidence.status] > rank[result.status]) result = evidence;
  }
  if (executionStatus !== 'passed'
    && (executionStatus !== 'failed' || result?.status === 'not_applicable')) return null;
  return result ? { status: result.status === 'not_applicable' ? 'not_selected' : result.status, reason: result.reason.slice(0, 500) } : null;
}

export function verificationCwd(projectDir, value = '.') {
  if (typeof value !== 'string' || !value.trim() || path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error('Verification cwd must be a project-relative directory.');
  }
  const root = realpathSync(projectDir);
  const requested = path.resolve(root, value);
  const relative = path.relative(root, requested);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Verification cwd escapes the project directory.');
  }
  const resolved = realpathSync(requested);
  const actual = path.relative(root, resolved);
  if (actual === '..' || actual.startsWith(`..${path.sep}`) || path.isAbsolute(actual) || !statSync(resolved).isDirectory()) {
    throw new Error('Verification cwd escapes the project directory or is not a directory.');
  }
  return { absolute: resolved, relative: actual.replaceAll('\\', '/') || '.' };
}

export function verificationCommandIdentity(command, cwd = '.') {
  const tokens = [...command.trim().matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/gu)]
    .map((match) => match[1] ?? match[2] ?? match[3]);
  return JSON.stringify([tokens, process.platform === 'win32' ? cwd.toLowerCase() : cwd]);
}

export function verificationCheckId(command, commandStatus = {}) {
  for (const [name, item] of Object.entries(commandStatus)) {
    if (item?.command?.trim() === command.trim()) return name;
  }
  return command.trim()
    .replace(/^(?:pnpm|npm|yarn|npx|node)\s+(?:run\s+)?/u, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .toLowerCase() || 'check';
}

/**
 * Validate and apply the explicit subsumption graph declared by verification
 * checks. A broad check may cover a narrower one only when the declaration is
 * unambiguous: the target exists, both run from the same cwd, the coverer is at
 * least as expensive, and the graph contains no self-edge or cycle.
 *
 * @param {Array<Record<string, any>>} allChecks
 * @param {{prune?: boolean, eligibleIds?: Set<string>|null}} options
 */
export function applyVerificationSubsumption(allChecks, { prune = true, eligibleIds = null } = {}) {
  const byId = new Map(allChecks.map((check) => [check.id, check]));
  const direct = new Map();
  for (const check of allChecks) {
    const values = check.subsumes;
    if (values === undefined) continue;
    if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value.trim())) {
      throw new Error(`validationCommands.checks.${check.id}.subsumes must be an array of non-empty check ids.`);
    }
    const targets = [...new Set(values.map((value) => value.trim()))];
    for (const targetId of targets) {
      if (targetId === check.id) {
        throw new Error(`validationCommands.checks.${check.id}.subsumes cannot reference itself.`);
      }
      const target = byId.get(targetId);
      if (!target) {
        throw new Error(`validationCommands.checks.${check.id}.subsumes references unknown check: ${targetId}`);
      }
      if (check.cwd !== target.cwd) {
        throw new Error(`validationCommands.checks.${check.id}.subsumes cannot cover ${targetId} from a different cwd.`);
      }
      if (TIER_RANK[check.costTier] < TIER_RANK[target.costTier]) {
        throw new Error(`validationCommands.checks.${check.id}.subsumes cannot be covered by a lower cost tier: ${targetId}`);
      }
    }
    direct.set(check.id, targets);
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (id, trail) => {
    if (visiting.has(id)) {
      throw new Error(`validationCommands.checks.${id}.subsumes forms a cycle: ${[...trail, id].join(' -> ')}`);
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const target of direct.get(id) ?? []) visit(target, [...trail, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of direct.keys()) visit(id, []);

  const transitiveCoverers = new Map(allChecks.map((check) => [check.id, new Set()]));
  const collect = (id, seen = new Set()) => {
    if (seen.has(id)) return new Set();
    const nextSeen = new Set(seen).add(id);
    const result = new Set();
    for (const target of direct.get(id) ?? []) {
      result.add(target);
      for (const nested of collect(target, nextSeen)) result.add(nested);
    }
    return result;
  };
  for (const check of allChecks) transitiveCoverers.set(check.id, collect(check.id));

  const selectedIds = eligibleIds ?? new Set(allChecks.map((check) => check.id));
  const subsumedBy = new Map();
  if (prune) {
    for (const check of allChecks) {
      const coverers = allChecks
        .filter((candidate) => candidate.id !== check.id
          && selectedIds.has(candidate.id)
          && transitiveCoverers.get(candidate.id)?.has(check.id))
        .sort((left, right) => TIER_RANK[right.costTier] - TIER_RANK[left.costTier]
          || left.id.localeCompare(right.id));
      if (coverers.length > 0) subsumedBy.set(check.id, coverers[0].id);
    }
  }
  return { direct, subsumedBy, transitiveCoverers };
}

export function deriveVerificationTiers({ packageManager = 'pnpm', scripts = {}, configuredCommands = {}, stacks = {} } = {}) {
  const tiers = { quick: [], standard: [], deep: [] };
  const reasons = { quick: [], standard: [], deep: [] };
  const add = (tier, command, reason) => {
    const value = typeof command === 'string' ? command.trim() : '';
    if (!value || tiers[tier].includes(value)) return;
    tiers[tier].push(value);
    reasons[tier].push(`${value} ← ${reason}`);
  };
  for (const [name, tier] of Object.entries(SLOT_TIERS)) {
    add(tier, configuredCommands[name], `vibe-harness.config.json validationCommands.${name}`);
  }
  for (const tier of VERIFICATION_TIERS) {
    for (const pattern of SCRIPT_PATTERNS[tier]) {
      for (const name of Object.keys(scripts).filter((name) => typeof scripts[name] === 'string')) {
        if (pattern.test(name)) add(tier, `${packageManager}${packageManager === 'npm' ? ' run' : ''} ${name}`, `package.json scripts.${name}`);
      }
    }
  }
  if ('maven' in stacks && stacks.maven) {
    add('standard', 'mvn test', 'pom.xml');
    add('deep', 'mvn verify', 'pom.xml');
  }
  if ('dotnet' in stacks && stacks.dotnet) add('standard', 'dotnet test', 'solution/csproj');
  return { tiers, reasons };
}

export function readVerificationTierFacts(projectDir, fallbackManager = undefined) {
  const packagePath = path.join(projectDir, 'package.json');
  const pkg = existsSync(packagePath) ? JSON.parse(readFileSync(packagePath, 'utf8')) : null;
  const marker = (file) => existsSync(path.join(projectDir, file));
  const entries = readdirSync(projectDir, { withFileTypes: true });
  const dotnet = (entries) => entries.some((entry) => entry.isFile() && /\.(sln|csproj)$/iu.test(entry.name));
  const directories = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules');
  return {
    packageManager: pkg?.packageManager?.split('@')[0] ?? fallbackManager
      ?? (marker('pnpm-lock.yaml') ? 'pnpm' : marker('yarn.lock') ? 'yarn' : marker('package-lock.json') || pkg ? 'npm' : null),
    scripts: pkg?.scripts ?? {},
    stacks: {
      maven: marker('pom.xml'),
      dotnet: dotnet(entries) || directories.some((entry) => {
        try { return dotnet(readdirSync(path.join(projectDir, entry.name), { withFileTypes: true })); }
        catch { return false; }
      }),
    },
  };
}

/** @param {{config?: any, projectDir?: string, derived?: Record<string, string[]>}} options */
export function resolveVerificationTiers({ config = {}, projectDir = process.cwd(), derived } = {}) {
  const declared = config.validationCommands?.tiers ?? {};
  const fallback = derived ?? deriveVerificationTiers({
    ...readVerificationTierFacts(projectDir, config.packageManager),
    configuredCommands: config.validationCommands,
  }).tiers;
  const explicitCommands = new Set(VERIFICATION_TIERS.flatMap((tier) => (
    Array.isArray(declared[tier]) ? declared[tier].filter((command) => typeof command === 'string').map((command) => verificationCommandIdentity(command)) : []
  )));
  return Object.fromEntries(VERIFICATION_TIERS.map((tier) => {
    const commands = Object.hasOwn(declared, tier) ? declared[tier] : fallback[tier];
    if (!Array.isArray(commands) || commands.some((command) => typeof command !== 'string' || !command.trim())) {
      throw new Error(`validationCommands.tiers.${tier} must contain non-empty command strings.`);
    }
    return [tier, [...new Set(commands
      .filter((command) => Object.hasOwn(declared, tier) || !explicitCommands.has(verificationCommandIdentity(command)))
      .map((command) => command.trim()))]];
  }));
}

export function selectVerificationChecks({
  tier = 'quick', tiers = {}, commandStatus = {}, metadata = [], projectDir, only = null,
  pruneSubsumed = true,
}) {
  if (!VERIFICATION_TIERS.includes(tier)) throw new Error(`Unknown verification tier: ${tier}`);
  if (!Array.isArray(metadata)) throw new Error('validationCommands.checks must be an array.');
  const configuredIds = new Set();
  const declarations = metadata.map((item) => {
    if (!item || typeof item.id !== 'string' || !item.id.trim() || configuredIds.has(item.id)) {
      throw new Error('validationCommands.checks requires unique non-empty ids.');
    }
    configuredIds.add(item.id);
    const command = item.command ?? commandStatus[item.id]?.command
      ?? VERIFICATION_TIERS.flatMap((name) => tiers[name] ?? []).find((value) => verificationCheckId(value, commandStatus) === item.id);
    if (typeof command !== 'string' || !command.trim()) throw new Error(`Cannot resolve command for check: ${item.id}`);
    const cwd = projectDir ? verificationCwd(projectDir, item.cwd).relative : item.cwd ?? '.';
    const resources = normalizeCheckResources(item.resources);
    if (item.parallel !== undefined && typeof item.parallel !== 'boolean') throw new Error('Check parallel must be boolean.');
    if (item.parallel === true && !resources.length) throw new Error('Parallel checks require named resources.');
    return { ...item, command: command.trim(), cwd, resources };
  });
  const seen = new Set();
  const identities = new Map();
  const allChecks = [];
  for (const costTier of VERIFICATION_TIERS) {
    for (const value of tiers[costTier] ?? []) {
      if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid command in ${costTier}.`);
      const command = value.trim();
      const matches = declarations.filter((item) => verificationCommandIdentity(item.command) === verificationCommandIdentity(command));
      for (const declaration of matches.length ? matches : [{}]) {
        const cwd = declaration.cwd ?? '.';
        const identity = verificationCommandIdentity(command, cwd);
        if (seen.has(identity)) {
          const existing = allChecks.find((check) => verificationCommandIdentity(check.command, check.cwd) === identity);
          existing.deterministic = existing.deterministic === true && declaration.deterministic === true;
          existing.resources = normalizeCheckResources([...(existing.resources ?? []), ...(declaration.resources ?? [])]);
          existing.writesDependencies = existing.writesDependencies === true || declaration.writesDependencies === true;
          continue;
        }
        seen.add(identity);
        let id = declaration.id ?? verificationCheckId(command, commandStatus);
        if ((!declaration.id && configuredIds.has(id)) || (identities.has(id) && identities.get(id) !== identity)) {
          if (declaration.id) throw new Error(`Conflicting verification check id: ${id}`);
          id += `-${createHash('sha256').update(identity).digest('hex').slice(0, 10)}`;
        }
        identities.set(id, identity);
        allChecks.push({
          ...declaration,
          id,
          command,
          cwd,
          costTier,
          blockingScope: BLOCKING_SCOPE[costTier],
          reason: `${costTier} 层验证命令`,
          ...(commandStatus[id]?.status && commandStatus[id].command === command ? { status: commandStatus[id].status } : {}),
        });
      }
    }
  }
  for (const id of only ?? []) {
    if (allChecks.some((check) => check.id === id)) continue;
    const declaration = declarations.find((item) => item.id === id);
    const alias = allChecks.find((check) => declaration
      ? verificationCommandIdentity(check.command, check.cwd) === verificationCommandIdentity(declaration.command, declaration.cwd)
      : check.command === commandStatus[id]?.command && check.cwd === '.');
    if (alias) allChecks.push({ ...alias, id, aliasOf: alias.id });
  }
  if (only && (only.length === 0 || only.some((id) => !allChecks.some((check) => check.id === id)))) {
    throw new Error(`Unknown checks: ${only.join(', ')}`);
  }
  const active = new Set(VERIFICATION_TIERS.slice(0, VERIFICATION_TIERS.indexOf(tier) + 1));
  const eligibleIds = only
    ? new Set(only)
    : new Set(allChecks.filter((check) => active.has(check.costTier)).map((check) => check.id));
  const subsumption = applyVerificationSubsumption(allChecks, {
    prune: pruneSubsumed && !only,
    eligibleIds,
  });
  const subsumedBy = subsumption.subsumedBy;
  const selectedCommands = new Set();
  const selectedChecks = allChecks.filter((check) => {
    if (!(only ? only.includes(check.id) : active.has(check.costTier))) return false;
    if (!only && pruneSubsumed && subsumedBy.has(check.id)) return false;
    const identity = verificationCommandIdentity(check.command, check.cwd);
    if (selectedCommands.has(identity)) return false;
    selectedCommands.add(identity);
    return true;
  });
  const selected = new Set(selectedChecks.map((check) => check.id));
  const deferredChecks = allChecks.filter((check) => !selected.has(check.id) && !active.has(check.costTier));
  const subsumedChecks = allChecks
    .filter((check) => subsumedBy.has(check.id))
    .map((check) => ({
      id: check.id,
      costTier: check.costTier,
      command: check.command,
      subsumedBy: subsumedBy.get(check.id),
      selectionReasons: [`subsumed-by:${subsumedBy.get(check.id)}`],
    }));
  const nextTier = VERIFICATION_TIERS.find((name) => deferredChecks.some((check) => check.costTier === name)) ?? null;
  return {
    selectedChecks: selectedChecks.map((check) => ({
      ...check,
      ...(subsumption.subsumedBy.has(check.id) ? { subsumedBy: subsumption.subsumedBy.get(check.id) } : {}),
    })),
    deferredChecks,
    allChecks: allChecks.map((check) => ({
      ...check,
      ...(subsumption.subsumedBy.has(check.id) ? { subsumedBy: subsumption.subsumedBy.get(check.id) } : {}),
    })),
    subsumedChecks,
    nextTier,
  };
}
