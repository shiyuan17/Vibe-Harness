import { readFile } from 'node:fs/promises';
import path from 'node:path';

const HIGH_PATHS = [
  /^\.github\/workflows\//u,
  /^(?:schemas|manifests|adapters|runtime)\//u,
  /^(?:scripts\/vibe-harness\.js|scripts\/lib\/(?:install|module|pack|project-verification|tool-provisioning))/u,
  /^(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json)$/u,
  /^(?:\.codex|\.cursor|\.qoder|\.zcode)\//u,
  /^\.agents\/(?:runtime\/hooks\/|(?:mcp_config|hooks)\.json$)/u,
];

const LIFECYCLE_PATHS = [
  /^scripts\/(?:vibe-harness\.js|smoke-lifecycles\.js|lib\/(?:install|file-transaction|transaction|tool-provisioning))/u,
  /^runtime\/hooks\//u,
  /^\.agents\/runtime\/hooks\//u,
  /^\.github\/workflows\//u,
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
  ['workflows', /^\.github\/workflows\//u],
  // Governance notes and delivery audits are reviewed documents, not runtime
  // code. Without an explicit group they fall through to `unknown`, which
  // escalates a documentation-only change to the full verification matrix.
  ['docs', /^(?:audit-reports\/|\.github\/|\.agents\/memory\/)/u],
  ['docs', /^(?:docs\/|README(?:\.en)?\.md$|CHANGELOG\.md$)/u],
  ['config', /^(?:vibe-harness\.config\.json|package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|(?:tsconfig(?:\.[^/]+)?|jsconfig\.json|\.editorconfig|\.npmrc|\.nvmrc|\.prettierrc(?:\.[^/]+)?))$/iu],
];

const LOW_IMPACT_CONFIG = /^(?:\.editorconfig|\.npmrc|\.nvmrc|\.prettierrc(?:\.[^/]+)?|(?:jsconfig|tsconfig(?:\.[^/]+)?)\.json)$/iu;

const SOURCE_PATH = /^(?:src|app|apps|lib|packages|components|server|client|backend|frontend)\//u;

function normalize(value) {
  return String(value).replaceAll('\\', '/').replace(/^\.\//u, '');
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
    if (pathYellow || ['rules', 'tests', 'eval', 'skills', 'scripts', 'config'].includes(pathGroup)) return 'standard';
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

async function projectScripts(targetDir) {
  try {
    const packageJson = JSON.parse(await readFile(path.join(targetDir, 'package.json'), 'utf8'));
    return packageJson?.scripts ?? {};
  } catch {
    return {};
  }
}

function addCheck(checks, command, reason, id = command, scripts = {}) {
  if (!command) return;
  const check = (checkId, checkCommand) => {
    if (!checkCommand || checks.some((item) => item.id === checkId || item.command === checkCommand)) return;
    checks.push({ id: checkId, command: checkCommand, reason });
  };
  // `pnpm check` is an aggregate in this repository (L1 unit + L2 component).
  // Expand it into atomic checks so the plan cannot execute a layer twice.
  if (/^(?:pnpm|npm|yarn)(?:\s+run)?\s+check$/iu.test(command)
    && typeof scripts.check === 'string'
    && /test:unit/iu.test(scripts.check)) {
    if (scripts.lint) check('lint', 'pnpm lint');
    if (scripts.typecheck) check('typecheck', 'pnpm typecheck');
    if (scripts.validate) check('validate', 'pnpm validate');
    check('test', 'pnpm test:unit');
    if (/test:component/iu.test(scripts.check)) check('component', 'pnpm test:component');
    return;
  }
  check(id, command);
}

/**
 * @param {{changedPaths?: string[], changedDetails?: Array<object>, commandStatus?: object, config?: {riskZones?: {red?: string[], yellow?: string[], pathPatterns?: {red?: string[], yellow?: string[]}}}, targetDir?: string, full?: boolean}} options
 */
export async function buildVerificationPlan({ changedPaths = [], changedDetails = [], commandStatus = {}, config = {}, targetDir = process.cwd(), full = false } = {}) {
  const paths = changedPaths.map(normalize);
  const risk = classifyVerificationRisk(paths, { changedDetails, riskZones: config.riskZones });
  const scripts = await projectScripts(targetDir);
  const checks = [];
  const reasons = [];
  if (risk.configuredZones.red) reasons.push('命中 riskZones.red 或 pathPatterns.red');
  else if (risk.configuredZones.yellow) reasons.push('命中 riskZones.yellow 或 pathPatterns.yellow');
  // Test layers follow docs/rules/test-rules.md: L1 unit and L2 component run on
  // every change, L3 integration on the affected subset, L4 e2e at the PR gate
  // and L5 matrix at release boundaries. A project that only defines some layer
  // scripts simply gets the layers it owns.
  const scriptFallback = {
    lint: 'lint',
    typecheck: 'typecheck',
    test: 'test:unit',
    component: 'test:component',
    integration: 'test:integration',
    e2e: 'test:e2e',
    matrix: 'test:matrix',
    eval: 'eval:replay',
  };
  const configured = (name) => {
    if (commandStatus[name]?.status && commandStatus[name].status !== 'not_configured') {
      return commandStatus[name].command;
    }
    const scriptName = scriptFallback[name];
    return scriptName && scripts[scriptName] ? 'pnpm ' + scriptName : null;
  };
  const addConfigured = (name, reason) => {
    const fallbackScript = scriptFallback[name];
    const command = configured(name) ?? (scripts[fallbackScript] ? `pnpm ${fallbackScript}` : null);
      if (command) addCheck(checks, command, reason, name, scripts);
  };

  if (full || risk.riskLevel === 'high' || risk.fallbackUsed) {
    if (scripts.validate) addCheck(checks, 'pnpm validate', '完整验证的原子配置校验', 'validate', scripts);
    for (const name of ['lint', 'typecheck', 'test', 'component', 'eval']) addConfigured(name, `完整验证：项目配置的 ${name}`);
      if (scripts['test:integration']) addCheck(checks, 'pnpm test:integration', '高风险或完整验证的集成回归', 'integration', scripts);
      if (scripts['smoke:lifecycle']) addCheck(checks, 'pnpm smoke:lifecycle', '生命周期、安装或 Hook 回归', 'smoke', scripts);
    reasons.push(full ? '显式 --full' : risk.fallbackUsed ? '影响范围无法可靠分类，安全回退' : '命中高风险路径');
  } else {
    if (changedPaths.length === 0) {
      for (const name of ['lint', 'typecheck', 'test', 'component', 'eval']) addConfigured(name, `无变更时的项目基线 ${name}`);
      reasons.push('无变更，运行项目基线检查');
    }
    if (risk.impactGroups.includes('docs') && !risk.impactGroups.some((group) => ['rules', 'schemas'].includes(group))) {
       if (scripts['docs:audit']) addCheck(checks, 'pnpm docs:audit', '文档目录审计', 'docs', scripts);
      reasons.push('普通文档变更');
    }
    if (risk.impactGroups.includes('rules')) {
      addConfigured('test', '规则行为锁定测试');
      addConfigured('component', '规则契约与资产测试');
       if (scripts['eval:check']) addCheck(checks, 'pnpm eval:check', '规则契约与 reference 校验', 'eval-check', scripts);
      reasons.push('规则或治理内容变更');
    }
    if (risk.impactGroups.includes('tests')) {
      addConfigured('test', '受影响单元测试');
      addConfigured('component', '受影响组件测试');
      if (risk.riskLevel === 'quick') reasons.push('单个测试文件变更');
    }
    if (risk.impactGroups.includes('eval')) {
       if (scripts['eval:check']) addCheck(checks, 'pnpm eval:check', 'Eval 契约校验', 'eval-check', scripts);
      addConfigured('component', 'Eval 资产与契约测试');
    }
    if (risk.impactGroups.includes('skills')) {
       if (scripts['skills:audit']) addCheck(checks, 'pnpm skills:audit', 'Skill 元数据审计', 'skills', scripts);
       if (scripts['eval:check']) addCheck(checks, 'pnpm eval:check', 'Skill Eval 契约校验', 'eval-check', scripts);
    }
    if (risk.impactGroups.includes('scripts')) {
      addConfigured('test', '脚本相关单元测试');
      addConfigured('component', '脚本相关组件测试');
      reasons.push('普通脚本或局部业务逻辑变更');
    }
    if (risk.impactGroups.includes('config')) {
      addConfigured('lint', '配置相关静态检查');
      if (risk.riskLevel === 'quick') reasons.push('低影响配置变更');
    }
    if (risk.impactGroups.includes('schemas') || risk.impactGroups.includes('manifests')) {
       if (scripts['lint']) addCheck(checks, 'pnpm lint', 'Schema/manifest 静态与契约校验', 'lint', scripts);
       if (scripts['validate']) addCheck(checks, 'pnpm validate', 'Schema/manifest 验证', 'validate', scripts);
    }
    reasons.push(...(risk.impactGroups.length ? [] : ['无可识别变更，保持最小验证']));
  }

  if (checks.length === 0 && !full) {
    const fallback = configured('lint') ?? configured('test');
    if (fallback) addCheck(checks, fallback, '没有更窄的检查可用，使用项目最小配置检查', 'fallback', scripts);
  }

  const known = [
    'lint', 'typecheck', 'validate', 'test', 'component', 'eval', 'docs', 'eval-check', 'skills',
    'integration', 'e2e', 'matrix', 'smoke',
  ];
  const selectedChecks = checks.map((item) => ({
    ...item,
    ...(commandStatus[item.id]?.status ? { status: commandStatus[item.id].status } : {}),
  }));
  const selectedIds = new Set(selectedChecks.map((item) => item.id));
  return {
    ...risk,
    planMode: full ? 'full' : 'auto',
    selectedChecks,
    skippedChecks: known.filter((id) => !selectedIds.has(id)).map((id) => ({ id, status: 'not_selected' })),
    selectionReasons: [...new Set(reasons)],
    fallbackUsed: risk.fallbackUsed,
  };
}
