import './helpers/offline-tools.js';

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { detectProjectProfile } from '../scripts/lib/project-profile.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '..');
const cliPath = path.join(rootDir, 'scripts/cognis.js');

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
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-profile-node-'));
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
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-profile-package-manager-'));
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
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-profile-mode-'));
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
    assert.equal(off.stackSummary, '未识别到主技术栈；以目标项目现有文件为准。');
    assert.doesNotMatch(off.stackSummary, /Should not appear/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('detectProjectProfile summarizes Maven and legacy dotnet projects', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-profile-mixed-'));
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
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-profile-entry-'));
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
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-project-assets-'));
  try {
    await runCli(['init', '--project', target]);
    await writeJson(path.join(target, 'package.json'), {
      packageManager: 'pnpm@10.33.0',
      scripts: {
        'check:type': 'vue-tsc --noEmit',
        lint: 'oxlint . && oxfmt --check .',
        test: 'vitest run',
      },
      dependencies: { vue: '^3.5.0' },
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
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('minimal profile excludes project-specific rules and local memory library', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-project-minimal-assets-'));
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
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-memory-config-'));
  try {
    await runCli(['init', '--project', target]);
    const configPath = path.join(target, 'cognis.config.json');
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
    assert.match(relocated.previewFiles.find((file) => file.target === 'AGENTS.md').content, /docs\/agent-memory\//);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('doctor summarizes unmanaged files by default and shows full list only when verbose', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-doctor-summary-'));
  try {
    await runCli(['init', '--project', target]);
    const configPath = path.join(target, 'cognis.config.json');
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
