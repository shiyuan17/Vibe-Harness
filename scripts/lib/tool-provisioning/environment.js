import path from 'node:path';

import { assertInsideDir } from '../manifest.js';
import {
  assertPluginProviderCatalog,
  pluginProviderCatalog,
  pluginProviderForTool,
} from '../plugin-provider-catalog.js';
import { projectStateDir } from '../project-layout.js';

import { npmInvocation } from './subprocess.js';

export function detectLinuxLibc() {
  if (process.platform !== 'linux') return null;
  try {
    return process.report?.getReport?.().header?.glibcVersionRuntime ? 'gnu' : 'musl';
  } catch {
    return null;
  }
}

export function resolveAstGrepPlatformPackage({ arch = process.arch, libc = detectLinuxLibc(), platform = process.platform } = {}) {
  const packages = {
    darwin: { arm64: '@ast-grep/cli-darwin-arm64', x64: '@ast-grep/cli-darwin-x64' },
    linux: {
      arm64: libc === 'gnu' ? '@ast-grep/cli-linux-arm64-gnu' : null,
      x64: libc === 'gnu' ? '@ast-grep/cli-linux-x64-gnu' : null,
    },
    win32: {
      arm64: '@ast-grep/cli-win32-arm64-msvc',
      ia32: '@ast-grep/cli-win32-ia32-msvc',
      x64: '@ast-grep/cli-win32-x64-msvc',
    },
  };
  return packages[platform]?.[arch] ?? null;
}

export function resolveToolNativePackage(spec, { arch = process.arch, libc = detectLinuxLibc(), platform = process.platform } = {}) {
  return spec.nativePackageResolver?.({ arch, libc, platform }) ?? null;
}

const toolSpecs = [
  {
    id: 'codebaseMemoryMcp',
    packageName: 'codebase-memory-mcp',
    phases: [
      'dependency-install',
      'binary-install',
      'configure-auto-index',
      'configure-auto-watch',
      'index',
      'index-verify',
      'mcp-handshake',
    ],
    relativeDir: '.agents/runtime/tools/codebase-memory-mcp',
    version: '0.9.0',
  },
  {
    id: 'playwrightCli',
    packageName: '@playwright/cli',
    phases: ['dependency-install', 'browser-install'],
    relativeDir: '.agents/runtime/tools/playwright-cli',
    version: '0.1.17',
  },
  {
    id: 'chromeDevtoolsMcp',
    packageName: 'chrome-devtools-mcp',
    phases: ['dependency-install', 'browser-smoke'],
    relativeDir: '.agents/runtime/tools/chrome-devtools-mcp',
    version: '1.6.0',
  },
  {
    id: 'openCodeReview',
    packageName: '@alibaba-group/open-code-review',
    phases: ['dependency-install', 'llm-test'],
    relativeDir: '.agents/runtime/tools/open-code-review',
    version: '1.7.7',
  },
  {
    id: 'rtk',
    packageName: 'rtk-ai/rtk',
    phases: ['dependency-install', 'binary-install'],
    relativeDir: '.agents/runtime/tools/rtk',
    source: 'github:rtk-ai/rtk@v0.45.0',
    version: '0.45.0',
  },
  {
    id: 'astGrep',
    packageName: '@ast-grep/cli',
    nativePackageResolver: resolveAstGrepPlatformPackage,
    npmInstallArgs: ['--include=optional'],
    phases: ['dependency-install', 'binary-install'],
    relativeDir: '.agents/runtime/tools/ast-grep',
    version: '0.45.1',
  },
];

assertPluginProviderCatalog(pluginProviderCatalog, {
  provisioningToolIds: new Set(toolSpecs.map((spec) => spec.id)),
});

function resolveToolSpec(spec, targetDir, mode = 'eager') {
  const toolDir = path.resolve(targetDir, spec.relativeDir);
  assertInsideDir(targetDir, toolDir, `${spec.id} tool directory`);
  return { ...spec, mode, toolDir };
}

export function createToolProvisioningPlan({ allowPreview = false, profile, resolvedModules, targetDir, toolIds }) {
  let plan = [];
  if (Array.isArray(resolvedModules)) {
    plan = toolSpecs
      .filter((spec) => resolvedModules.includes(pluginProviderForTool(spec.id).moduleId))
      .map((spec) => resolveToolSpec(
        spec,
        targetDir,
        spec.id === 'playwrightCli' && profile === 'core' ? 'lazy' : 'eager',
      ));
  }
  plan = plan.map((spec) => ({ supportLevel: spec.supportLevel ?? 'stable', ...spec }));
  if (!toolIds?.length) return allowPreview ? plan : plan.filter((spec) => spec.supportLevel !== 'preview');
  const requested = new Set(toolIds);
  const selected = plan.filter((spec) => requested.has(spec.id));
  const unavailable = [...requested].filter((id) => !selected.some((spec) => spec.id === id));
  if (unavailable.length > 0) {
    throw new Error(`Unknown or unavailable tool for profile ${profile}: ${unavailable.join(', ')}`);
  }
  const preview = selected.filter((spec) => spec.supportLevel === 'preview').map((spec) => spec.id);
  if (preview.length > 0 && !allowPreview) {
    throw new Error(`Preview tools require --allow-preview: ${preview.join(', ')}`);
  }
  return selected;
}

export function hasOcrCredentials(env) {
  return Boolean(
    (env.OCR_LLM_URL && env.OCR_LLM_TOKEN && env.OCR_LLM_MODEL)
    || env.OPENAI_API_KEY
    || env.ANTHROPIC_API_KEY,
  );
}

const baseEnvironmentNames = new Set([
  'APPDATA', 'COMSPEC', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOCALAPPDATA', 'PATH', 'Path',
  'PATHEXT', 'PROGRAMDATA', 'ProgramData', 'SHELL', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR',
  'USERPROFILE', 'WINDIR',
]);

const packageManagerEnvironmentNames = new Set([
  'ALL_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY',
  'NO_PROXY', 'SSL_CERT_DIR', 'SSL_CERT_FILE',
  'all_proxy', 'https_proxy', 'http_proxy', 'no_proxy', 'npm_config_offline',
  'npm_config_prefer_offline', 'npm_config_registry',
]);

const toolEnvironmentNames = Object.fromEntries(toolSpecs.map((spec) => [
  spec.id,
  packageManagerEnvironmentNames,
]));

const toolCredentialNames = {
  openCodeReview: new Set([
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
    'OCR_LLM_AUTH_HEADER', 'OCR_LLM_EXTRA_HEADERS', 'OCR_LLM_MODEL', 'OCR_LLM_PROTOCOL',
    'OCR_LLM_TIMEOUT', 'OCR_LLM_TOKEN', 'OCR_LLM_URL', 'OCR_USE_ANTHROPIC',
    'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL',
  ]),
};

export function allowedEnvironment(spec, env) {
  const allowedNames = new Set([
    ...baseEnvironmentNames,
    ...(toolEnvironmentNames[spec.id] ?? []),
    ...(toolCredentialNames[spec.id] ?? []),
  ]);
  return Object.fromEntries(Object.entries(env).filter(([name]) => allowedNames.has(name)));
}

export async function componentEnvironment(spec, targetDir, env, { codebaseMemoryCacheDir } = {}) {
  const stateRoot = path.join(await projectStateDir(targetDir), 'tool-state');
  const npmCache = path.join(stateRoot, 'npm-cache', spec.id);
  const baseEnv = allowedEnvironment(spec, env);
  if (spec.id === 'codebaseMemoryMcp') {
    return {
      ...baseEnv,
      CBM_ALLOWED_ROOT: targetDir,
      CBM_CACHE_DIR: codebaseMemoryCacheDir ?? path.join(stateRoot, 'codebase-memory-mcp/cache'),
      CBM_MEM_BUDGET_MB: '2048',
      CBM_WORKERS: '2',
      npm_config_cache: npmCache,
    };
  }
  if (spec.id === 'openCodeReview') {
    const home = path.join(stateRoot, 'open-code-review/home');
    return { ...baseEnv, HOME: home, USERPROFILE: home, npm_config_cache: npmCache };
  }
  if (spec.id === 'rtk') {
    return {
      ...baseEnv,
      npm_config_cache: npmCache,
      npm_config_registry: baseEnv.npm_config_registry ?? 'https://registry.npmjs.org/',
    };
  }
  if (spec.id === 'astGrep') {
    return {
      ...baseEnv,
      npm_config_cache: npmCache,
      npm_config_include: 'optional',
      npm_config_optional: 'true',
      npm_config_registry: baseEnv.npm_config_registry ?? 'https://registry.npmjs.org/',
    };
  }
  return { ...baseEnv, npm_config_cache: npmCache };
}

export async function phaseRequest(spec, phase, targetDir, env, context = {}) {
  const componentEnv = await componentEnvironment(spec, targetDir, env, context);
  if (phase === 'dependency-install') {
    const npmArgs = ['ci', '--no-audit', '--no-fund', '--ignore-scripts', ...(spec.npmInstallArgs ?? [])];
    return { ...await npmInvocation(npmArgs), component: spec.id, cwd: spec.toolDir, env: componentEnv, phase, timeout: 600_000 };
  }
  if (phase === 'binary-install' && spec.id === 'rtk') {
    return {
      args: [path.join(spec.toolDir, 'run.mjs'), 'install'],
      command: process.execPath,
      component: spec.id,
      cwd: targetDir,
      env: componentEnv,
      phase,
      timeout: 600_000,
    };
  }
  if (phase === 'binary-install' && spec.id === 'astGrep') {
    return {
      args: [path.join(spec.toolDir, 'node_modules/@ast-grep/cli/postinstall.js')],
      command: process.execPath,
      component: spec.id,
      cwd: spec.toolDir,
      env: componentEnv,
      phase,
      timeout: 120_000,
    };
  }
  if (phase === 'binary-install') {
    return {
      args: [path.join(spec.toolDir, 'node_modules/codebase-memory-mcp/install.js')],
      command: process.execPath,
      component: spec.id,
      cwd: spec.toolDir,
      env: componentEnv,
      phase,
      timeout: 600_000,
    };
  }
  if (phase === 'index') {
    return {
    args: [
        path.join(spec.toolDir, 'run.mjs'),
        'cli',
        'index_repository',
        '--repo-path',
        '.',
        '--mode',
        'moderate',
        '--persistence',
        'false',
      ],
      command: process.execPath,
      component: spec.id,
      cwd: targetDir,
      env: componentEnv,
      phase,
      timeout: 600_000,
    };
  }
  if (phase === 'index-verify') {
    return {
      args: [
        path.join(spec.toolDir, 'run.mjs'),
        'cli',
        'index_status',
        '--project',
        context.indexProject,
      ],
      command: process.execPath,
      component: spec.id,
      cwd: targetDir,
      env: componentEnv,
      phase,
      timeout: 120_000,
    };
  }
  if (phase === 'llm-test') {
    return {
      args: [path.join(spec.toolDir, 'run.mjs'), 'llm', 'test'],
      command: process.execPath,
      component: spec.id,
      cwd: targetDir,
      env: componentEnv,
      phase,
      timeout: 120_000,
    };
  }
  if (phase === 'browser-install') {
    return {
      args: [path.join(spec.toolDir, 'run.mjs'), 'install-browser', 'chromium'],
      command: process.execPath,
      component: spec.id,
      cwd: targetDir,
      env: componentEnv,
      phase,
      timeout: 600_000,
    };
  }
  if (phase === 'configure-auto-index' || phase === 'configure-auto-watch') {
    return {
      args: [
        path.join(spec.toolDir, 'run.mjs'),
        'config',
        'set',
        phase === 'configure-auto-index' ? 'auto_index' : 'auto_watch',
        'false',
      ],
      command: process.execPath,
      component: spec.id,
      cwd: targetDir,
      env: componentEnv,
      phase,
      timeout: 120_000,
    };
  }
  if (phase === 'browser-smoke') {
    return {
      args: [path.join(spec.toolDir, 'run.mjs')],
      command: process.execPath,
      component: spec.id,
      cwd: targetDir,
      env: componentEnv,
      phase,
      timeout: 60_000,
    };
  }
  return {
    args: [path.join(spec.toolDir, 'run.mjs')],
    command: process.execPath,
    component: spec.id,
    cwd: targetDir,
    env: componentEnv,
    phase,
    timeout: 30_000,
  };
}

export { toolSpecs };
