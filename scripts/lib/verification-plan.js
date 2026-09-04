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
  ['eval', /^(?:evals\/|runtime\/evals\/|scripts\/lib\/eval-|schemas\/eval-)/u],
  ['schemas', /^(?:schemas\/|docs\/schemas\/)/u],
  ['skills', /^(?:skills\/|\.agents\/skills\/|manifests\/skills\.json$)/u],
  ['manifests', /^manifests\//u],
  ['adapters', /^adapters\//u],
  ['runtime', /^(?:runtime\/|\.agents\/runtime\/)/u],
  ['scripts', /^scripts\//u],
  ['workflows', /^\.github\/workflows\//u],
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
    const normalizedPattern = normalize(pattern).toLowerCase();
    if (!/[?*]/u.test(normalizedPattern)) {
      const normalizedPath = pathname.toLowerCase();
      const compactPattern = normalizedPattern.replace(/[^a-z0-9]/gu, '');
      const compactPath = normalizedPath.replace(/[^a-z0-9]/gu, '');
      return normalizedPath.split(/[/.\\_-]+/u).includes(normalizedPattern)
        || normalizedPath.includes(`/${normalizedPattern}/`)
        || normalizedPath.endsWith(`/${normalizedPattern}`)
        || normalizedPath.endsWith(`.${normalizedPattern}`)
        || (compactPattern.length > 1 && compactPath.includes(compactPattern));
    }
    try { return globRegex(pattern).test(pathname); } catch { return false; }
  });
}

function classifyGroup(pathname) {
  return GROUP_RULES.find(([, pattern]) => pattern.test(pathname))?.[0]
    ?? (SOURCE_PATH.test(pathname) ? 'scripts' : 'unknown');
}

/**
 * @param {string[]} changedPaths
 * @param {{riskZones?: {red?: string[], yellow?: string[], pathPatterns?: {red?: string[], yellow?: string[]}}, changedDetails?: Array<{commentsOnly?: boolean, docsOnly?: boolean, formatOnly?: boolean, publicContract?: boolean, api?: boolean, schema?: boolean, dynamicDependency?: boolean}>}} options
 */
export function classifyVerificationRisk(changedPaths = [], { riskZones = {}, changedDetails = [] } = {}) {
  const paths = changedPaths.map(normalize);
  const groups = [...new Set(paths.map(classifyGroup))];
  const redPatterns = [...(riskZones.red ?? []), ...(riskZones.pathPatterns?.red ?? [])];
  const yellowPatterns = [...(riskZones.yellow ?? []), ...(riskZones.pathPatterns?.yellow ?? [])];
  const red = paths.some((item) => matchesConfiguredZone(item, redPatterns));
  const yellow = paths.some((item) => matchesConfiguredZone(item, yellowPatterns));
  const high = paths.some((item) => HIGH_PATHS.some((pattern) => pattern.test(item))) || red;
  const lifecycle = paths.some((item) => LIFECYCLE_PATHS.some((pattern) => pattern.test(item)));
  const details = Array.isArray(changedDetails) ? changedDetails : [];
  const publicContract = details.some((item) => item?.publicContract || item?.api || item?.schema || item?.dynamicDependency);
  const commentsOnly = details.length > 0 && details.every((item) => item?.commentsOnly || item?.docsOnly || item?.formatOnly);
  let riskLevel = 'quick';
  if (paths.length === 0) riskLevel = 'standard';
  else if (high || publicContract) riskLevel = 'high';
  else if (commentsOnly && !yellow) riskLevel = 'quick';
  else if (groups.includes('tests') && paths.length === 1 && !yellow) riskLevel = 'quick';
  else if (paths.length === 1 && LOW_IMPACT_CONFIG.test(paths[0]) && !yellow) riskLevel = 'quick';
  else if (yellow || groups.some((group) => ['rules', 'tests', 'eval', 'skills', 'scripts', 'config'].includes(group))) riskLevel = 'standard';
  else if (groups.includes('unknown')) riskLevel = 'unknown';
  return {
    changedPaths: paths,
    impactGroups: groups,
    riskLevel,
    configuredZones: { red, yellow },
    lifecycle,
    publicContract,
    commentsOnly,
    fallbackUsed: riskLevel === 'unknown',
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
  // `pnpm check` is an aggregate in this repository. Expand it into atomic
  // checks so the plan cannot execute unit tests twice.
  if (/^(?:pnpm|npm|yarn)(?:\s+run)?\s+check$/iu.test(command)
    && typeof scripts.check === 'string'
    && /test:unit/iu.test(scripts.check)) {
    if (scripts.lint) check('lint', 'pnpm lint');
    if (scripts.validate) check('validate', 'pnpm validate');
    check('test', 'pnpm test:unit');
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
  const configured = (name) => {
    if (commandStatus[name]?.status && commandStatus[name].status !== 'not_configured') {
      return commandStatus[name].command;
    }
    const scriptName = {
      lint: 'lint',
      typecheck: 'typecheck',
      test: 'test:unit',
      eval: 'eval:replay',
    }[name];
    return scriptName && scripts[scriptName] ? 'pnpm ' + scriptName : null;
  };
  const scriptFallback = { lint: 'lint', typecheck: 'typecheck', test: 'test:unit', eval: 'eval:replay' };
  const addConfigured = (name, reason) => {
    const fallbackScript = scriptFallback[name];
    const command = configured(name) ?? (scripts[fallbackScript] ? `pnpm ${fallbackScript}` : null);
      if (command) addCheck(checks, command, reason, name, scripts);
  };

  if (full || risk.riskLevel === 'high' || risk.fallbackUsed) {
    if (scripts.validate) addCheck(checks, 'pnpm validate', '完整验证的原子配置校验', 'validate', scripts);
    for (const name of ['lint', 'typecheck', 'test', 'eval']) addConfigured(name, `完整验证：项目配置的 ${name}`);
      if (scripts['test:integration']) addCheck(checks, 'pnpm test:integration', '高风险或完整验证的集成回归', 'integration', scripts);
      if (scripts['smoke:lifecycle']) addCheck(checks, 'pnpm smoke:lifecycle', '生命周期、安装或 Hook 回归', 'smoke', scripts);
    reasons.push(full ? '显式 --full' : risk.fallbackUsed ? '影响范围无法可靠分类，安全回退' : '命中高风险路径');
  } else {
    if (changedPaths.length === 0) {
      for (const name of ['lint', 'typecheck', 'test', 'eval']) addConfigured(name, `无变更时的项目基线 ${name}`);
      reasons.push('无变更，运行项目基线检查');
    }
    if (risk.impactGroups.includes('docs') && !risk.impactGroups.some((group) => ['rules', 'schemas'].includes(group))) {
       if (scripts['docs:audit']) addCheck(checks, 'pnpm docs:audit', '文档目录审计', 'docs', scripts);
      reasons.push('普通文档变更');
    }
    if (risk.impactGroups.includes('rules')) {
      addConfigured('test', '规则行为锁定测试');
       if (scripts['eval:check']) addCheck(checks, 'pnpm eval:check', '规则契约与 reference 校验', 'eval-check', scripts);
      reasons.push('规则或治理内容变更');
    }
    if (risk.impactGroups.includes('tests')) {
      addConfigured('test', '受影响单元测试');
      if (risk.riskLevel === 'quick') reasons.push('单个测试文件变更');
    }
    if (risk.impactGroups.includes('eval')) {
       if (scripts['eval:check']) addCheck(checks, 'pnpm eval:check', 'Eval 契约校验', 'eval-check', scripts);
       if (scripts['test:eval']) addCheck(checks, 'pnpm test:eval', 'Eval 基础设施测试', 'eval-test', scripts);
    }
    if (risk.impactGroups.includes('skills')) {
       if (scripts['skills:audit']) addCheck(checks, 'pnpm skills:audit', 'Skill 元数据审计', 'skills', scripts);
       if (scripts['eval:check']) addCheck(checks, 'pnpm eval:check', 'Skill Eval 契约校验', 'eval-check', scripts);
    }
    if (risk.impactGroups.includes('scripts')) {
      addConfigured('test', '脚本相关单元测试');
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

  const known = ['lint', 'typecheck', 'test', 'eval', 'docs', 'eval-check', 'eval-test', 'skills', 'validate', 'integration', 'smoke'];
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
    fallbackUsed: risk.fallbackUsed || (!full && risk.riskLevel === 'unknown'),
  };
}
