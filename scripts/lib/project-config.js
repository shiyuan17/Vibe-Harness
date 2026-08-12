import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { pathExists } from './manifest.js';
import { renderTemplate } from './template-renderer.js';
import { parsePluginsOption, resolveModuleSelection } from './module-selection.js';
import { assertPortableRelativePath } from './manifest.js';
import { validateJsonAgainstSchema } from './schema-validation.js';
import { safeJsonParse } from './safe-json.js';
import { productIdentity } from './product-identity.js';
import { resolveProjectConfigLocation } from './project-layout.js';

export const mvpProfiles = new Set(['minimal', 'core', 'full', 'docs-only']);
export const mvpTargets = new Set(['codex', 'claude', 'gemini', 'cursor', 'qoder', 'zcode', 'antigravity', 'opencode']);

export function canonicalProfile(profile) {
  if (profile === 'codex-internal') return 'full';
  if (profile === 'codex-minimal') return 'minimal';
  return profile;
}

export function validateProfileName(profile) {
  const canonical = canonicalProfile(profile);
  if (canonical !== profile) throw new Error(`Profile ${profile} was removed; use ${canonical}.`);
  if (!mvpProfiles.has(profile)) throw new Error(`Unknown profile: ${profile}`);
  return profile;
}

export const defaultProjectConfig = {
  projectName: 'ExampleProject',
  language: 'zh-CN',
  packageManager: 'pnpm',
  targets: ['codex'],
  profile: 'core',
  validationCommands: {
    lint: null,
    typecheck: null,
    test: null,
    eval: null,
  },
  evaluations: {
    enabled: false,
    suites: [],
    reference: 'evals/references/project.json',
    thresholds: {
      criticalPassRate: 1,
      overallScore: 0.9,
      maxCapabilityRegression: 0.05,
    },
    onlineRunner: null,
    repetitions: 3,
  },
  hooks: {
    allowedWriteRoots: [],
    allowedEgressHosts: [],
    mode: 'guarded',
    redZonePaths: ['.env', 'auth/', 'ci/cd/', '.github/workflows/', '.codex/hooks.json', '.cursor/hooks.json', '.cursor/mcp.json', '.mcp.json', '.qoder/settings.json', '.zcode/config.json', 'opencode.json', 'opencode.jsonc', '.agents/hooks.json', '.agents/mcp_config.json', '.claude/settings.json'],
  },
  riskZones: {
    red: ['auth', 'secrets', 'ci-cd', 'env'],
    yellow: ['shared-libs', 'state', 'routing', 'io-clients'],
  },
  crossRepo: {
    enabled: false,
    backendRepo: '',
  },
  projectRules: {
    mode: 'auto',
    overrides: {},
  },
  clarification: {
    posture: 'balanced',
  },
  memory: {
    enabled: true,
    path: '.agents/memory',
  },
};

export const forbiddenProjectTerms = [
  'SYBaseProjectWeb',
  'SYBaseProject',
  '病理',
  'localhost:5777',
];

let cachedProjectConfigSchema;

function loadProjectConfigSchema() {
  if (cachedProjectConfigSchema) return cachedProjectConfigSchema;
  const schemaPath = path.join(path.resolve(import.meta.dirname, '..', '..'), 'schemas', 'project-config.schema.json');
  cachedProjectConfigSchema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  return cachedProjectConfigSchema;
}

export function validateProjectConfigWithSchema(config) {
  const schema = loadProjectConfigSchema();
  const schemaErrors = validateJsonAgainstSchema(config, schema, 'vibe-harness.config.json');
  if (schemaErrors.length > 0) {
    throw new Error(`Invalid vibe-harness.config.json:\n  - ${schemaErrors.join('\n  - ')}`);
  }
  return validateProjectConfig(config);
}

export function profileToCatalogProfile(profile) {
  if (profile === 'minimal') {
    return 'minimal';
  }
  if (profile === 'core' || profile === 'full') {
    return profile;
  }
  return profile;
}

export function createDefaultProjectConfig(projectDir, target = 'codex', profile = 'core') {
  return {
    ...defaultProjectConfig,
    projectName: path.basename(path.resolve(projectDir)),
    profile,
    targets: [target],
  };
}

export async function writeDefaultProjectConfig({ force = false, projectDir, profile = 'core', target = 'codex' }) {
  const configPath = path.join(projectDir, productIdentity.configFile);
  if (!force && await pathExists(configPath)) {
    throw new Error(`Refusing to overwrite existing config: ${configPath}`);
  }
  await mkdir(projectDir, { recursive: true });
  if (!mvpTargets.has(target)) throw new Error(`Unknown target: ${target}`);
  validateProfileName(profile);
  const config = createDefaultProjectConfig(projectDir, target, profile);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { config, path: configPath };
}

export async function readProjectConfig(projectDir) {
  const location = await resolveProjectConfigLocation(projectDir);
  if (!location) {
  return createDefaultProjectConfig(projectDir);
  }
  return safeJsonParse(await readFile(location.path, 'utf8'));
}

export async function readRequiredProjectConfig(projectDir) {
  const location = await resolveProjectConfigLocation(projectDir);
  if (!location) {
    throw new Error(`Missing ${productIdentity.configFile}. Run vibe-harness init --project ${projectDir} first.`);
  }
  return safeJsonParse(await readFile(location.path, 'utf8'));
}

export function projectTargets(config) {
  if (Array.isArray(config?.targets)) return [...config.targets];
  return typeof config?.target === 'string' ? [config.target] : [];
}

export function migrateLegacyProjectConfig(config) {
  if (!Object.hasOwn(config, 'target')) return config;
  const migrated = { ...config, targets: [config.target] };
  delete migrated.target;
  return migrated;
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
}

export function resolveValidationCommands(config, projectProfile) {
  const configured = Object.fromEntries(
    Object.entries(config?.validationCommands ?? {}).filter(([, value]) => value),
  );
  return {
    ...(projectProfile?.validationCommands ?? {}),
    ...configured,
    eval: configured.eval ?? null,
  };
}

function assertOptionalCommand(value, label) {
  if (value !== null && value !== undefined) {
    assertNonEmptyString(value, label);
  }
}

export function validateProjectConfig(config) {
  assertObject(config, 'vibe-harness.config.json');
  const obsolete = [
    ...(Object.hasOwn(config, 'governance') ? ['governance'] : []),
    ...(Object.hasOwn(config.hooks ?? {}, 'completionGate') ? ['hooks.completionGate'] : []),
    ...(Object.hasOwn(config.validationCommands ?? {}, 'governance') ? ['validationCommands.governance'] : []),
  ];
  if (obsolete.length > 0) {
    throw Object.assign(new Error(`Obsolete governance configuration: ${obsolete.join(', ')}. Remove these fields before continuing.`), {
      code: 'VIBE_HARNESS_OBSOLETE_GOVERNANCE_CONFIG',
    });
  }
  assertNonEmptyString(config.projectName, 'projectName');
  const matchedTerm = forbiddenProjectTerms.find((term) => config.projectName.includes(term));
  if (matchedTerm) {
    throw Object.assign(
      new Error(`projectName must not contain forbidden source-project term: ${matchedTerm}`),
      { code: 'VIBE_HARNESS_FORBIDDEN_PROJECT_TERM' },
    );
  }
  assertNonEmptyString(config.packageManager, 'packageManager');
  const hasLegacyTarget = Object.hasOwn(config, 'target');
  const hasTargets = Object.hasOwn(config, 'targets');
  if (hasLegacyTarget === hasTargets) {
    throw new Error('Configure exactly one of target (legacy) or targets.');
  }
  const targets = projectTargets(config);
  if (targets.length === 0) throw new Error('targets must contain at least one adapter');
  if (new Set(targets).size !== targets.length) throw new Error('targets must not contain duplicate adapters');
  assertNonEmptyString(config.profile, 'profile');
  if (Object.hasOwn(config, 'language') && !['zh-CN', 'en-US'].includes(config.language)) {
    throw new Error('language must be zh-CN or en-US');
  }
  if (targets.some((target) => !mvpTargets.has(target))) {
    throw new Error(`Unknown target: ${config.target}`);
  }
  validateProfileName(config.profile);
  if (Object.hasOwn(config, 'modules')) {
    resolveModuleSelection({ requestedModules: config.modules });
  }
  if (Object.hasOwn(config, 'plugins')) {
    parsePluginsOption(config.plugins);
  }
  assertObject(config.validationCommands, 'validationCommands');
  assertOptionalCommand(config.validationCommands.lint, 'validationCommands.lint');
  assertOptionalCommand(config.validationCommands.typecheck, 'validationCommands.typecheck');
  assertOptionalCommand(config.validationCommands.test, 'validationCommands.test');
  assertOptionalCommand(config.validationCommands.eval, 'validationCommands.eval');
  if (Object.hasOwn(config, 'hooks')) {
    assertObject(config.hooks, 'hooks');
    if (Object.hasOwn(config.hooks, 'mode') && !['off', 'observe', 'guarded'].includes(config.hooks.mode)) {
      throw new Error('hooks.mode must be off, observe, or guarded');
    }
    if (Object.hasOwn(config.hooks, 'allowedWriteRoots')) {
      if (!Array.isArray(config.hooks.allowedWriteRoots)) {
        throw new Error('hooks.allowedWriteRoots must be an array');
      }
      for (const root of config.hooks.allowedWriteRoots) {
        if (typeof root !== 'string' || root.trim().length === 0 || !path.isAbsolute(root)) {
          throw new Error('hooks.allowedWriteRoots must contain non-empty absolute paths');
        }
      }
    }
    if (Object.hasOwn(config.hooks, 'allowedEgressHosts')) {
      if (!Array.isArray(config.hooks.allowedEgressHosts)) {
        throw new Error('hooks.allowedEgressHosts must be an array');
      }
      for (const host of config.hooks.allowedEgressHosts) {
        if (typeof host !== 'string' || host.trim().length === 0) {
          throw new Error('hooks.allowedEgressHosts must contain non-empty host strings');
        }
      }
    }
    if (Object.hasOwn(config.hooks, 'rtk')) {
      assertObject(config.hooks.rtk, 'hooks.rtk');
      if (typeof config.hooks.rtk.enabled !== 'boolean') {
        throw new Error('hooks.rtk.enabled must be boolean');
      }
    }
  }
  if (Object.hasOwn(config, 'projectRules')) {
    assertObject(config.projectRules, 'projectRules');
    if (!['auto', 'manual', 'off'].includes(config.projectRules.mode)) {
      throw new Error('projectRules.mode must be auto, manual, or off');
    }
    if (Object.hasOwn(config.projectRules, 'overrides')) {
      assertObject(config.projectRules.overrides, 'projectRules.overrides');
    }
  }
  if (Object.hasOwn(config, 'clarification')) {
    assertObject(config.clarification, 'clarification');
    if (!['action-leaning', 'balanced', 'conservative'].includes(config.clarification.posture)) {
      throw new Error('clarification.posture must be action-leaning, balanced, or conservative');
    }
  }
  if (Object.hasOwn(config, 'memory')) {
    assertObject(config.memory, 'memory');
    if (typeof config.memory.enabled !== 'boolean') {
      throw new Error('memory.enabled must be boolean');
    }
    assertNonEmptyString(config.memory.path, 'memory.path');
  }
  if (Object.hasOwn(config, 'evaluations')) {
    assertObject(config.evaluations, 'evaluations');
    if (typeof config.evaluations.enabled !== 'boolean') throw new Error('evaluations.enabled must be boolean');
    if (!Array.isArray(config.evaluations.suites)) throw new Error('evaluations.suites must be an array');
    for (const suite of config.evaluations.suites) {
      try {
        assertPortableRelativePath(suite, 'evaluations.suites');
      } catch {
        throw new Error('evaluations.suites must contain project-relative paths');
      }
    }
    try {
      assertPortableRelativePath(config.evaluations.reference, 'evaluations.reference');
    } catch {
      throw new Error('evaluations.reference must be a project-relative path');
    }
    if (config.evaluations.reference.replaceAll('\\', '/').startsWith('.agents/')) {
      throw new Error('evaluations.reference must be project-owned and cannot be stored under .agents');
    }
    assertObject(config.evaluations.thresholds, 'evaluations.thresholds');
    for (const name of ['criticalPassRate', 'overallScore', 'maxCapabilityRegression']) {
      const value = config.evaluations.thresholds[name];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(`evaluations.thresholds.${name} must be between 0 and 1`);
      }
    }
    if (config.evaluations.onlineRunner !== null && typeof config.evaluations.onlineRunner !== 'string') {
      throw new Error('evaluations.onlineRunner must be null or a command string');
    }
    if (!Number.isInteger(config.evaluations.repetitions) || config.evaluations.repetitions < 1 || config.evaluations.repetitions > 3) {
      throw new Error('evaluations.repetitions must be an integer from 1 to 3');
    }
  }
  return true;
}

function hasInstalledSurface(installedTargets, { exact, prefix, suffix }) {
  if (exact) {
    return installedTargets.includes(exact);
  }
  if (suffix) return installedTargets.some((target) => target.endsWith(suffix));
  return installedTargets.some((target) => target.startsWith(prefix));
}

// Localized red-line markers. The current adapter templates are zh-CN; the en-US
// set guards against future localized templates silently dropping the safety surface.
// Because the rendered template language may differ from config.language (e.g. an
// en-US project that still renders the zh-CN AGENTS template until a localized
// adapter template exists), we accept EITHER marker set: the safety surface must be
// present, but we do not require a specific language's wording.
const GENERATED_CONTENT_FRAGMENTS = {
  'zh-CN': ['编辑前', '红区', '人工确认', '验证'],
  'en-US': ['Edit before', 'red zone', 'manual confirmation', 'verify'],
};

export function validateGeneratedContent(content, { installedTargets, skillRoots } = {}) {
  const passesSomeLanguage = Object.values(GENERATED_CONTENT_FRAGMENTS).some(
    (fragments) => fragments.every((fragment) => content.includes(fragment)),
  );
  if (!passesSomeLanguage) {
    const allFragments = Object.values(GENERATED_CONTENT_FRAGMENTS).flat();
    throw new Error(`Generated AGENTS.md is missing required red lines; none of the localized marker sets (${allFragments.join(', ')}) were fully present.`);
  }

  if (Array.isArray(installedTargets)) {
    const normalizedTargets = installedTargets.map((target) => target.replaceAll('\\', '/'));
    const surfaceChecks = [
      {
        exact: 'docs/rules/codebase-memory-mcp.md',
        fragment: 'docs/rules/codebase-memory-mcp.md',
        label: 'docs/rules/codebase-memory-mcp.md',
      },
      {
        fragment: 'agentmemory',
        label: '<adapter>/skills/agentmemory/SKILL.md',
        suffix: '/skills/agentmemory/SKILL.md',
      },
      {
        exact: '.agents/memory/README.md',
        fragment: '.agents/memory/',
        label: '.agents/memory/README.md',
      },
      {
        exact: '.codex/hooks.json',
        fragment: '.codex/hooks.json',
        label: '.codex/hooks.json',
      },
      {
        exact: '.cursor/hooks.json',
        fragment: '.cursor/hooks.json',
        label: '.cursor/hooks.json',
      },
      {
        exact: '.qoder/settings.json',
        fragment: '.qoder/settings.json',
        label: '.qoder/settings.json',
      },
      {
        exact: '.zcode/config.json',
        fragment: '.zcode/config.json',
        label: '.zcode/config.json',
      },
      {
        exact: '.agents/hooks.json',
        fragment: '.agents/hooks.json',
        label: '.agents/hooks.json',
      },
      {
        exact: '.agents/mcp_config.json',
        fragment: '.agents/mcp_config.json',
        label: '.agents/mcp_config.json',
      },
    ];

    // Skill-root prefixes are derived from the adapter catalog (excluding adapters
    // whose `capabilities.skills` is `unsupported`, e.g. zcode) and passed by the
    // caller. Fall back to the historical hardcoded set only when the caller did
    // not supply catalog-derived prefixes, preserving backward compatibility.
    const knownSkillRoots = Array.isArray(skillRoots) && skillRoots.length > 0
      ? skillRoots.map((root) => `${root}/`)
      : ['.agents/skills/', '.claude/skills/', '.cursor/skills/', '.gemini/skills/', '.qoder/skills/', '.opencode/skills/'];
    for (const skillRoot of knownSkillRoots) {
      if (content.includes(skillRoot) && !normalizedTargets.some((target) => target.startsWith(skillRoot))) {
        throw new Error(`Generated AGENTS.md references ${skillRoot} but it is not installed by profile.`);
      }
    }

    for (const check of surfaceChecks) {
      if (content.includes(check.fragment) && !hasInstalledSurface(normalizedTargets, check)) {
        throw new Error(`Generated AGENTS.md references ${check.label} but it is not installed by profile.`);
      }
    }
  }
}

export function validateConfigAndGeneratedContent(config, agentsTemplate, options = {}) {
  const validationConfig = { ...config };
  if (Array.isArray(validationConfig.targets)) delete validationConfig.target;
  validateProjectConfig(validationConfig);
  const rendered = renderTemplate(agentsTemplate, config);
  validateGeneratedContent(rendered, options);
  return rendered;
}
