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
    lint: 'pnpm lint',
    typecheck: 'pnpm check:type',
    governance: 'pnpm run check:governance',
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
  assertNonEmptyString(config.validationCommands.lint, 'validationCommands.lint');
  assertNonEmptyString(config.validationCommands.typecheck, 'validationCommands.typecheck');
  assertNonEmptyString(config.validationCommands.governance, 'validationCommands.governance');
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
    '工作流交付包',
  ];
  const missing = requiredFragments.filter((fragment) => !content.includes(fragment));
  if (missing.length > 0) {
    throw new Error(`Generated AGENTS.md is missing required red lines: ${missing.join(', ')}`);
  }

  if (Array.isArray(installedTargets)) {
    const normalizedTargets = installedTargets.map((target) => target.replaceAll('\\', '/'));
    const surfaceChecks = [
      {
        exact: 'docs/rules/codegraph.md',
        fragment: 'docs/rules/codegraph.md',
        label: 'docs/rules/codegraph.md',
      },
      {
        fragment: '.agents/skills/',
        label: '.agents/skills/',
        prefix: '.agents/skills/',
      },
      {
        exact: '.codex/hooks.json',
        fragment: '.codex/hooks.json',
        label: '.codex/hooks.json',
      },
      {
        fragment: 'docs/workflows/',
        label: 'docs/workflows/',
        prefix: 'docs/workflows/',
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
