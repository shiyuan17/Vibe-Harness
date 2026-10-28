import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { applyVerificationSubsumption, resolveVerificationTiers, selectVerificationChecks, verificationCommandIdentity } from './verification-plan.mjs';

// Shared, portable risk classifier used by runtime, CLI and CI.
export const LIFECYCLE_PATHS = [
  /^scripts\/(?:vibe-harness\.js|smoke-lifecycles\.js|lib\/(?:install|file-transaction|transaction|tool-provisioning))/u,
  /^runtime\/hooks\//u,
  /^\.agents\/runtime\/hooks\//u,
  /^\.github\/workflows\//u,
];

const HIGH_PATHS = [
  /^\.github\/workflows\//u,
  /^(?:schemas|docs\/schemas|manifests|adapters|runtime|\.agents\/runtime)\//u,
  /^(?:scripts\/vibe-harness\.js|scripts\/lib\/(?:install|module|pack|project-verification|tool-provisioning))/u,
  /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|npm-shrinkwrap\.json)$/u,
  /(^|\/)(?:auth|secrets|migrations?|contracts?)(\/|$)|(^|\/)\.env(?:\.|$)|(?:^|\/)pom\.xml$/iu,
  /^(?:\.codex|\.cursor|\.qoder|\.zcode)\//u,
  // The host's ignore list controls what the agent is allowed to see, so it
  // carries the same trust level as the .codex/ config directory.
  /^\.zcodeignore$/u,
  /^\.agents\/(?:runtime\/hooks\/|(?:mcp_config|hooks)\.json$)/u,
];

/** @type {Array<[string, RegExp]>} */
const GROUP_RULES = [
  ['rules', /^(?:docs\/rules\/|rules\/|AGENTS\.md$|CONTRIBUTING\.md$)/u],
  ['tests', /^tests\//u],
  ['eval', /^(?:evals\/|\.agents\/evals\/|runtime\/evals\/|scripts\/lib\/eval-|schemas\/eval-)/u],
  ['schemas', /^(?:schemas\/|docs\/schemas\/)/u],
  ['skills', /^(?:skills\/|\.agents\/skills\/|manifests\/skills\.json$)/u],
  ['manifests', /^manifests\//u],
  ['adapters', /^adapters\//u],
  ['runtime', /^(?:runtime\/|\.agents\/runtime\/)/u],
  ['scripts', /^scripts\//u],
  ['templates', /^(?:templates\/|docs\/templates\/)/u],
  ['workflows', /^\.github\/workflows\//u],
  // Governance notes and delivery audits are reviewed documents, not runtime
  // code. Without an explicit group they fall through to `unknown`, which
  // escalates a documentation-only change to the full verification matrix.
  ['docs', /^(?:audit-reports\/|\.github\/|\.agents\/memory\/)/u],
  ['docs', /^(?:docs\/|README(?:\.en)?\.md$|CHANGELOG\.md$|LICENSE$)/u],
  // Root dotfiles and tool configs get an explicit group so a single trivial
  // change (ignore lists, lint/commitlint config) does not escalate to the
  // unknown->high full-matrix fallback.
  ['config', /^(?:vibe-harness\.config\.json|package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|(?:tsconfig(?:\.[^/]+)?|jsconfig\.json|\.editorconfig|\.npmrc|\.nvmrc|\.prettierrc(?:\.[^/]+)?|\.gitignore|\.gitattributes|\.cbmignore|\.zcodeignore|\.lintstagedrc\.json|\.release-please-manifest\.json|commitlint\.config\.mjs|eslint\.config\.mjs))$/iu],
];

const LOW_IMPACT_CONFIG = /^(?:\.editorconfig|\.npmrc|\.nvmrc|\.prettierrc(?:\.[^/]+)?|(?:jsconfig|tsconfig(?:\.[^/]+)?)\.json)$/iu;

const SOURCE_PATH = /^(?:src|app|apps|lib|packages|components|server|client|backend|frontend)\//u;

export function minimumTierForRisk(risk, scopeConfidence) {
  if (risk.configuredZones.red || risk.riskLevel === 'high' || risk.lifecycle) return 'integration';
  if (scopeConfidence !== 'complete') return 'unit';
  if (risk.publicContract || ['schemas', 'manifests', 'rules', 'config'].some((group) => risk.impactGroups.includes(group))) return 'slice';
  if (risk.impactGroups.some((group) => ['scripts', 'tests', 'templates'].includes(group))) return 'unit';
  return 'micro';
}

/**
 * @param {{scope?: string, focusedChecks?: Array<{reason?: string}>, changedPaths?: string[], coverageAvailable?: boolean}} options
 */
export function verificationScopeConfidence({ scope, focusedChecks = [], changedPaths = [], coverageAvailable = false } = {}) {
  if (scope === 'full' || changedPaths.length === 0) return 'complete';
  if (scope === 'layer') return coverageAvailable ? 'lower-bound' : 'unknown';
  if (focusedChecks.some((item) => String(item.reason ?? '').includes('文件级聚焦'))) return 'complete';
  return coverageAvailable ? 'lower-bound' : 'unknown';
}

/**
 * @param {string[]} changedPaths
 * @param {{config?: {riskZones?: object}, scope?: string, projectDir?: string}} options
 */
export function verificationRiskMetadata(changedPaths, { config = {}, scope = 'layer', projectDir } = {}) {
  let covers = null;
  try { covers = JSON.parse(readFileSync(path.join(projectDir, 'tests/cases.json'), 'utf8')).covers; } catch { /* no coverage map */ }
  const risk = classifyVerificationRisk(changedPaths, { riskZones: config.riskZones });
  const scopeConfidence = verificationScopeConfidence({ scope, changedPaths,
    coverageAvailable: covers !== null && typeof covers === 'object' && !Array.isArray(covers) });
  return { ...risk, scopeConfidence, minimumTier: minimumTierForRisk(risk, scopeConfidence) };
}

export function normalize(value) {
  return String(value).replaceAll('\\', '/').replace(/^\.\//u, '');
}

/** Delivery evidence is separate from the cost tier requested for local feedback.
 * @param {string[]} changedPaths
 * @param {{config?: any, tier?: string|null, fullRisk?: boolean}} options
 */
export function deliveryRiskPolicy(changedPaths, { config = {}, tier = null, fullRisk = false } = {}) {
  const risk = classifyVerificationRisk(changedPaths, { riskZones: config.riskZones });
  const minimumTier = fullRisk || risk.riskLevel === 'high' || risk.lifecycle ? 'standard' : 'quick';
  const rank = { quick: 0, standard: 1, deep: 2 };
  const selectedTier = /** @type {'quick'|'standard'|'deep'} */ (rank[tier] > rank[minimumTier] ? tier : minimumTier);
  return { ...risk, minimumTier, selectedTier,
    insufficientRequestedTier: tier !== null && rank[tier] < rank[minimumTier] };
}

/** Required delivery evidence is independent of the requested feedback budget.
 * Every consumer uses this plan; a quick request can add no exemptions.
 * @param {{changedPaths?: string[], config?: any, projectDir?: string, tier?: string|null, full?: boolean, fullRisk?: boolean, scopeConfidence?: string}} options
 */
export function buildDeliveryVerificationPlan({
  changedPaths = [], config = {}, projectDir = process.cwd(), tier = null, full = false,
  fullRisk = false, scopeConfidence = 'complete',
} = {}) {
  const risk = deliveryRiskPolicy(changedPaths, { config, tier, fullRisk });
  const unknown = risk.fallbackUsed || scopeConfidence !== 'complete';
  const requiredTier = unknown ? 'deep' : risk.minimumTier;
  const tiers = resolveVerificationTiers({ config, projectDir });
  const packageFile = path.join(projectDir, 'package.json');
  const pkg = existsSync(packageFile) ? JSON.parse(readFileSync(packageFile, 'utf8')) : {};
  const manager = config.packageManager ?? pkg.packageManager?.split('@')[0] ?? 'npm';
  const scripts = pkg.scripts ?? {};
  const metadata = [...(config.validationCommands?.checks ?? [])];
  const commandStatus = Object.fromEntries(Object.entries(config.validationCommands ?? {})
    .filter(([, value]) => typeof value === 'string').map(([id, command]) => [id, { command }]));
  for (const [id, script] of Object.entries({ component: 'test:component', integration: 'test:integration',
    e2e: 'test:e2e', matrix: 'test:matrix', smoke: 'smoke:lifecycle', eval: 'eval:replay',
    validate: 'validate', docs: 'docs:audit', 'eval-check': 'eval:check', skills: 'skills:audit' })) {
    if (!scripts[script] || metadata.some((check) => check.id === id)) continue;
    const command = `${manager}${manager === 'npm' ? ' run' : ''} ${script}`;
    if (Object.values(tiers).some((commands) => commands.includes(command))) metadata.push({ id, command });
  }
  const extra = [];
  const requireCheck = (id, script, costTier = 'quick') => {
    const declared = metadata.find((check) => check.id === id);
    const command = declared?.command ?? commandStatus[id]?.command
      ?? (scripts[script] ? `${manager}${manager === 'npm' ? ' run' : ''} ${script}` : null);
    if (!command) return;
    if (!metadata.some((check) => check.id === id)) metadata.push({ id, command });
    if (!Object.values(tiers).some((commands) => commands.includes(command))) tiers[costTier].push(command);
    extra.push(verificationCommandIdentity(command, declared?.cwd ?? '.'));
  };
  if (risk.impactGroups.includes('docs')) requireCheck('docs', 'docs:audit');
  if (risk.impactGroups.some((group) => ['rules', 'skills', 'eval'].includes(group))) {
    requireCheck('component', 'test:component', 'standard');
    requireCheck('eval-check', 'eval:check');
  }
  if (risk.impactGroups.includes('skills')) requireCheck('skills', 'skills:audit');
  if (risk.impactGroups.some((group) => ['schemas', 'manifests'].includes(group))) requireCheck('validate', 'validate');
  if (risk.minimumTier === 'standard') requireCheck('integration', 'test:integration', 'standard');
  if (risk.lifecycle) requireCheck('smoke', 'smoke:lifecycle', 'deep');
  const all = selectVerificationChecks({ tier: 'deep', tiers, metadata, commandStatus, projectDir, pruneSubsumed: false });
  const rank = { quick: 0, standard: 1, deep: 2 };
  const docsOnly = risk.impactGroups.length === 1 && risk.impactGroups[0] === 'docs'
    && all.allChecks.some((check) => check.id === 'docs');
  const required = all.allChecks.filter((check) => extra.includes(verificationCommandIdentity(check.command, check.cwd))
    || (!docsOnly && rank[check.costTier] <= rank[requiredTier]));
  const requestedTier = full ? 'deep' : tier;
  const selectedIds = new Set([...required, ...all.allChecks.filter((check) =>
    requestedTier && rank[check.costTier] <= rank[requestedTier])].map((check) => check.id));
  // The risk defines required evidence; a declared covering check may provide
  // it once. Explicit full requests retain every physical check.
  const subsumption = applyVerificationSubsumption(all.allChecks, { prune: !full, eligibleIds: selectedIds });
  const subsumedChecks = all.allChecks.filter((check) => subsumption.subsumedBy.has(check.id))
    .map((check) => ({ ...check, subsumedBy: subsumption.subsumedBy.get(check.id) }));
  const selected = all.allChecks.filter((check) => selectedIds.has(check.id) && !subsumption.subsumedBy.has(check.id));
  const selectedNames = selected.map((check) => check.id);
  const missingRequiredEvidence = risk.minimumTier === 'standard' && !tiers.standard.length
    && !selected.some((check) => ['integration', 'contract', 'slice'].includes(check.layer))
    ? ['contract-or-integration-command'] : [];
  return {
    ...risk, scopeConfidence, requiredTier, minimumTier: requiredTier,
    tier: full ? 'deep' : risk.selectedTier, requiredChecks: required.map((check) => check.id),
    allChecks: all.allChecks, selectedChecks: selected, selectedNames, missingRequiredEvidence,
    slotTiers: Object.fromEntries(all.allChecks.map((check) => [check.id, check.costTier])),
    deferredChecks: all.allChecks.filter((check) => !selectedNames.includes(check.id)
      && !subsumedChecks.some((item) => item.id === check.id))
      .map((check) => ({ ...check, name: check.id, required: false, reason: 'not-required-for-this-delivery' })),
    subsumedChecks, nextTier: null,
    selectionReasonsByCheck: Object.fromEntries(selected.map((check) => [check.id,
      [unknown ? 'unknown/lower-bound: expanded evidence' : 'required delivery evidence or explicit request']])),
    executionTier: full ? 'deep' : risk.selectedTier, tierFallback: null, tierSource: 'delivery-policy',
    planMode: 'delivery', scope: 'layer', selectedMicroChecks: [], deferredMicroChecks: [],
    skippedChecks: [], selectionReasons: [unknown ? 'unknown/lower-bound: expanded evidence' : 'required delivery evidence'],
    escalation: { required: false, reason: null, nextTier: null }, budgetMs: config.verification?.budgetMs ?? null,
    estimatedCostMs: null, environment: { mode: config.verification?.environment?.mode ?? 'cold', fallback: 'blocked' },
  };
}

function globRegex(pattern) {
  const normalized = normalize(pattern);
  let source = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === '*' && normalized[index + 1] === '*') {
      source += '.*';
      index += 1;
    } else if (character === '*') {
      source += '[^/]*';
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += character.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 'iu');
}

/** @param {string} pathname @param {string[]} patterns */
function matchesConfiguredZone(pathname, patterns = []) {
  return patterns.some((pattern) => {
    if (typeof pattern !== 'string' || !pattern.trim()) return false;
    const normalizedPattern = normalize(pattern).toLowerCase().replace(/\/+$/u, '');
    if (!normalizedPattern) return false;
    if (!/[?*]/u.test(normalizedPattern)) {
      const normalizedPath = pathname.toLowerCase();
      return matchesZoneName(normalizedPath, normalizedPattern)
        || normalizedPath.includes(`/${normalizedPattern}/`)
        || normalizedPath.startsWith(`${normalizedPattern}/`)
        || normalizedPath.endsWith(`/${normalizedPattern}`)
        || normalizedPath.endsWith(`.${normalizedPattern}`);
    }
    try { return globRegex(pattern).test(pathname); } catch { return false; }
  });
}

/**
 * Match a non-glob zone name against whole path parts.
 *
 * The previous implementation compared compacted alphanumeric strings, so a
 * red-zone entry like `env` also matched `scripts/envelope.js`. Matching whole
 * segments (`shared-libs/`) and whole hyphen-separated parts
 * (`secrets` in `secrets-manager.js`) keeps multi-word zone names working
 * without substring false positives.
 *
 * @param {string} normalizedPath lower-case, forward-slash path
 * @param {string} normalizedPattern lower-case zone name without trailing slash
 */
function matchesZoneName(normalizedPath, normalizedPattern) {
  const segments = normalizedPath.split(/[/.\\_]+/u).filter(Boolean);
  if (segments.includes(normalizedPattern)) return true;
  return segments.some((segment) => segment.split('-').includes(normalizedPattern));
}

function classifyGroup(pathname) {
  return GROUP_RULES.find(([, pattern]) => pattern.test(pathname))?.[0]
    ?? (SOURCE_PATH.test(pathname) ? 'scripts' : 'unknown');
}

/**
 * @param {string[]} changedPaths
 * @param {{riskZones?: {red?: string[], yellow?: string[], pathPatterns?: {red?: string[], yellow?: string[]}}, changedDetails?: Array<{changedPath?: string, commentsOnly?: boolean, docsOnly?: boolean, formatOnly?: boolean, publicContract?: boolean, api?: boolean, schema?: boolean, dynamicDependency?: boolean}>}} options
 */
export function classifyVerificationRisk(changedPaths = [], { riskZones = {}, changedDetails = [] } = {}) {
  const paths = changedPaths.map(normalize);
  const groups = [...new Set(paths.map(classifyGroup))];
  const redPatterns = [...(riskZones.red ?? []), ...(riskZones.pathPatterns?.red ?? [])];
  const yellowPatterns = [...(riskZones.yellow ?? []), ...(riskZones.pathPatterns?.yellow ?? [])];
  const red = paths.some((item) => matchesConfiguredZone(item, redPatterns));
  const yellow = paths.some((item) => matchesConfiguredZone(item, yellowPatterns));
  const lifecycle = paths.some((item) => LIFECYCLE_PATHS.some((pattern) => pattern.test(item)));
  const details = Array.isArray(changedDetails) ? changedDetails : [];
  const detailFor = (pathname, index) => details.find((item) => normalize(item?.changedPath ?? '') === pathname) ?? details[index] ?? {};
  const pathRisk = paths.map((pathname, index) => {
    const detail = detailFor(pathname, index);
    const pathGroup = classifyGroup(pathname);
    const pathRed = matchesConfiguredZone(pathname, redPatterns);
    const pathYellow = matchesConfiguredZone(pathname, yellowPatterns);
    const pathHigh = HIGH_PATHS.some((pattern) => pattern.test(pathname)) || pathRed;
    const pathPublicContract = detail.publicContract || detail.api || detail.schema || detail.dynamicDependency;
    const pathCommentsOnly = detail.commentsOnly || detail.docsOnly || detail.formatOnly;
    if (pathHigh || pathPublicContract) return 'high';
    if (pathGroup === 'unknown') return 'high';
    if (pathCommentsOnly && !pathYellow) return 'quick';
    if (pathGroup === 'docs' && !pathYellow) return 'quick';
    if (pathGroup === 'tests' && !pathYellow) return 'quick';
    if (LOW_IMPACT_CONFIG.test(pathname) && !pathYellow) return 'quick';
    if (pathYellow || ['rules', 'tests', 'eval', 'skills', 'scripts', 'templates', 'config'].includes(pathGroup)) return 'standard';
    return 'standard';
  });
  const riskOrder = ['quick', 'standard', 'high'];
  const riskLevel = paths.length === 0
    ? 'standard'
    : riskOrder[Math.max(...pathRisk.map((value) => riskOrder.indexOf(value)))];
  const publicContract = details.some((item) => item?.publicContract || item?.api || item?.schema || item?.dynamicDependency);
  const commentsOnly = details.length > 0 && details.every((item) => item?.commentsOnly || item?.docsOnly || item?.formatOnly);
  return {
    changedPaths: paths,
    impactGroups: groups,
    riskLevel,
    configuredZones: { red, yellow },
    lifecycle,
    publicContract,
    commentsOnly,
    fallbackUsed: groups.includes('unknown'),
  };
}
