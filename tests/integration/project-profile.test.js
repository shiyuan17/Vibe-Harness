import '../helpers/offline-tools.js';

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { detectProjectProfile } from '../../scripts/lib/project-profile.js';
import { renderTemplate } from '../../scripts/lib/template-renderer.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '../..');
const cliPath = path.join(rootDir, 'scripts/vibe-harness.js');

async function runCli(args) {
  const effectiveArgs = args[0] === 'install' && args.includes('--dry-run') && !args.includes('--verbose')
    ? [...args, '--verbose']
    : args;
  const result = await execFileAsync(process.execPath, [cliPath, ...effectiveArgs], {
    maxBuffer: 1024 * 1024 * 8,
  });
  return result.stdout ? JSON.parse(result.stdout) : null;
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('detectProjectProfile summarizes Vue Vite pnpm projects', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-profile-node-'));
  try {
    await mkdir(path.join(target, '.git'));
    await writeJson(path.join(target, 'package.json'), {
      packageManager: 'pnpm@10.33.0',
      scripts: {
        check: 'pnpm lint && pnpm check:type',
        'check:type': 'vue-tsc --noEmit',
        lint: 'oxlint . && oxfmt --check .',
        'test:unit': 'vitest run',
      },
      dependencies: {
        vue: '^3.5.0',
      },
      devDependencies: {
        '@vitejs/plugin-vue': '^5.0.0',
        oxlint: '^1.0.0',
        oxfmt: '^0.58.0',
        turbo: '^2.0.0',
        vite: '^5.0.0',
        vitest: '^2.0.0',
      },
    });
    await writeFile(path.join(target, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n', 'utf8');

    const profile = await detectProjectProfile({ targetDir: target });

    assert.equal(profile.packageManager, 'pnpm');
    assert.equal(profile.vcsSummary, 'Git');
    assert.match(profile.stackSummary, /Node\.js/);
    assert.match(profile.stackSummary, /Vue 3/);
    assert.match(profile.stackSummary, /Vite/);
    assert.match(profile.stackSummary, /Turbo/);
    assert.match(profile.codingStandards, /oxlint/);
    assert.match(profile.verificationSummary, /pnpm lint/);
    assert.match(profile.reviewGuidance, /package\.json scripts/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('detectProjectProfile prefers target package manager unless overrides are explicit', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-profile-package-manager-'));
  try {
    await writeJson(path.join(target, 'package.json'), {
      packageManager: 'npm@10.8.0',
      scripts: {
        lint: 'eslint .',
      },
      devDependencies: {
        eslint: '^9.0.0',
      },
    });

    const detected = await detectProjectProfile({ config: { packageManager: 'pnpm' }, targetDir: target });
    const overridden = await detectProjectProfile({
      config: {
        packageManager: 'pnpm',
        projectRules: {
          mode: 'auto',
          overrides: { packageManager: 'yarn' },
        },
      },
      targetDir: target,
    });

    assert.equal(detected.packageManager, 'npm');
    assert.match(detected.verificationSummary, /npm run lint/);
    assert.equal(overridden.packageManager, 'yarn');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('detectProjectProfile supports manual and off project rule modes', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-profile-mode-'));
  try {
    await writeJson(path.join(target, 'package.json'), {
      packageManager: 'npm@10.8.0',
      dependencies: { react: '^19.0.0' },
    });

    const manual = await detectProjectProfile({
      config: {
        projectRules: {
          mode: 'manual',
          overrides: {
            stackSummary: 'Manual stack',
            vcsStatusCommand: 'svn status',
            logging: {
              frameworks: ['Pino'],
              sources: ['application stdout'],
              queries: ['npm run logs'],
              verification: ['npm test'],
            },
          },
        },
      },
      targetDir: target,
    });
    const off = await detectProjectProfile({
      config: {
        projectRules: {
          mode: 'off',
          overrides: {
            stackSummary: 'Should not appear',
          },
        },
      },
      targetDir: target,
    });

    assert.equal(manual.stackSummary, 'Manual stack');
    assert.equal(manual.vcsStatusCommand, 'svn status');
    assert.doesNotMatch(manual.stackSummary, /React/);
    assert.equal(manual.logging.status, 'complete');
    assert.deepEqual(manual.logging.evidence.frameworks, []);
    assert.deepEqual(manual.logging.contract.frameworks, ['Pino']);
    assert.equal(off.stackSummary, '未识别到主技术栈；以目标项目现有文件为准。');
    assert.doesNotMatch(off.stackSummary, /Should not appear/);
    assert.equal(off.logging.status, 'unknown');
    assert.deepEqual(off.logging.contract.frameworks, []);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('detectProjectProfile discovers only repository-backed Node logging candidates', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-profile-node-logging-'));
  try {
    await writeJson(path.join(target, 'package.json'), {
      packageManager: 'pnpm@10.33.0',
      scripts: { 'logs:api': 'node scripts/read-logs.mjs', start: 'node src/server.js' },
      dependencies: { pino: '^9.0.0', winston: '^3.0.0' },
    });
    await mkdir(path.join(target, 'src'));
    await writeFile(path.join(target, 'src/logger.ts'), 'export const fields = { traceId: true, requestId: true };\n', 'utf8');
    await writeFile(path.join(target, 'pino.config.js'), 'export default {};\n', 'utf8');

    const profile = await detectProjectProfile({
      config: { projectRules: { mode: 'auto', overrides: { logging: { sources: ['application stdout'] } } } },
      targetDir: target,
    });

    assert.deepEqual(profile.logging.evidence.frameworks, ['Pino', 'Winston']);
    assert.deepEqual(profile.logging.evidence.configFiles, ['pino.config.js']);
    assert.deepEqual(profile.logging.evidence.queryCandidates, ['pnpm logs:api']);
    assert.deepEqual(profile.logging.evidence.correlationCandidates, ['traceId', 'requestId']);
    assert.deepEqual(profile.logging.contract.sources, ['application stdout']);
    assert.equal(profile.logging.status, 'partial');
    assert.doesNotMatch(JSON.stringify(profile.logging), /kubectl|docker|cloud|\.log\b/iu);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('detectProjectProfile excludes Vibe-Harness managed targets from logging evidence', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-profile-managed-targets-'));
  try {
    const managedSchema = 'docs/schemas/execution-envelope.schema.json';
    const generatedFile = 'generated/request-context.json';
    const generatedDirectory = 'generated/runtime';
    await mkdir(path.join(target, '.vibe-harness'), { recursive: true });
    await mkdir(path.join(target, 'docs/schemas'), { recursive: true });
    await mkdir(path.join(target, 'generated/runtime/nested'), { recursive: true });
    await writeFile(path.join(target, managedSchema), '{"requestId":true}\n', 'utf8');
    await writeFile(path.join(target, generatedFile), '{"traceId":true}\n', 'utf8');
    await writeFile(path.join(target, generatedDirectory, 'nested/context.json'), '{"spanId":true,"correlationId":true}\n', 'utf8');
    await writeJson(path.join(target, '.vibe-harness/install-state.json'), {
      files: [{
        created: true,
        group: 'schemas',
        redZone: false,
        source: 'schemas/execution-envelope.schema.json',
        sourceHash: 'source-hash',
        target: managedSchema,
        targetHash: 'target-hash',
      }],
      generatedDirectories: [{ ownerTarget: managedSchema, projectScoped: true, target: generatedDirectory }],
      generatedFiles: [{ target: generatedFile, targetHash: 'generated-hash' }],
      profile: 'core',
      product: 'vibe-harness',
      stateVersion: 5,
      targets: ['codex'],
      version: '1.0.0',
    });

    const profile = await detectProjectProfile({ targetDir: target });

    assert.equal(profile.logging.status, 'unknown');
    assert.deepEqual(profile.logging.evidence.correlationCandidates, []);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('detectProjectProfile redacts secrets from explicit logging guidance', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-profile-logging-redaction-'));
  try {
    const profile = await detectProjectProfile({
      config: {
        projectRules: {
          mode: 'manual',
          overrides: { logging: { queries: ['pnpm logs --token=top-secret'], verification: ['Bearer hidden-value'] } },
        },
      },
      targetDir: target,
    });
    assert.deepEqual(profile.logging.contract.queries, ['pnpm logs --token=[REDACTED]']);
    assert.deepEqual(profile.logging.contract.verification, ['Bearer [REDACTED]']);
    assert.doesNotMatch(profile.logging.contractSummary, /top-secret|hidden-value/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('detectProjectProfile recognizes explicit Spring and dotnet logging dependencies', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-profile-managed-logging-'));
  try {
    await writeFile(path.join(target, 'pom.xml'), '<project><dependencies><dependency><artifactId>logback-classic</artifactId></dependency><dependency><artifactId>spring-boot-starter-log4j2</artifactId></dependency></dependencies></project>', 'utf8');
    await writeFile(path.join(target, 'logback-spring.xml'), '<configuration />', 'utf8');
    await writeFile(path.join(target, 'log4j2.xml'), '<Configuration />', 'utf8');
    await mkdir(path.join(target, 'src'));
    await writeFile(path.join(target, 'src/App.csproj'), '<Project><ItemGroup><PackageReference Include="Serilog" /><PackageReference Include="NLog" /></ItemGroup></Project>', 'utf8');
    await writeFile(path.join(target, 'src/NLog.config'), '<nlog />', 'utf8');

    const profile = await detectProjectProfile({ targetDir: target });

    assert.deepEqual(profile.logging.evidence.frameworks, ['Logback', 'Log4j', 'Serilog', 'NLog']);
    assert.deepEqual(profile.logging.evidence.configFiles, ['log4j2.xml', 'logback-spring.xml', 'src/NLog.config']);
    assert.equal(profile.logging.status, 'partial');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('detectProjectProfile leaves unsupported projects without invented logging facts', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-profile-unknown-logging-'));
  try {
    await writeFile(path.join(target, 'README.md'), '# Plain project\n', 'utf8');
    const profile = await detectProjectProfile({ targetDir: target });
    assert.equal(profile.logging.status, 'unknown');
    assert.deepEqual(profile.logging.evidence, {
      frameworks: [], configFiles: [], queryCandidates: [], correlationCandidates: [],
    });
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('detectProjectProfile summarizes Maven and legacy dotnet projects', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-profile-mixed-'));
  try {
    await mkdir(path.join(target, '.svn'));
    await writeFile(
      path.join(target, 'pom.xml'),
      '<project><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>',
      'utf8',
    );
    await writeFile(path.join(target, 'Legacy.sln'), 'Microsoft Visual Studio Solution File\n', 'utf8');
    await mkdir(path.join(target, 'src'));
    await writeFile(path.join(target, 'src/Legacy.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />', 'utf8');

    const profile = await detectProjectProfile({ targetDir: target });

    assert.equal(profile.packageManager, 'Maven');
    assert.equal(profile.vcsStatusCommand, 'svn status');
    assert.match(profile.stackSummary, /Java/);
    assert.match(profile.stackSummary, /Maven/);
    assert.match(profile.stackSummary, /Spring/);
    assert.match(profile.stackSummary, /\.NET/);
    assert.match(profile.verificationSummary, /mvn test/);
    assert.match(profile.verificationSummary, /MSBuild/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('generated entry uses detected VCS command and plain unconfigured validation labels', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-profile-entry-'));
  try {
    await mkdir(path.join(target, '.svn'));
    await runCli(['init', '--project', target]);

    const report = await runCli(['install', '--project', target, '--target', 'codex', '--profile', 'core', '--dry-run', '--verbose']);
    const agents = report.previewFiles.find((file) => file.target === 'AGENTS.md').content;

    assert.match(agents, /编辑前运行 `svn status`/u);
    assert.doesNotMatch(agents, /编辑前运行 `git status --short`/u);
    assert.match(agents, /Lint: 未配置/u);
    assert.match(agents, /Typecheck: 未配置/u);
    assert.match(agents, /Test: 未配置/u);
    assert.match(agents, /Eval: 未配置/u);
    assert.doesNotMatch(agents, /`未配置`/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('core project install renders project-specific rules without local memory library', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-project-assets-'));
  try {
    await runCli(['init', '--project', target]);
    await writeJson(path.join(target, 'package.json'), {
      packageManager: 'pnpm@10.33.0',
      scripts: {
        'check:type': 'vue-tsc --noEmit',
        lint: 'oxlint . && oxfmt --check .',
        'logs:api': 'node scripts/read-logs.mjs',
        test: 'vitest run',
      },
      dependencies: { pino: '^9.0.0', vue: '^3.5.0' },
      devDependencies: { vite: '^5.0.0', vitest: '^2.0.0' },
    });

    const report = await runCli(['install', '--project', target, '--target', 'codex', '--profile', 'core', '--dry-run']);
    const targets = report.actions.map((action) => action.relativeTarget);
    const projectRules = report.previewFiles.find((file) => file.target === 'docs/rules/project-specific-rules.md').content;

    assert.equal(targets.includes('docs/rules/project-specific-rules.md'), true);
    assert.equal(targets.includes('docs/rules/codebase-memory-mcp.md'), false);
    assert.equal(targets.includes('.agents/skills/agentmemory/SKILL.md'), false);
    assert.equal(targets.includes('.agents/memory/README.md'), false);
    assert.equal(targets.includes('.agents/memory/observations.md'), false);
    assert.equal(targets.includes('.agents/memory/decisions.md'), false);
    assert.equal(targets.includes('.agents/memory/sessions/README.md'), false);
    assert.equal(targets.includes('.codex/hooks.json'), false);
    assert.match(projectRules, /Vue 3/);
    assert.match(projectRules, /Vite/);
    assert.match(projectRules, /oxlint/);
    assert.match(projectRules, /pnpm lint/);
    assert.match(projectRules, /日志与可观测性/u);
    assert.match(projectRules, /候选证据/u);
    assert.match(projectRules, /项目契约/u);
    assert.match(projectRules, /不自动执行/u);
    assert.match(projectRules, /Pino/u);
    assert.match(projectRules, /pnpm logs:api/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('minimal profile excludes project-specific rules and local memory library', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-project-minimal-assets-'));
  try {
    await runCli(['init', '--project', target]);
    const report = await runCli(['install', '--project', target, '--target', 'codex', '--profile', 'minimal', '--dry-run']);
    const targets = report.actions.map((action) => action.relativeTarget);

    assert.equal(targets.includes('docs/rules/project-specific-rules.md'), false);
    assert.equal(targets.includes('.agents/memory/README.md'), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('explicit memory module can disable or relocate the local memory library', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-memory-config-'));
  try {
    await runCli(['init', '--project', target]);
    const configPath = path.join(target, 'vibe-harness.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));

    await writeJson(configPath, {
      ...config,
      memory: {
        enabled: false,
        path: '.agents/memory',
      },
    });
    const disabled = await runCli(['install', '--project', target, '--target', 'codex', '--profile', 'full', '--modules', 'memory', '--dry-run']);
    assert.equal(disabled.actions.some((action) => action.relativeTarget.startsWith('.agents/memory/')), false);

    await writeJson(configPath, {
      ...config,
      memory: {
        enabled: true,
        path: 'docs/agent-memory',
      },
    });
    const relocated = await runCli(['install', '--project', target, '--target', 'codex', '--profile', 'full', '--modules', 'memory', '--dry-run']);
    const targets = relocated.actions.map((action) => action.relativeTarget);

    assert.equal(targets.includes('docs/agent-memory/README.md'), true);
    assert.equal(targets.includes('.agents/memory/README.md'), false);
    const agents = relocated.previewFiles.find((file) => file.target === 'AGENTS.md').content;
    assert.match(agents, /docs\/agent-memory\//);
    assert.match(agents, /仅当需要恢复项目状态且已获授权时读 Memory body/u);
    assert.match(agents, /限制 Memory 证据边界时，只确认路径存在与元数据，不读正文/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('doctor summarizes unmanaged files by default and shows full list only when verbose', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-doctor-summary-'));
  try {
    await runCli(['init', '--project', target]);
    const configPath = path.join(target, 'vibe-harness.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    await writeJson(configPath, { ...config, profile: 'minimal' });
    await runCli(['install', '--project', target, '--target', 'codex', '--profile', 'minimal', '--write']);
    await writeFile(path.join(target, 'local-a.txt'), 'a\n', 'utf8');
    await writeFile(path.join(target, 'local-b.txt'), 'b\n', 'utf8');

    const report = await runCli(['doctor', '--project', target, '--profile', 'minimal']);
    assert.equal(typeof report.target.summary.unmanagedCount, 'number');
    assert.equal(report.target.summary.unmanagedCount >= 2, true);
    assert.equal(Array.isArray(report.target.summary.samples.unmanaged), true);
    assert.equal(Object.hasOwn(report.target, 'unmanaged'), false);

    const verbose = await runCli(['doctor', '--project', target, '--profile', 'minimal', '--verbose']);
    assert.equal(Array.isArray(verbose.target.unmanaged), true);
    assert.equal(verbose.target.unmanaged.some((item) => item.target === 'local-a.txt'), true);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('detectProjectProfile 从已声明脚本推导三个成本层', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-profile-tiers-node-'));
  try {
    await writeJson(path.join(target, 'package.json'), {
      packageManager: 'pnpm@10.33.0',
      scripts: {
        lint: 'oxlint .',
        'test:unit': 'vitest run',
        'test:integration': 'vitest run --dir tests/integration',
        'test:e2e': 'playwright test',
        build: 'vite build',
      },
    });

    const profile = await detectProjectProfile({ targetDir: target });

    assert.equal(profile.tierSource, 'derived');
    assert.deepEqual(profile.derivedValidationTiers.quick, ['pnpm lint', 'pnpm test:unit']);
    assert.deepEqual(profile.validationTiers, {
      quick: ['pnpm lint', 'pnpm test:unit'],
      standard: ['pnpm test:integration'],
      deep: ['pnpm test:e2e'],
    });
    assert.match(profile.verificationSummary, /快速层：pnpm lint、pnpm test:unit/u);
    assert.match(profile.verificationSummary, /中等层：pnpm test:integration/u);
    assert.match(profile.verificationSummary, /深度层：pnpm test:e2e/u);
    assert.match(profile.tierReasons.quick.join('\n'), /package\.json scripts\.lint/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('detectProjectProfile 区分显式分层配置与空推导', async () => {
  const explicit = await mkdtemp(path.join(tmpdir(), 'vibe-harness-profile-tiers-explicit-'));
  const empty = await mkdtemp(path.join(tmpdir(), 'vibe-harness-profile-tiers-empty-'));
  try {
    await writeJson(path.join(explicit, 'package.json'), {
      packageManager: 'pnpm@10.33.0',
      scripts: { lint: 'oxlint .', 'test:e2e': 'playwright test' },
    });
    await writeJson(path.join(empty, 'package.json'), {
      packageManager: 'pnpm@10.33.0',
      scripts: { build: 'vite build' },
    });

    const explicitProfile = await detectProjectProfile({
      config: {
        validationCommands: {
          lint: null,
          typecheck: null,
          test: null,
          eval: null,
          tiers: { quick: ['pnpm lint'], standard: [], deep: [] },
        },
      },
      targetDir: explicit,
    });
    const emptyProfile = await detectProjectProfile({ targetDir: empty });

    assert.equal(explicitProfile.tierSource, 'explicit');
    assert.deepEqual(explicitProfile.validationTiers, { quick: ['pnpm lint'], standard: [], deep: [] });
    assert.match(explicitProfile.tierReasons.deep[0], /显式配置为空数组/u);

    assert.equal(emptyProfile.tierSource, 'empty');
    assert.deepEqual(emptyProfile.validationTiers, { quick: [], standard: [], deep: [] });
    assert.match(emptyProfile.verificationSummary, /快速层：未配置；中等层：未配置；深度层：未配置/u);
  } finally {
    await rm(explicit, { force: true, recursive: true });
    await rm(empty, { force: true, recursive: true });
  }
});

test('detectProjectProfile 只从固定入口推导 Maven 与 .NET 层', async () => {
  const maven = await mkdtemp(path.join(tmpdir(), 'vibe-harness-profile-tiers-maven-'));
  const dotnet = await mkdtemp(path.join(tmpdir(), 'vibe-harness-profile-tiers-dotnet-'));
  try {
    await writeFile(path.join(maven, 'pom.xml'), '<project />', 'utf8');
    await writeFile(path.join(dotnet, 'Legacy.sln'), 'Microsoft Visual Studio Solution File\n', 'utf8');

    const mavenProfile = await detectProjectProfile({ targetDir: maven });
    const dotnetProfile = await detectProjectProfile({ targetDir: dotnet });

    assert.equal(mavenProfile.tierSource, 'derived');
    assert.deepEqual(mavenProfile.validationTiers.standard, ['mvn test']);
    assert.deepEqual(mavenProfile.validationTiers.deep, ['mvn verify']);

    assert.equal(dotnetProfile.tierSource, 'derived');
    assert.deepEqual(dotnetProfile.validationTiers.standard, ['dotnet test']);
    assert.deepEqual(dotnetProfile.validationTiers.deep, []);
  } finally {
    await rm(maven, { force: true, recursive: true });
    await rm(dotnet, { force: true, recursive: true });
  }
});

test('生成的入口文件渲染三个成本层并标注未配置层', async () => {
  const configured = await mkdtemp(path.join(tmpdir(), 'vibe-harness-profile-tiers-render-'));
  const unconfigured = await mkdtemp(path.join(tmpdir(), 'vibe-harness-profile-tiers-render-empty-'));
  try {
    await writeJson(path.join(configured, 'package.json'), {
      packageManager: 'pnpm@10.33.0',
      scripts: {
        lint: 'oxlint .',
        'test:unit': 'vitest run',
        'test:integration': 'vitest run --dir tests/integration',
        'test:e2e': 'playwright test',
      },
    });
    await writeJson(path.join(unconfigured, 'package.json'), {
      packageManager: 'pnpm@10.33.0',
      scripts: { build: 'vite build' },
    });

    await runCli(['init', '--project', configured]);
    await runCli(['init', '--project', unconfigured]);

    const report = await runCli(['install', '--project', configured, '--target', 'codex', '--profile', 'core', '--dry-run', '--verbose']);
    const agents = report.previewFiles.find((file) => file.target === 'AGENTS.md').content;
    const projectRules = report.previewFiles.find((file) => file.target === 'docs/rules/project-specific-rules.md').content;

    assert.match(agents, /快速层（pnpm lint、pnpm test:unit，失败阻塞当前实施单元）/u);
    assert.match(agents, /中等层 `--tier standard`（pnpm test:integration）/u);
    assert.match(agents, /深度层 `--tier deep`（pnpm test:e2e）/u);
    assert.match(projectRules, /快速层（开发中同步，失败阻塞当前实施单元）：pnpm lint、pnpm test:unit/u);
    assert.match(projectRules, /深度层（异步、夜间、关键 PR 或发布边界，失败阻塞集成与发布）：pnpm test:e2e/u);
    assert.match(projectRules, /vibe-harness verify` 默认只执行快速层；中等层与深度层显式传 `--tier standard\|deep` 升级，`--full` 运行完整矩阵/u);

    const emptyReport = await runCli(['install', '--project', unconfigured, '--target', 'codex', '--profile', 'core', '--dry-run', '--verbose']);
    const emptyAgents = emptyReport.previewFiles.find((file) => file.target === 'AGENTS.md').content;
    const emptyRules = emptyReport.previewFiles.find((file) => file.target === 'docs/rules/project-specific-rules.md').content;
    assert.match(emptyAgents, /快速层（未配置，失败阻塞当前实施单元）/u);
    assert.match(emptyRules, /快速层（开发中同步，失败阻塞当前实施单元）：未配置/u);
  } finally {
    await rm(configured, { force: true, recursive: true });
    await rm(unconfigured, { force: true, recursive: true });
  }
});

test('validate 对缺失的分层配置只提示且不失败', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tier-validate-'));
  try {
    await writeJson(path.join(target, 'package.json'), {
      packageManager: 'pnpm@10.33.0',
      scripts: { lint: 'oxlint .', 'test:unit': 'vitest run', 'test:integration': 'vitest run' },
    });
    await runCli(['init', '--project', target]);
    await runCli(['install', '--project', target, '--target', 'codex', '--profile', 'core', '--write']);

    // A pre-tiers config renders identically because the derived commands equal
    // the ones init persisted, so only the hint changes.
    const configPath = path.join(target, 'vibe-harness.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    delete config.validationCommands.tiers;
    await writeJson(configPath, config);

    const report = await runCli(['validate', '--project', target]);
    assert.equal(report.status, 'ready');
    assert.equal(report.tierSource, 'derived');
    assert.deepEqual(report.validationTiers.quick, ['pnpm lint', 'pnpm test:unit']);
    assert.equal(
      report.warnings.some((warning) => warning.code === 'VALIDATION_TIERS_NOT_CONFIGURED'),
      true,
    );
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('doctor 报告分层来源与各层命令', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tier-doctor-'));
  try {
    await writeJson(path.join(target, 'package.json'), {
      packageManager: 'pnpm@10.33.0',
      scripts: { lint: 'oxlint .', 'test:unit': 'vitest run', 'test:e2e': 'playwright test' },
    });
    await runCli(['init', '--project', target]);
    await runCli(['install', '--project', target, '--target', 'codex', '--profile', 'core', '--write']);

    const report = await runCli(['doctor', '--project', target]);
    assert.equal(report.tierSource, 'explicit');
    assert.deepEqual(report.validationTiers, {
      quick: ['pnpm lint', 'pnpm test:unit'],
      standard: [],
      deep: ['pnpm test:e2e'],
    });
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('四个 adapter 指令模板都渲染三层命令，未配置时统一显示未配置', async () => {
  const templates = ['codex/AGENTS.template.md', 'claude/CLAUDE.template.md', 'gemini/GEMINI.template.md', 'opencode/AGENTS.template.md'];
  const commands = {
    eval: null,
    lint: 'pnpm lint',
    test: 'pnpm test:unit',
    typecheck: 'pnpm typecheck',
  };
  for (const file of templates) {
    const template = await readFile(path.join(rootDir, 'adapters', file), 'utf8');

    const rendered = renderTemplate(template, {
      projectName: 'tier-render',
      validationCommands: {
        ...commands,
        tiers: {
          quick: ['pnpm lint', 'pnpm test:unit'],
          standard: ['pnpm test:integration'],
          deep: ['pnpm test:e2e'],
        },
      },
    });
    assert.match(rendered, /快速层（pnpm lint、pnpm test:unit，失败阻塞当前实施单元）/u, file);
    assert.match(rendered, /中等层 `--tier standard`（pnpm test:integration）/u, file);
    assert.match(rendered, /深度层 `--tier deep`（pnpm test:e2e）/u, file);
    assert.match(rendered, /Eval: 未配置/u, file);

    const empty = renderTemplate(template, { projectName: 'tier-render-empty', validationCommands: commands });
    assert.match(empty, /快速层（未配置，失败阻塞当前实施单元）/u, file);
    assert.match(empty, /中等层 `--tier standard`（未配置）/u, file);
    assert.match(empty, /深度层 `--tier deep`（未配置）/u, file);
  }
});
