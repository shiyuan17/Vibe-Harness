import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  VALIDATION_TIER_BLOCKING_SCOPE,
  deriveValidationTiers,
  nextNonEmptyTier,
  readProjectTierFacts,
  resolveExecutionTier,
  resolveValidationTiers,
  selectTierChecks,
} from './validation-tiers.js';
import { verificationCommandIdentity } from '../../runtime/lib/verification-plan.mjs';
import { TEST_FILE_PATTERN } from './test-enumeration.js';
import { buildDeliveryVerificationPlan, classifyVerificationRisk, deliveryRiskPolicy, minimumTierForRisk, normalize } from '../../runtime/lib/verification-risk.mjs';
export { classifyVerificationRisk } from '../../runtime/lib/verification-risk.mjs';
import {
  DEFAULT_VERIFICATION_SCOPE,
  estimateVerificationCost,
  normalizeVerificationScope,
  normalizeMicroChecks,
  verificationScopeConfidence,
  validationCheckMap,
} from './verification-contract.js';

/**
 * Cost tier of each selectable check. The risk plan and the tier plan answer
 * different questions — "what does this change affect" versus "how expensive is
 * the evidence" — so both carry the cost tier and the scope it blocks.
 */
const CHECK_COST_TIERS = {
  component: 'quick',
  docs: 'quick',
  'eval-check': 'quick',
  fallback: 'quick',
  lint: 'quick',
  skills: 'quick',
  test: 'quick',
  typecheck: 'quick',
  validate: 'quick',
  integration: 'standard',
  e2e: 'deep',
  eval: 'deep',
  matrix: 'deep',
  smoke: 'deep',
};

/** @param {string} id */
function costTierForCheck(id) {
  return CHECK_COST_TIERS[id] ?? 'standard';
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
    if (!checkCommand) return;
    const existing = checks.find((item) => item.id === checkId || item.command === checkCommand);
    if (existing) {
      existing.selectionReasons = [...new Set([...(existing.selectionReasons ?? []), reason])];
      existing.reason = existing.selectionReasons.join('；');
      return;
    }
    checks.push({ id: checkId, command: checkCommand, reason, selectionReasons: [reason] });
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
 * Load the ledger's coverage map (test file → sources it reaches through
 * relative imports) from the target directory. Foreign projects carry no
 * ledger, so they resolve to null and never narrow — the fail-safe direction.
 *
 * @param {string} targetDir
 * @returns {Promise<Record<string, string[]>|null>}
 */
async function readLedgerCovers(targetDir) {
  try {
    const ledger = JSON.parse(await readFile(path.join(targetDir, 'tests/cases.json'), 'utf8'));
    const covers = ledger?.covers;
    return covers !== null && typeof covers === 'object' && !Array.isArray(covers) ? covers : null;
  } catch {
    return null;
  }
}

/**
 * Pick the layer's test files a change set justifies. The result is null unless
 * narrowing is provably safe: every changed non-test source must be reached by
 * one of the selected tests, because the coverage map is a lower bound (dynamic
 * imports and readFile dependencies are invisible to it) and "not listed" must
 * never be read as "unaffected".
 *
 * @param {string[]} paths normalized changed paths
 * @param {Record<string, string[]>|null} coverage test file → covered sources
 * @param {string} layer layer directory name under tests/
 * @returns {string[]|null} sorted test files, or null to keep the full layer
 */
function focusedTestFiles(paths, coverage, layer) {
  if (!coverage || typeof coverage !== 'object') return null;
  const own = paths.filter((item) => item.startsWith(`tests/${layer}/`) && TEST_FILE_PATTERN.test(item));
  const sources = paths.filter((item) => !TEST_FILE_PATTERN.test(item));
  const selected = new Set(own);
  for (const [testFile, covered] of Object.entries(coverage)) {
    if (!testFile.startsWith(`tests/${layer}/`) || !Array.isArray(covered)) continue;
    if (covered.some((source) => sources.includes(source))) selected.add(testFile);
  }
  if (selected.size === 0) return null;
  const reaches = (testFile, source) => {
    const covered = coverage[testFile];
    return Array.isArray(covered) && covered.includes(source);
  };
  if (!sources.every((source) => [...selected].some((testFile) => reaches(testFile, source)))) return null;
  return [...selected].sort();
}

// Must stay aligned with shellControlPattern in ./shell-command.js: plan
// commands are executed through assertSafeCommand, so a token that survives
// here but is rejected there would turn the whole check into 'blocked'.
const UNSAFE_TOKEN_PATTERN = /[;|&<>$`]/u;

/**
 * Rewrite a layer's `node --test` command so it runs only the focused test
 * files, preserving every other flag (concurrency, timeout, reporters) of the
 * configured script. Any script shape that cannot be verified — a non-node
 * runner, a missing `--test`, shell metacharacters — returns null and the
 * caller keeps the full layer command.
 *
 * @param {string} scriptName package.json script name of the layer
 * @param {string[]} files focused test files
 * @param {Record<string, string>} scripts package.json scripts
 * @returns {string|null}
 */
function focusedRunner(scriptName, files, scripts) {
  const script = scripts[scriptName];
  if (typeof script !== 'string' || files.length === 0) return null;
  const tokens = script.split(/\s+/u).filter(Boolean);
  if (tokens[0] !== 'node' || !tokens.includes('--test')) return null;
  if (tokens.some((token) => UNSAFE_TOKEN_PATTERN.test(token))) return null;
  const flags = tokens.filter((token) => !TEST_FILE_PATTERN.test(token));
  // The case reporter writes to a single .vibe-harness/observed-tests/<layer>.json
  // destination, so a focused run leaves the subset there; the full gate has to
  // re-run before the ledger's observed comparison is meaningful again.
  return [...flags, ...files].join(' ');
}

/**
 * @param {{changedPaths?: string[], changedDetails?: Array<object>, commandStatus?: object, config?: any, targetDir?: string, full?: boolean, delivery?: boolean, tier?: 'quick'|'standard'|'deep'|null, tierExplicit?: boolean, tiers?: {quick?: string[], standard?: string[], deep?: string[]}|null, tierSource?: string|null, covers?: Record<string, string[]>|null, scope?: 'affected'|'layer'|'full', only?: string[]|null}} options
 */
export async function buildVerificationPlan({
  changedPaths = [],
  changedDetails = [],
  commandStatus = {},
  config = {},
  targetDir = process.cwd(),
  full = false,
  tier = null,
  tierExplicit = false,
  tiers = null,
  tierSource = null,
  covers = undefined,
  scope = null,
  only = null,
  delivery = false,
} = {}) {
  if (delivery) return buildDeliveryVerificationPlan({ changedPaths, config, projectDir: targetDir, tier, full });
  const verificationScope = normalizeVerificationScope(
    scope ?? config?.verification?.defaultScope ?? DEFAULT_VERIFICATION_SCOPE,
  );
  const paths = changedPaths.map(normalize);
  const risk = classifyVerificationRisk(paths, { changedDetails, riskZones: config.riskZones });
  const scripts = await projectScripts(targetDir);
  const tierFacts = await readProjectTierFacts(targetDir, config.packageManager);
  const derived = deriveValidationTiers({
    ...tierFacts,
    configuredCommands: config.validationCommands,
  });
  const effective = resolveValidationTiers({ configuredTiers: config.validationCommands?.tiers, derived });
  // The risk fallbacks name the same scripts as the derived tiers, so they are
  // built from the same package manager: handing an npm or yarn project a `pnpm`
  // command for a script it declares by another name would make the plan fail
  // before merge, and would give one script two identities once a tier plan and
  // this plan are merged.
  const packageManager = typeof tierFacts.packageManager === 'string' && tierFacts.packageManager
    ? tierFacts.packageManager
    : 'pnpm';
  const packageCommand = (scriptName) => `${packageManager}${packageManager === 'npm' ? ' run' : ''} ${scriptName}`;
  // One table answers every tier question: the caller's table when given, the
  // derived/configured one otherwise. Using the raw argument for resolution
  // while the fallback only reached the cost lookup would let `--tier deep` on a
  // project without an explicit tier table resolve against nothing and silently
  // omit the requested layer.
  const effectiveTiers = tiers ?? effective.tiers;
  tierSource ??= effective.tierSource;
  const tierForCommand = (command) => command
    ? Object.entries(effectiveTiers).find(([, commands]) => commands.some(
      (candidate) => verificationCommandIdentity(candidate) === verificationCommandIdentity(command),
    ))?.[0]
    : undefined;
  // The coverage map comes from the caller or from the target's own ledger;
  // it is only consulted in tier-less (change-driven) plans.
  const coverage = covers === undefined ? await readLedgerCovers(targetDir) : covers;
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
    const declaredCheck = validationCheckMap(config).get(name);
    if (declaredCheck?.command) return declaredCheck.command;
    if (typeof config.validationCommands?.[name] === 'string' && config.validationCommands[name].trim()) {
      return config.validationCommands[name].trim();
    }
    if (commandStatus[name]?.status && commandStatus[name].status !== 'not_configured') {
      return commandStatus[name].command;
    }
    const scriptName = scriptFallback[name];
    return scriptName && scripts[scriptName] ? packageCommand(scriptName) : null;
  };
  const addConfigured = (name, reason) => {
    const fallbackScript = scriptFallback[name];
    const command = configured(name) ?? (scripts[fallbackScript] ? packageCommand(fallbackScript) : null);
      if (command) addCheck(checks, command, reason, name, scripts);
  };
  // Test layers can narrow below the layer script when the change is fully
  // attributed by the ledger's coverage map: the plan then rewrites the
  // layer's `node --test` command to run only the selected files. Tier runs
  // never narrow — they select by configured command identity, and file-level
  // focus would break that 1:1 mapping.
  const addTestLayer = (name, reason, layer) => {
    const focused = verificationScope === 'affected' || (!tier && verificationScope === 'layer')
      ? focusedTestFiles(paths, coverage, layer)
      : null;
    const command = focused ? focusedRunner(scriptFallback[name], focused, scripts) : null;
    if (command) {
      addCheck(checks, command, `${reason}（文件级聚焦：${focused.length} 个测试文件）`, name, scripts);
      return;
    }
    addConfigured(name, reason);
  };

  // Deep-layer evidence the slimmed high branch defers instead of paying for
  // synchronously; it joins plan.deferredChecks below (auto plans only — when a
  // tier resolved, the tier's own deferral surface owns the visibility).
  const deferredEvidence = [];
  if (full || risk.riskLevel === 'high' || risk.fallbackUsed) {
    // A classified high-risk change keeps synchronous evidence down to the
    // integration layer; eval and lifecycle smoke are deep evidence that stay
    // visible as deferred checks until the caller escalates. `--full` and the
    // unknown fallback keep paying the whole matrix up front (fail-safe).
    const slim = !full && !risk.fallbackUsed;
    if (scripts.validate) addCheck(checks, packageCommand('validate'), '完整验证的原子配置校验', 'validate', scripts);
    const syncNames = slim ? ['lint', 'typecheck', 'test', 'component'] : ['lint', 'typecheck', 'test', 'component', 'eval'];
    for (const name of syncNames) addConfigured(name, `完整验证：项目配置的 ${name}`);
      if (scripts['test:integration']) addCheck(checks, packageCommand('test:integration'), '高风险或完整验证的集成回归', 'integration', scripts);
      if (scripts['smoke:lifecycle'] && (!slim || risk.lifecycle)) {
        addCheck(checks, packageCommand('smoke:lifecycle'), '生命周期、安装或 Hook 回归', 'smoke', scripts);
      }
    if (slim) {
      const evalCommand = configured('eval');
      if (evalCommand) deferredEvidence.push({ command: evalCommand, id: 'eval', reason: '高风险变更的深度层证据，显式升级后执行' });
      if (!risk.lifecycle && scripts['smoke:lifecycle']) {
        deferredEvidence.push({ command: packageCommand('smoke:lifecycle'), id: 'smoke', reason: '高风险变更的深度层证据，显式升级后执行' });
      }
      reasons.push('高风险同步证据保留到 integration；eval 与 smoke 为深度层证据，显式升级后执行');
    }
    reasons.push(full ? '显式 --full' : risk.fallbackUsed ? '影响范围无法可靠分类，安全回退' : '命中高风险路径');
  } else {
    if (changedPaths.length === 0) {
      for (const name of ['lint', 'typecheck', 'test', 'component', 'eval']) addConfigured(name, `无变更时的项目基线 ${name}`);
      reasons.push('无变更，运行项目基线检查');
    }
    if (risk.impactGroups.includes('docs') && !risk.impactGroups.some((group) => ['rules', 'schemas'].includes(group))) {
       if (scripts['docs:audit']) addCheck(checks, packageCommand('docs:audit'), '文档目录审计', 'docs', scripts);
      reasons.push('普通文档变更');
    }
    if (risk.impactGroups.includes('rules')) {
      addConfigured('test', '规则行为锁定测试');
      addConfigured('component', '规则契约与资产测试');
       if (scripts['eval:check']) addCheck(checks, packageCommand('eval:check'), '规则契约与 reference 校验', 'eval-check', scripts);
      reasons.push('规则或治理内容变更');
    }
    if (risk.impactGroups.includes('tests')) {
      addTestLayer('test', '受影响单元测试', 'unit');
      addTestLayer('component', '受影响组件测试', 'component');
      if (risk.riskLevel === 'quick') reasons.push('单个测试文件变更');
    }
    if (risk.impactGroups.includes('eval')) {
       if (scripts['eval:check']) addCheck(checks, packageCommand('eval:check'), 'Eval 契约校验', 'eval-check', scripts);
      addConfigured('component', 'Eval 资产与契约测试');
    }
    if (risk.impactGroups.includes('skills')) {
       if (scripts['skills:audit']) addCheck(checks, packageCommand('skills:audit'), 'Skill 元数据审计', 'skills', scripts);
       if (scripts['eval:check']) addCheck(checks, packageCommand('eval:check'), 'Skill Eval 契约校验', 'eval-check', scripts);
    }
    if (risk.impactGroups.includes('scripts')) {
      addTestLayer('test', '脚本相关单元测试', 'unit');
      addTestLayer('component', '脚本相关组件测试', 'component');
      reasons.push('普通脚本或局部业务逻辑变更');
    }
    if (risk.impactGroups.includes('config')) {
      addConfigured('lint', '配置相关静态检查');
      if (risk.riskLevel === 'quick') reasons.push('低影响配置变更');
    }
    if (risk.impactGroups.includes('schemas') || risk.impactGroups.includes('manifests')) {
       if (scripts['lint']) addCheck(checks, packageCommand('lint'), 'Schema/manifest 静态与契约校验', 'lint', scripts);
       if (scripts['validate']) addCheck(checks, packageCommand('validate'), 'Schema/manifest 验证', 'validate', scripts);
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
  const withCost = (item) => {
    const originalCommand = configured(item.id) ?? item.command;
    const declaredTier = tierForCommand(originalCommand) ?? tierForCommand(item.command);
    const derivedTier = Object.entries(derived.tiers).find(([, commands]) => commands.some(
      (candidate) => verificationCommandIdentity(candidate) === verificationCommandIdentity(originalCommand),
    ))?.[0] ?? (scriptFallback[item.id] ? costTierForCheck(item.id) : undefined);
    const fallbackTier = derivedTier ?? costTierForCheck(item.id);
    const declared = config.validationCommands?.tiers ?? {};
    const disabled = !declaredTier && Object.hasOwn(declared, fallbackTier)
      && (scriptFallback[item.id] || declared[fallbackTier].length === 0);
    if (disabled && !full && !risk.fallbackUsed) return null;
    const costTier = declaredTier ?? derivedTier ?? costTierForCheck(item.id);
    return {
      ...item,
      blockingScope: VALIDATION_TIER_BLOCKING_SCOPE[costTier],
      costTier,
      ...(commandStatus[item.id]?.status ? { status: commandStatus[item.id].status } : {}),
    };
  };
  const riskChecks = checks.map(withCost).filter(Boolean);
  // A tier run answers "how much evidence do I pay for now": it selects the
  // configured commands of the cumulative layers and reports the rest as
  // deferred, so a fast pass can never be mistaken for a complete one. An
  // unnamed run resolves to the fast layer, so the expensive layers are only
  // paid for when the caller asks for them.
  // `--full` is itself an explicit request for every declared layer, so it
  // never falls back to a cheaper layer.
  const resolved = tier ? resolveExecutionTier({ explicit: tierExplicit || full, tier, tiers: effectiveTiers }) : null;
  // An explicit `--tier` is honored exactly, including a layer the project
  // declares as empty: the caller asked for that layer, so the run reports the
  // gap instead of silently falling back to the legacy slot commands. An
  // unnamed run on a surface with no command in any layer keeps the risk-plan
  // path, which is how a project that declares only the four legacy slots
  // still gets a baseline run.
  if (resolved && !resolved.tier && tierExplicit && Object.hasOwn(config.validationCommands?.tiers ?? {}, tier)) {
    resolved.tier = tier;
  }
  const tierSelection = resolved?.tier ? selectTierChecks({
    commandStatus,
    tier: resolved.tier,
    tiers: effectiveTiers,
    metadata: config.validationCommands?.checks ?? [],
    projectDir: targetDir,
    only,
    pruneSubsumed: !full && !only,
  }) : null;
  // `--full` means the complete matrix: the tier surface covers the configured
  // commands, and the risk plan adds the checks it derives from the change
  // itself (for example schema validation or the lifecycle smoke suite). A
  // plain tier run stays exactly that layer, so a fast pass cannot quietly
  // execute the deferred commands through the risk plan.
  const extraRiskChecks = tierSelection
    ? riskChecks.filter((item) => !tierSelection.selectedChecks.some(
        (check) => check.id === item.id || check.command === item.command,
      ))
    : [];
  const selectedChecks = tierSelection
    ? (full ? [...tierSelection.selectedChecks, ...extraRiskChecks] : [...tierSelection.selectedChecks])
    : riskChecks;
  const selectedIds = new Set(selectedChecks.map((item) => item.id));
  const deferredChecks = full
    ? []
    : [
        ...(tierSelection?.deferredChecks ?? []),
        ...(tierSelection ? [] : deferredEvidence.map(withCost).filter(Boolean)),
      ].filter((item) => !selectedIds.has(item.id));
  const subsumedChecks = full || only ? [] : (tierSelection?.subsumedChecks ?? []);
  const metadata = validationCheckMap(config);
  const selectedWithMetadata = selectedChecks.map((item) => {
    const configured = metadata.get(item.id);
    if (!configured) return item;
    return {
      ...item,
      // The tier plan resolves the same declaration from the configuration, so
      // its execution identity has to match here too: without the configured
      // directory the same check would run from the repository root as well,
      // and the focused entrypoint would execute it twice.
      cwd: configured.cwd ?? item.cwd ?? '.',
      deterministic: configured.deterministic,
      resources: configured.resources,
      writesDependencies: configured.writesDependencies,
      cacheScope: configured.cacheScope,
      ...(configured.subsumes !== undefined ? { subsumes: configured.subsumes } : {}),
      ...(configured.estimatedDurationMs !== undefined ? { estimatedDurationMs: configured.estimatedDurationMs } : {}),
      ...(configured.resourceClass === 'repo-heavy' ? { resourceClass: 'repo-heavy' } : {}),
    };
  });
  const selectionReasonsByCheck = Object.fromEntries([...selectedWithMetadata, ...deferredChecks, ...subsumedChecks].map((item) => [
    item.id ?? item.command,
    [...new Set(item.selectionReasons ?? (item.reason ? [item.reason] : []))],
  ]));
  const cost = estimateVerificationCost(selectedWithMetadata, config);
  const scopeConfidence = verificationScopeConfidence({
    changedPaths: paths,
    coverageAvailable: coverage !== null && coverage !== undefined,
    focusedChecks: selectedWithMetadata,
    scope: verificationScope,
  });
  /** @type {any[]} */
  const microChecks = normalizeMicroChecks(config?.validationCommands?.micro);
  const microEligible = microChecks.filter((check) => check.scopes.includes(verificationScope));
  const selectedMicroChecks = microEligible.filter((check) => {
    if (risk.riskLevel === 'high' || risk.publicContract || risk.lifecycle) return false;
    if (scopeConfidence !== 'complete') return false;
    return check.costTier === 'quick' || check.kind === 'pure' || check.kind === 'rule';
  }).map((check) => ({ id: check.id, kind: check.kind ?? 'legacy', entry: check.entry, command: check.command, costTier: check.costTier ?? 'quick' }));
  const selectedMicroIds = new Set(selectedMicroChecks.map((check) => check.id));
  const deferredMicroChecks = microEligible
    .filter((check) => !selectedMicroIds.has(check.id))
    .map((check) => ({ id: check.id, reason: scopeConfidence !== 'complete' ? `scope confidence ${scopeConfidence}` : 'risk or tier requires formal evidence', costTier: check.costTier ?? 'quick' }));
  const minimumTier = minimumTierForRisk(risk, scopeConfidence);
  const escalationRequired = deferredChecks.length > 0 || deferredMicroChecks.length > 0 || scopeConfidence !== 'complete';
  return {
    ...risk,
    deliveryRisk: deliveryRiskPolicy(paths, { config, tier }),
    requiredChecks: buildDeliveryVerificationPlan({ changedPaths, config, projectDir: targetDir }).requiredChecks,
    missingRequiredEvidence: [],
    deferredChecks,
    subsumedChecks,
    executionTier: resolved?.tier ?? null,
    nextTier: resolved?.tier ? nextNonEmptyTier(resolved.tier, effectiveTiers) : null,
    planMode: full ? 'full' : (resolved?.tier ? 'tier:' + resolved.tier : 'auto'),
    riskSelectedChecks: riskChecks.map((item) => ({ id: item.id, command: item.command })),
    selectedChecks: selectedWithMetadata,
    selectionReasonsByCheck,
    minimumTier,
    selectedMicroChecks,
    deferredMicroChecks,
    escalation: {
      required: escalationRequired,
      reason: escalationRequired ? (scopeConfidence !== 'complete' ? `impact mapping is ${scopeConfidence}` : 'deferred evidence remains') : null,
      nextTier: resolved?.tier ? nextNonEmptyTier(resolved.tier, effectiveTiers) : (minimumTier === 'micro' ? 'unit' : 'integration'),
    },
    skippedChecks: known.filter((id) => !selectedIds.has(id)).map((id) => ({ id, status: 'not_selected' })),
    selectionReasons: [...new Set(reasons)],
    tierFallback: resolved?.fallback ?? null,
    tierSource,
    fallbackUsed: risk.fallbackUsed,
    scope: verificationScope,
    scopeConfidence,
    budgetMs: Number.isInteger(config?.verification?.budgetMs) ? config.verification.budgetMs : null,
    estimatedCostMs: cost.estimatedDurationMs,
    estimatedChecks: cost.estimatedChecks,
    environment: {
      mode: config?.verification?.environment?.mode ?? 'cold',
      fallback: config?.verification?.environment?.fallback ?? 'blocked',
    },
  };
}
