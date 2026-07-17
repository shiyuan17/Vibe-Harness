import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { pathExists } from './manifest.js';
import { renderTemplate } from './template-renderer.js';
import { resolveModuleSelection } from './module-selection.js';
import { assertPortableRelativePath } from './manifest.js';

export const mvpProfiles = new Set(['minimal', 'core', 'full', 'docs-only']);
export const mvpTargets = new Set(['codex', 'claude', 'gemini']);

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
  target: 'codex',
  profile: 'core',
  validationCommands: {
    lint: null,
    typecheck: null,
    governance: 'node .agents/loopengine/governance/validate.mjs',
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
  governance: {
    mode: 'basic',
  },
  hooks: {
    completionGate: 'advisory',
    mode: 'guarded',
  },
  riskZones: {
    red: ['auth', 'global request layer', 'ci/cd', 'env'],
    yellow: ['shared components', 'stores', 'routing', 'request clients'],
  },
  crossRepo: {
    enabled: false,
    backendRepo: '',
  },
  projectRules: {
    mode: 'auto',
    overrides: {},
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
    governance: {
      ...defaultProjectConfig.governance,
      mode: profile === 'minimal' ? 'off' : (profile === 'full' || profile === 'docs-only' ? 'full' : 'basic'),
    },
    projectName: path.basename(path.resolve(projectDir)),
    profile,
    target,
  };
}

export async function writeDefaultProjectConfig({ force = false, projectDir, profile = 'core', target = 'codex' }) {
  const configPath = path.join(projectDir, 'loopengine.config.json');
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
  const configPath = path.join(projectDir, 'loopengine.config.json');
  if (!await pathExists(configPath)) {
  return createDefaultProjectConfig(projectDir);
  }
  return JSON.parse(await readFile(configPath, 'utf8'));
}

export async function readRequiredProjectConfig(projectDir) {
  const configPath = path.join(projectDir, 'loopengine.config.json');
  if (!await pathExists(configPath)) {
    throw new Error(`Missing loopengine.config.json. Run loopengine init --project ${projectDir} first.`);
  }
  return JSON.parse(await readFile(configPath, 'utf8'));
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

export function resolveGovernanceMode(config, profile = config?.profile) {
  if (profile === config?.profile && config?.governance?.mode) return config.governance.mode;
  if (profile === 'minimal') return 'off';
  if (['full', 'docs-only'].includes(profile)) return 'full';
  return 'basic';
}

export function validateGovernanceModeForProfile(mode, profile) {
  const allowed = profile === 'minimal'
    ? ['off']
    : (profile === 'core' ? ['basic', 'off'] : ['basic', 'full', 'off']);
  if (!allowed.includes(mode)) {
    throw new Error(`governance.mode=${mode} is not supported by profile ${profile}`);
  }
}

export function resolveValidationCommands(config, projectProfile, governanceMode) {
  const configured = Object.fromEntries(
    Object.entries(config?.validationCommands ?? {}).filter(([, value]) => value),
  );
  return {
    ...(projectProfile?.validationCommands ?? {}),
    ...configured,
    governance: governanceMode === 'off'
      ? null
      : (configured.governance ?? 'node .agents/loopengine/governance/validate.mjs'),
    eval: configured.eval ?? null,
  };
}

function assertOptionalCommand(value, label) {
  if (value !== null && value !== undefined) {
    assertNonEmptyString(value, label);
  }
}

export function validateProjectConfig(config) {
  assertObject(config, 'loopengine.config.json');
  assertNonEmptyString(config.projectName, 'projectName');
  assertNonEmptyString(config.packageManager, 'packageManager');
  assertNonEmptyString(config.target, 'target');
  assertNonEmptyString(config.profile, 'profile');
  if (Object.hasOwn(config, 'language') && !['zh-CN', 'en-US'].includes(config.language)) {
    throw new Error('language must be zh-CN or en-US');
  }
  if (!mvpTargets.has(config.target)) {
    throw new Error(`Unknown target: ${config.target}`);
  }
  validateProfileName(config.profile);
  if (Object.hasOwn(config, 'modules')) {
    resolveModuleSelection({ requestedModules: config.modules });
  }
  assertObject(config.validationCommands, 'validationCommands');
  assertOptionalCommand(config.validationCommands.lint, 'validationCommands.lint');
  assertOptionalCommand(config.validationCommands.typecheck, 'validationCommands.typecheck');
  assertOptionalCommand(config.validationCommands.eval, 'validationCommands.eval');
  if (config.governance?.mode === 'off') {
    assertOptionalCommand(config.validationCommands.governance, 'validationCommands.governance');
  } else {
    assertNonEmptyString(config.validationCommands.governance, 'validationCommands.governance');
  }
  if (Object.hasOwn(config, 'governance')) {
    assertObject(config.governance, 'governance');
    if (!['basic', 'full', 'off'].includes(config.governance.mode)) {
      throw new Error('governance.mode must be basic, full, or off');
    }
  }
  if (Object.hasOwn(config, 'hooks')) {
    assertObject(config.hooks, 'hooks');
    if (Object.hasOwn(config.hooks, 'mode') && !['off', 'observe', 'guarded', 'strict'].includes(config.hooks.mode)) {
      throw new Error('hooks.mode must be off, observe, guarded, or strict');
    }
    if (Object.hasOwn(config.hooks, 'completionGate') && !['off', 'advisory', 'blocking'].includes(config.hooks.completionGate)) {
      throw new Error('hooks.completionGate must be off, advisory, or blocking');
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

export function validateGeneratedContent(content, { installedTargets } = {}) {
  const requiredFragments = [
    '编辑前',
    '红区',
    '人工确认',
    '验证证据',
    '轻量反证',
  ];
  const missing = requiredFragments.filter((fragment) => !content.includes(fragment));
  if (missing.length > 0) {
    throw new Error(`Generated AGENTS.md is missing required red lines: ${missing.join(', ')}`);
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
    ];

    for (const skillRoot of ['.agents/skills/', '.claude/skills/', '.gemini/skills/']) {
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
  validateProjectConfig(config);
  const rendered = renderTemplate(agentsTemplate, config);
  validateGeneratedContent(rendered, options);
  return rendered;
}
