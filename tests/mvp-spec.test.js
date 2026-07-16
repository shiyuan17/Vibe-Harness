import './helpers/offline-tools.js';

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve('.');
const cliPath = path.join(rootDir, 'scripts/loopengine.js');

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

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

async function initAndDryRunProfile(profile) {
  const target = await mkdtemp(path.join(tmpdir(), `loopengine-${profile}-profile-`));
  await runCli(['init', '--project', target]);
  const report = await runCli([
    'install',
    '--project',
    target,
    '--target',
    'codex',
    '--profile',
    profile,
    '--dry-run',
  ]);
  return { report, target };
}

function targetsFrom(report) {
  return report.actions.map((action) => action.relativeTarget).sort();
}

test('init --project writes the MVP loopengine.config.json defaults', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-init-'));
  try {
    await runCli(['init', '--project', target]);

    const config = JSON.parse(await readFile(path.join(target, 'loopengine.config.json'), 'utf8'));
    assert.equal(config.projectName, path.basename(target));
    assert.equal(config.language, 'zh-CN');
    assert.equal(config.packageManager, 'pnpm');
    assert.equal(config.target, 'codex');
    assert.equal(config.profile, 'core');
    assert.equal(config.validationCommands.governance, 'node .agents/loopengine/governance/validate.mjs');
    assert.equal(config.validationCommands.lint, null);
    assert.equal(config.validationCommands.typecheck, null);
    assert.deepEqual(config.governance, { mode: 'basic' });
    assert.deepEqual(config.crossRepo, { backendRepo: '', enabled: false });
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('MVP dry-run uses --project for path and --target codex for adapter without writing AGENTS.md', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-dryrun-mvp-'));
  try {
    await runCli(['init', '--project', target]);
    const report = await runCli([
      'install',
      '--project',
      target,
      '--target',
      'codex',
      '--profile',
      'minimal',
      '--dry-run',
    ]);

    assert.equal(report.target, 'codex');
    assert.equal(report.profile, 'minimal');
    assert.equal(report.dryRun, true);
    assert.equal(report.targetDir, path.resolve(target));
    assert.equal(report.previewFiles.some((file) => file.target === 'AGENTS.md'), true);
    const agents = report.previewFiles.find((file) => file.target === 'AGENTS.md').content;
    assert.equal(agents.includes(path.basename(target)), true);
    assert.equal(agents.includes('由 LoopEngine 安装'), false);
    assert.equal(agents.includes('本项目使用 LoopEngine 中文治理合同'), false);
    assert.equal(agents.includes('## 启动'), true);
    assert.equal(agents.includes('## 五条硬约束'), true);
    assert.equal(agents.includes('轻量反证'), true);
    assert.equal(await exists(path.join(target, 'AGENTS.md')), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('MVP --write appends or updates the managed AGENTS block without overwriting local content', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-write-mvp-'));
  try {
    await runCli(['init', '--project', target]);
    await writeFile(path.join(target, 'AGENTS.md'), '# Project AGENTS\n\nlocal agents\n', 'utf8');

    const report = await runCli([
      'install',
      '--project',
      target,
      '--target',
      'codex',
      '--profile',
      'core',
      '--write',
    ]);
    const agents = await readFile(path.join(target, 'AGENTS.md'), 'utf8');

    assert.equal(report.written.some((file) => file.endsWith('AGENTS.md')), true);
    assert.equal(agents.includes('# Project AGENTS'), true);
    assert.equal(agents.includes('local agents'), true);
    assert.equal(agents.includes('## 启动'), true);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('MVP repeated --write updates the managed AGENTS block in place', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-write-repeat-mvp-'));
  try {
    await runCli(['init', '--project', target]);
    await writeFile(
      path.join(target, 'AGENTS.md'),
      '# Project AGENTS\n\nlocal agents\n\n<!-- LOOPENGINE:START -->\nold block\n<!-- LOOPENGINE:END -->\n',
      'utf8',
    );

    await runCli([
      'install',
      '--project',
      target,
      '--target',
      'codex',
      '--profile',
      'core',
      '--write',
    ]);

    const agents = await readFile(path.join(target, 'AGENTS.md'), 'utf8');
    assert.equal(agents.includes('old block'), false);
    assert.equal((agents.match(/<!-- LOOPENGINE:START -->/gu) ?? []).length, 1);
    assert.equal((agents.match(/<!-- LOOPENGINE:END -->/gu) ?? []).length, 1);
    assert.equal(agents.includes('local agents'), true);
    assert.equal(agents.includes('## 启动'), true);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('MVP install replaces legacy unmarked LoopEngine AGENTS content with the managed block', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-write-legacy-agents-'));
  try {
    await runCli(['init', '--project', target]);
    await writeFile(
      path.join(target, 'AGENTS.md'),
      [
        '# AGENTS.md',
        '',
        '项目：LegacyProject',
        '',
        '## 最小启动步骤',
        '',
        '1. 阅读 `docs/rules/quickstart.md` 和 `docs/rules/agent-collaboration.md`。',
        '2. 编辑前运行 `git status --short`。',
        '',
        '## 五条红线',
        '',
        '1. 编辑前必须先运行 `git status --short`。',
        '',
        '## 核心位置',
        '',
        '- Workflows 位于 `docs/workflows/`。',
        '',
        'LoopEngine 不覆盖本项目本地规则；如果本地规则更严格，遵循更严格的规则。',
        '',
      ].join('\n'),
      'utf8',
    );

    await runCli([
      'install',
      '--project',
      target,
      '--target',
      'codex',
      '--profile',
      'core',
      '--write',
    ]);

    const agents = await readFile(path.join(target, 'AGENTS.md'), 'utf8');
    assert.equal(agents.includes('## 最小启动步骤'), false);
    assert.equal(agents.includes('## 五条红线'), false);
    assert.equal(agents.includes('docs/rules/quickstart.md'), false);
    assert.equal(agents.includes('docs/workflows/'), false);
    assert.equal((agents.match(/^# AGENTS\.md$/gmu) ?? []).length, 1);
    assert.equal((agents.match(/<!-- LOOPENGINE:START -->/gu) ?? []).length, 1);
    assert.equal((agents.match(/<!-- LOOPENGINE:END -->/gu) ?? []).length, 1);
    assert.equal(agents.includes('## 启动'), true);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('MVP --write --force keeps local AGENTS content and does not require a backup for block updates', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-write-force-mvp-'));
  try {
    await runCli(['init', '--project', target]);
    await writeFile(path.join(target, 'AGENTS.md'), 'local agents\n', 'utf8');

    const report = await runCli([
      'install',
      '--project',
      target,
      '--target',
      'codex',
      '--profile',
      'core',
      '--write',
      '--force',
    ]);

    const agents = await readFile(path.join(target, 'AGENTS.md'), 'utf8');
    assert.equal(report.written.some((file) => file.endsWith('AGENTS.md')), true);
    assert.equal(agents.includes('local agents'), true);
    assert.equal(agents.includes('## 启动'), true);
    assert.equal(agents.includes(path.basename(target)), true);
    assert.equal(await exists(path.join(target, '.loopengine/backups')), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('validate --project rejects invalid config', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-invalid-config-'));
  try {
    await writeFile(
      path.join(target, 'loopengine.config.json'),
      JSON.stringify({ projectName: 'BrokenProject', target: 'codex', profile: 'core' }),
      'utf8',
    );

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'validate', '--project', target]),
      /packageManager is required/i,
    );
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('project installs allow target-specific names in generated output', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-project-name-'));
  try {
    await runCli(['init', '--project', target]);
    const configPath = path.join(target, 'loopengine.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    await writeJson(configPath, { ...config, projectName: 'SYBaseProjectWeb' });

    const report = await runCli(['install', '--project', target, '--target', 'codex', '--profile', 'core', '--dry-run']);
    const agents = report.previewFiles.find((file) => file.target === 'AGENTS.md').content;

    assert.match(agents, /SYBaseProjectWeb/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('minimal profile installs the fallback kernel without skills', async () => {
  const { report, target } = await initAndDryRunProfile('minimal');
  try {
    const targets = targetsFrom(report);
    const agents = report.previewFiles.find((file) => file.target === 'AGENTS.md').content;

    assert.equal(targets.includes('AGENTS.md'), true);
    assert.equal(targets.includes('docs/rules/governance-core.md'), true);
    assert.equal(targets.includes('docs/rules/codebase-memory-mcp.md'), false);
    assert.equal(targets.includes('docs/templates/task.md'), true);
    assert.equal(targets.includes('docs/templates/delivery.md'), true);
    assert.equal(targets.some((item) => item.startsWith('.agents/skills/')), false);
    assert.equal(targets.some((item) => item.startsWith('.agents/memory/')), false);
    assert.equal(targets.includes('.codex/hooks.json'), false);
    assert.equal(targets.some((item) => item.startsWith('docs/workflows/')), false);
    assert.equal(agents.includes('codebase-memory-mcp'), false);
    assert.equal(agents.includes('agentmemory'), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('core profile installs common routed skills without mcp, memory, or hooks', async () => {
  const { report, target } = await initAndDryRunProfile('core');
  try {
    const targets = targetsFrom(report);
    const agents = report.previewFiles.find((file) => file.target === 'AGENTS.md').content;

    assert.equal(targets.includes('docs/rules/governance-core.md'), true);
    assert.equal(targets.includes('docs/rules/codebase-memory-mcp.md'), false);
    assert.equal(targets.includes('.agents/skills/using-loopengine/SKILL.md'), true);
    assert.equal(targets.includes('.agents/skills/agentmemory/SKILL.md'), false);
    assert.equal(targets.some((item) => item.startsWith('.agents/memory/')), false);
    assert.equal(targets.includes('.codex/hooks.json'), false);
    assert.equal(targets.includes('docs/schemas/full-task-control.schema.json'), true);
    assert.equal(targets.some((item) => item.startsWith('docs/workflows/')), false);
    assert.equal(targets.includes('.agents/skills/review-checklist/SKILL.md'), false);
    assert.equal(targets.includes('.agents/skills/loop-planning/SKILL.md'), false);
    assert.equal(targets.includes('.agents/skills/subagent-driven-development/SKILL.md'), false);
    assert.equal(targets.includes('.agents/skills/skill-authoring-check/SKILL.md'), false);
    assert.equal(agents.includes('通用安装'), true);
    assert.equal(agents.includes('codebase-memory-mcp'), false);
    assert.equal(agents.includes('agentmemory'), false);
    assert.equal(agents.includes('.agents/memory/'), false);
    assert.equal(agents.includes('.codex/hooks.json'), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('full profile adds codebase memory, agentmemory, and hooks beyond core', async () => {
  const core = await initAndDryRunProfile('core');
  const full = await initAndDryRunProfile('full');
  try {
    const coreTargets = targetsFrom(core.report);
    const fullTargets = targetsFrom(full.report);
    const fullAgents = full.report.previewFiles.find((file) => file.target === 'AGENTS.md').content;

    assert.equal(fullTargets.length > coreTargets.length, true);
    assert.equal(coreTargets.includes('docs/rules/codebase-memory-mcp.md'), false);
    assert.equal(coreTargets.includes('.agents/skills/agentmemory/SKILL.md'), false);
    assert.equal(coreTargets.some((item) => item.startsWith('.agents/memory/')), false);
    assert.equal(coreTargets.includes('.codex/hooks.json'), false);
    assert.equal(fullTargets.includes('docs/rules/codebase-memory-mcp.md'), true);
    assert.equal(fullTargets.includes('.agents/skills/agentmemory/SKILL.md'), true);
    assert.equal(fullTargets.includes('.agents/skills/agentmemory/references/handoff.md'), true);
    assert.equal(fullTargets.includes('.agents/skills/agentmemory/references/recall.md'), true);
    assert.equal(fullTargets.includes('.agents/skills/agentmemory/references/remember.md'), true);
    assert.equal(fullTargets.includes('.agents/skills/handoff/SKILL.md'), false);
    assert.equal(fullTargets.includes('.agents/memory/README.md'), true);
    assert.equal(fullTargets.includes('.codex/hooks.json'), true);
    assert.equal(fullTargets.includes('.agents/skills/review-checklist/SKILL.md'), false);
    assert.equal(fullTargets.includes('.agents/skills/adversarial-review-packet/SKILL.md'), true);
    assert.equal(fullTargets.includes('.agents/skills/loop-planning/SKILL.md'), true);
    assert.equal(fullTargets.includes('.agents/skills/subagent-driven-development/SKILL.md'), true);
    assert.equal(fullTargets.some((item) => item.startsWith('docs/workflows/')), false);
    assert.equal(fullAgents.includes('全安装'), true);
    assert.equal(fullAgents.includes('codebase-memory-mcp'), true);
    assert.equal(fullAgents.includes('agentmemory'), true);
    assert.equal(fullAgents.includes('.agents/memory/'), true);
    assert.equal(fullAgents.includes('.codex/hooks.json'), true);
  } finally {
    await rm(core.target, { force: true, recursive: true });
    await rm(full.target, { force: true, recursive: true });
  }
});

test('installed rules use Chinese user-visible bullet text', async () => {
  const pencilRules = await readFile(path.join(rootDir, 'rules/pencil-rules.md'), 'utf8');
  const projectDirectoryRules = await readFile(path.join(rootDir, 'rules/project-directory.md'), 'utf8');
  const content = `${pencilRules}\n${projectDirectoryRules}`;

  for (const englishFragment of [
    'Confirm the `.pen` path',
    'Inspect existing layouts',
    'Separate design approval',
    'Define stable dimensions',
    'Cover loading, empty',
    'Keep component names',
    'Do not encode secrets',
    'Put domain behavior',
    'Shared directories contain capabilities',
    'Adapters translate between external',
    'Generated, vendored',
    'New top-level directories',
  ]) {
    assert.equal(content.includes(englishFragment), false, `${englishFragment} should be translated`);
  }
});

test('validate and install require init-generated loopengine.config.json', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-missing-config-'));
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'validate', '--project', target]),
      /loopengine\.config\.json/,
    );
    await assert.rejects(
      execFileAsync(process.execPath, [
        cliPath,
        'install',
        '--project',
        target,
        '--target',
        'codex',
        '--profile',
        'core',
        '--dry-run',
      ]),
      /loopengine\.config\.json/,
    );
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('validate --project requires installed files to match the selected profile', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-project-validate-install-'));
  try {
    await runCli(['init', '--project', target]);

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'validate', '--project', target]),
      /AGENTS\.md|missing/i,
    );

    await runCli(['install', '--project', target, '--target', 'codex', '--profile', 'core', '--write']);
    const valid = await runCli(['validate', '--project', target]);
    assert.equal(valid.ok, true);

    const agentsPath = path.join(target, 'AGENTS.md');
    const agents = await readFile(agentsPath, 'utf8');
    await writeFile(
      agentsPath,
      agents.replace('## 启动', '## 启动（本地改坏）'),
      'utf8',
    );
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'validate', '--project', target]),
      /AGENTS\.md|changed/i,
    );
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('validate --project allows local AGENTS content outside the managed block', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-project-validate-local-agents-'));
  try {
    await runCli(['init', '--project', target]);
    await writeFile(path.join(target, 'AGENTS.md'), '# Local notes\n\nKeep this.\n', 'utf8');
    await runCli(['install', '--project', target, '--target', 'codex', '--profile', 'core', '--write']);

    const agentsPath = path.join(target, 'AGENTS.md');
    const agents = await readFile(agentsPath, 'utf8');
    await writeFile(agentsPath, `${agents}\n## Extra local section\nStill mine.\n`, 'utf8');

    const valid = await runCli(['validate', '--project', target]);
    assert.equal(valid.ok, true);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('CLI failures return structured errors without Node stack traces', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-cli-error-'));
  try {
    const cases = [
      ['validate', '--project', target],
      ['install', '--project', target, '--target', 'claude', '--dry-run'],
      ['install', '--target', target, '--profile', 'full', '--dry-run'],
    ];

    for (const args of cases) {
      await assert.rejects(
        execFileAsync(process.execPath, [cliPath, ...args]),
        (error) => {
          const stderr = String(error.stderr);
          assert.equal(error.code, 1);
          assert.equal(stderr.includes('file:///'), false);
          assert.equal(/\s+at\s+/u.test(stderr), false);
          const payload = JSON.parse(stderr);
          assert.equal(payload.ok, false);
          assert.equal(typeof payload.error.message, 'string');
          assert.equal(typeof payload.error.code, 'string');
          return true;
        },
      );
    }
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('rendered AGENTS surface matches minimal, core, and full profile installs', async () => {
  const minimal = await initAndDryRunProfile('minimal');
  const core = await initAndDryRunProfile('core');
  const full = await initAndDryRunProfile('full');
  try {
    const minimalAgents = minimal.report.previewFiles.find((file) => file.target === 'AGENTS.md').content;
    const coreAgents = core.report.previewFiles.find((file) => file.target === 'AGENTS.md').content;
    const fullAgents = full.report.previewFiles.find((file) => file.target === 'AGENTS.md').content;
    assert.equal(minimalAgents.includes('.agents/skills/'), false);
    assert.equal(minimalAgents.includes('codebase-memory-mcp'), false);
    assert.equal(minimalAgents.includes('agentmemory'), false);
    assert.equal(minimalAgents.includes('docs/rules/skill-routing.md'), false);
    assert.equal(minimalAgents.includes('docs/rules/AGENT_SKILL_ROUTING.md'), true);
    assert.equal(minimalAgents.includes('.codex/hooks.json'), false);
    assert.equal(coreAgents.includes('.agents/skills/'), true);
    assert.equal(coreAgents.includes('通用安装'), true);
    assert.equal(coreAgents.includes('codebase-memory-mcp'), false);
    assert.equal(coreAgents.includes('agentmemory'), false);
    assert.equal(coreAgents.includes('.agents/memory/'), false);
    assert.equal(coreAgents.includes('.codex/hooks.json'), false);
    assert.equal(fullAgents.includes('.agents/skills/'), true);
    assert.equal(fullAgents.includes('全安装'), true);
    assert.equal(fullAgents.includes('codebase-memory-mcp'), true);
    assert.equal(fullAgents.includes('agentmemory'), true);
    assert.equal(fullAgents.includes('.agents/memory/'), true);
    assert.equal(fullAgents.includes('.codex/hooks.json'), true);
    assert.equal(fullAgents.includes('review / loop'), true);
  } finally {
    await rm(minimal.target, { force: true, recursive: true });
    await rm(core.target, { force: true, recursive: true });
    await rm(full.target, { force: true, recursive: true });
  }
});

test('validate --project catches generated AGENTS references that are not installed by the profile', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-mismatched-agents-'));
  try {
    await runCli(['init', '--project', target]);
    await writeFile(
      path.join(target, 'loopengine.config.json'),
      JSON.stringify({
        projectName: path.basename(target),
        language: 'zh-CN',
        packageManager: 'pnpm',
        target: 'codex',
        profile: 'minimal',
        validationCommands: {
          lint: 'pnpm lint',
          typecheck: 'pnpm check:type',
          governance: 'pnpm run check:governance',
        },
        riskZones: {
          red: ['auth'],
          yellow: ['shared components'],
        },
        crossRepo: {
          enabled: false,
          backendRepo: '',
        },
        installedSurface: {
          skillsLine: '- Skills 位于 `.agents/skills/`。',
          hooksLine: '- Codex hook 配置位于 `.codex/hooks.json`。',
        },
      }),
      'utf8',
    );

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'validate', '--project', target]),
      /not installed by profile/i,
    );
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('minimal project example documents the MVP project install path', async () => {
  const readme = await readFile(path.join(rootDir, 'examples/minimal-project/README.md'), 'utf8');
  assert.equal(readme.includes('--project examples/minimal-project --target codex'), true);
  assert.equal(readme.includes('--profile codex-minimal'), false);

  const report = await runCli([
    'install',
    '--project',
    path.join(rootDir, 'examples/minimal-project'),
    '--target',
    'codex',
    '--profile',
    'minimal',
    '--dry-run',
  ]);
  assert.equal(report.dryRun, true);
  assert.equal(report.target, 'codex');
});
