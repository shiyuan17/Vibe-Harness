import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { pathExists } from './manifest.js';
import { renderTemplate } from './template-renderer.js';

export const mvpProfiles = new Set(['minimal', 'core', 'full']);
export const mvpTargets = new Set(['codex']);

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

export function createDefaultProjectConfig(projectDir) {
  return {
    ...defaultProjectConfig,
    projectName: path.basename(path.resolve(projectDir)),
  };
}

export async function writeDefaultProjectConfig({ force = false, projectDir }) {
  const target = path.join(projectDir, 'loopengine.config.json');
  if (!force && await pathExists(target)) {
    throw new Error(`Refusing to overwrite existing config: ${target}`);
  }
  await mkdir(projectDir, { recursive: true });
  const config = createDefaultProjectConfig(projectDir);
  await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { config, path: target };
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
  if (profile === 'minimal' || profile === 'codex-minimal') return 'off';
  if (['full', 'codex-internal', 'docs-only'].includes(profile)) return 'full';
  return 'basic';
}

export function validateGovernanceModeForProfile(mode, profile) {
  const allowed = profile === 'minimal' || profile === 'codex-minimal'
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
  if (!mvpTargets.has(config.target)) {
    throw new Error(`Unknown target: ${config.target}`);
  }
  if (!mvpProfiles.has(config.profile)) {
    throw new Error(`Unknown profile: ${config.profile}`);
  }
  assertObject(config.validationCommands, 'validationCommands');
  assertOptionalCommand(config.validationCommands.lint, 'validationCommands.lint');
  assertOptionalCommand(config.validationCommands.typecheck, 'validationCommands.typecheck');
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
  return true;
}

function hasInstalledSurface(installedTargets, { exact, prefix }) {
  if (exact) {
    return installedTargets.includes(exact);
  }
  return installedTargets.some((target) => target.startsWith(prefix));
}

export function validateGeneratedContent(content, { installedTargets } = {}) {
  const requiredFragments = [
    'git status --short',
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
        fragment: '.agents/skills/',
        label: '.agents/skills/',
        prefix: '.agents/skills/',
      },
      {
        exact: '.agents/skills/agentmemory/SKILL.md',
        fragment: 'agentmemory',
        label: '.agents/skills/agentmemory/SKILL.md',
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
