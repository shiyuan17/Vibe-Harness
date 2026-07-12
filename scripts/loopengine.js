#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectValidationCommands } from './lib/command-status.js';
import { inspectGitHooks } from './lib/git-hooks.js';
import { applyRollbackPlan, createRollbackPlan, registerGeneratedFile } from './lib/install-state.js';
import { readJson } from './lib/manifest.js';
import {
  applyInstallPlan,
  createInstallPlan,
  diffTargetInstall,
  inspectTargetInstall,
  previewInstallPlan,
} from './lib/install-planner.js';
import { validatePack } from './lib/pack-validation.js';
import { executeProjectVerification } from './lib/project-verification.js';
import { detectProjectProfile } from './lib/project-profile.js';
import {
  readRequiredProjectConfig,
  resolveGovernanceMode,
  resolveValidationCommands,
  validateConfigAndGeneratedContent,
  validateGovernanceModeForProfile,
  validateProjectConfig,
  writeDefaultProjectConfig,
} from './lib/project-config.js';
import { collectProjectBaselineInputs, createProjectBaseline } from './lib/project-baseline.js';
import { readFile } from 'node:fs/promises';
import {
  createToolProvisioningPlan,
  inspectProfileTools,
  provisionProfileTools,
  toolWarnings,
} from './lib/tool-provisioning.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        index += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

async function init(args) {
  const projectDir = path.resolve(args.project ?? process.cwd());
  const result = await writeDefaultProjectConfig({
    force: Boolean(args.force),
    projectDir,
  });
  console.log(JSON.stringify({
    config: result.config,
    path: result.path,
    written: [result.path],
  }, null, 2));
}

async function install(args) {
  const isMvpMode = Boolean(args.project);
  const writeRequested = Boolean(args.write || args.apply);
  const dryRunRequested = Boolean(args['dry-run']) || !writeRequested;
  if ((args.apply || args.write) && args['dry-run']) {
    throw new Error('Use --write/--apply or --dry-run, not both.');
  }
  if (isMvpMode && args.target && args.target !== 'codex') {
    throw new Error(`Unknown target: ${args.target}`);
  }

  const targetDir = isMvpMode ? path.resolve(args.project) : path.resolve(args.target ?? process.cwd());
  const config = isMvpMode ? await readRequiredProjectConfig(targetDir) : null;
  const profile = args.profile ?? config?.profile ?? 'codex-internal';
  const projectProfile = config ? await detectProjectProfile({ config, targetDir }) : null;
  const governanceMode = config ? resolveGovernanceMode(config, profile) : undefined;
  if (config) validateGovernanceModeForProfile(governanceMode, profile);
  const validationCommands = config
    ? resolveValidationCommands(config, projectProfile, governanceMode)
    : undefined;
  const renderData = config ? {
    ...config,
    profile,
    projectProfile,
    target: args.target ?? config.target,
    governance: { mode: governanceMode },
    validationCommands,
  } : {};
  if (config) {
    validateProjectConfig({ ...config, profile, target: args.target ?? config.target });
  }

  const plan = await createInstallPlan({
    dryRun: dryRunRequested,
    force: Boolean(args.force),
    managedAgentsBlock: isMvpMode,
    profile,
    renderData,
    rootDir,
    targetDir,
    upgrade: Boolean(args.upgrade),
  });
  if (config) {
    const agentsTemplate = await readFile(path.join(rootDir, 'adapters/codex/AGENTS.template.md'), 'utf8');
    const installedTargets = plan.actions.map((action) => action.relativeTarget);
    validateConfigAndGeneratedContent(
      { ...config, profile, target: args.target ?? config.target },
      agentsTemplate,
      { installedTargets },
    );
    validateConfigAndGeneratedContent(plan.renderData, agentsTemplate, { installedTargets });
  }
  plan.redZoneConfirmed = Boolean(args['confirm-red-zone']);
  const result = await applyInstallPlan(plan);
  const previewFiles = plan.dryRun ? await previewInstallPlan(plan) : [];
  const plannedToolActions = createToolProvisioningPlan({ profile, targetDir }).map(({ id, mode, phases, version }) => ({
    id,
    mode,
    phases,
    version,
  }));
  const tools = plan.dryRun
    ? await inspectProfileTools(profile, targetDir)
    : await provisionProfileTools({ mcpConflicts: result.mcpConflicts, profile, targetDir });
  if (!plan.dryRun && plannedToolActions.length > 0) {
    await registerGeneratedFile(targetDir, '.loopengine/tool-state/tools.json');
  }
  console.log(JSON.stringify({
    actions: plan.actions,
    dryRun: plan.dryRun,
    governanceMode,
    plannedToolActions,
    previewFiles,
    profile: plan.profile,
    target: isMvpMode ? (args.target ?? config.target) : undefined,
    targetDir: plan.targetDir,
    tools,
    warnings: toolWarnings(tools),
    retired: result.retired,
    skipped: result.skipped,
    written: result.written,
  }, null, 2));
}

async function validate(args) {
  if (args.project) {
    const targetDir = path.resolve(args.project);
    const config = await readRequiredProjectConfig(targetDir);
    validateProjectConfig(config);
    const projectProfile = await detectProjectProfile({ config, targetDir });
    const governanceMode = resolveGovernanceMode(config, config.profile);
    validateGovernanceModeForProfile(governanceMode, config.profile);
    const validationCommands = resolveValidationCommands(config, projectProfile, governanceMode);
    const plan = await createInstallPlan({
      dryRun: true,
      force: true,
      managedAgentsBlock: true,
      profile: config.profile,
      renderData: { ...config, governance: { mode: governanceMode }, projectProfile, validationCommands },
      rootDir,
      targetDir,
    });
    const agentsTemplate = await readFile(path.join(rootDir, 'adapters/codex/AGENTS.template.md'), 'utf8');
    const installedTargets = plan.actions.map((action) => action.relativeTarget);
    validateConfigAndGeneratedContent({ ...config, governance: { mode: governanceMode }, projectProfile, validationCommands }, agentsTemplate, { installedTargets });
    validateConfigAndGeneratedContent(plan.renderData, agentsTemplate, { installedTargets });
    const target = await inspectTargetInstall({
      managedAgentsBlock: true,
      profile: config.profile,
      renderData: { ...config, governance: { mode: governanceMode }, projectProfile, validationCommands },
      rootDir,
      targetDir,
    });
    if (!target.ok) {
      console.error(JSON.stringify({ ok: false, scope: 'project', targetDir, target }, null, 2));
      process.exitCode = 1;
      return;
    }
    const pack = await validatePack(rootDir);
    if (!pack.ok) {
      console.error(JSON.stringify(pack, null, 2));
      process.exitCode = 1;
      return;
    }
    const commandStatus = await inspectValidationCommands({
      commands: validationCommands,
      targetDir,
    });
    const tools = await inspectProfileTools(config.profile, targetDir);
    console.log(JSON.stringify({
      commandStatus,
      ok: true,
      scope: 'project',
      targetDir,
      tools,
      warnings: toolWarnings(tools),
    }, null, 2));
    return;
  }

  if (args.target) {
    const profile = args.profile ?? 'codex-internal';
    const targetDir = path.resolve(args.target);
    const report = await inspectTargetInstall({
      profile,
      rootDir,
      targetDir,
    });
    const tools = await inspectProfileTools(profile, targetDir);
    report.tools = tools;
    report.warnings = toolWarnings(tools);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) {
      process.exitCode = 1;
    }
    return;
  }

  const report = await validatePack(rootDir);
  if (!report.ok) {
    console.error(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ ok: true, scope: 'pack' }, null, 2));
}

async function verify(args) {
  if (!args.project) throw new Error('verify requires --project <path>.');
  const targetDir = path.resolve(args.project);
  const config = await readRequiredProjectConfig(targetDir);
  validateProjectConfig(config);
  const projectProfile = await detectProjectProfile({ config, targetDir });
  const governanceMode = resolveGovernanceMode(config, config.profile);
  validateGovernanceModeForProfile(governanceMode, config.profile);
  const validationCommands = resolveValidationCommands(config, projectProfile, governanceMode);
  const renderData = { ...config, governance: { mode: governanceMode }, projectProfile, validationCommands };
  const target = await inspectTargetInstall({
    managedAgentsBlock: true,
    profile: config.profile,
    renderData,
    rootDir,
    targetDir,
  });
  if (!target.ok) {
    const error = new Error('Project installation is not consistent; run loopengine validate --project first.');
    error.code = 'PROJECT_VERIFICATION_FAILED';
    throw error;
  }
  const pack = await validatePack(rootDir);
  if (!pack.ok) {
    const error = new Error('LoopEngine pack validation failed.');
    error.code = 'PROJECT_VERIFICATION_FAILED';
    throw error;
  }
  const commandStatus = await inspectValidationCommands({ commands: validationCommands, targetDir });
  const results = await executeProjectVerification({
    allowManual: Boolean(args['allow-manual']),
    commandStatus,
    targetDir,
  });
  console.log(JSON.stringify({ ok: true, results, scope: 'project', targetDir }, null, 2));
}

async function baseline(args) {
  if (!args.project) throw Object.assign(new Error('baseline requires --project <path>.'), { code: 'BASELINE_PROJECT_REQUIRED' });
  if (args.target) throw Object.assign(new Error('baseline supports MVP --project only; legacy --target is not supported.'), { code: 'BASELINE_PROJECT_REQUIRED' });
  if (args.apply) throw new Error('baseline uses --write, not legacy --apply.');
  if (args.write && args['dry-run']) throw new Error('Use --write or --dry-run, not both.');
  const allowedOptions = new Set(['_', 'dry-run', 'force', 'project', 'verify', 'write']);
  const unknownOption = Object.keys(args).find((key) => !allowedOptions.has(key));
  if (unknownOption) throw new Error(`Unknown baseline option: --${unknownOption}`);
  const targetDir = path.resolve(args.project);
  let config;
  try {
    config = await readRequiredProjectConfig(targetDir);
  } catch (cause) {
    throw Object.assign(new Error('Project configuration is missing or invalid; run loopengine init before baseline.'), {
      cause,
      code: 'BASELINE_INSTALL_INVALID',
    });
  }
  try {
    validateProjectConfig(config);
  } catch (cause) {
    throw Object.assign(new Error('Project configuration is invalid; fix loopengine.config.json before baseline.'), {
      cause,
      code: 'BASELINE_INSTALL_INVALID',
    });
  }
  const projectProfile = await detectProjectProfile({ config, targetDir });
  const governanceMode = resolveGovernanceMode(config, config.profile);
  validateGovernanceModeForProfile(governanceMode, config.profile);
  const validationCommands = resolveValidationCommands(config, projectProfile, governanceMode);
  const renderData = { ...config, governance: { mode: governanceMode }, projectProfile, validationCommands };
  const target = await inspectTargetInstall({
    managedAgentsBlock: true,
    profile: config.profile,
    renderData,
    rootDir,
    targetDir,
  });
  const inputs = await collectProjectBaselineInputs({
    config,
    governanceMode,
    projectProfile,
    target,
    targetDir,
    validationCommands,
  });
  const result = await createProjectBaseline({
    ...inputs,
    baselineSchema: await readJson(path.join(rootDir, 'schemas/project-baseline.schema.json')),
    config,
    force: Boolean(args.force),
    governanceMode,
    projectProfile,
    target,
    targetDir,
    verify: Boolean(args.verify),
    write: Boolean(args.write),
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

function toolRecommendations(tools, profile) {
  const retryCommand = `loopengine install --target <target> --profile ${profile} --apply --confirm-red-zone`;
  return Object.entries(tools).flatMap(([tool, state]) => {
    if (state.status === 'degraded') {
      return [{
        action: 'retry-provision',
        code: state.code,
        command: retryCommand,
        message: `Retry ${tool} provisioning after checking network access and the reported phase.`,
        phase: state.phase,
        tool,
      }];
    }
    if (state.status === 'pending-config') {
      return [{
        action: 'configure-credentials',
        command: retryCommand,
        message: `Configure a supported ${tool} credential in the environment, then retry provisioning.`,
        phase: state.phase,
        tool,
      }];
    }
    return [];
  });
}

async function doctor(args) {
  const targetDir = path.resolve(args.target ?? process.cwd());
  const profile = args.profile ?? 'codex-internal';
  const [pack, gitHooks] = await Promise.all([
    validatePack(rootDir),
    inspectGitHooks(targetDir),
  ]);
  const target = args.target
    ? await inspectTargetInstall({ profile, rootDir, targetDir })
    : null;
  const tools = args.target ? await inspectProfileTools(profile, targetDir) : {};
  if (target && !args.verbose) {
    delete target.unmanaged;
  }
  console.log(JSON.stringify({
    gitHooks,
    pack,
    rootDir,
    target,
    targetDir,
    tools,
    recommendations: toolRecommendations(tools, profile),
    warnings: toolWarnings(tools),
  }, null, 2));
}

async function diff(args) {
  const report = await diffTargetInstall({
    profile: args.profile ?? 'codex-internal',
    rootDir,
    targetDir: path.resolve(args.target ?? process.cwd()),
  });
  console.log(JSON.stringify(report, null, 2));
}

async function rollback(args) {
  if (args.apply && args['dry-run']) {
    throw new Error('Use either --apply or --dry-run, not both.');
  }
  const plan = await createRollbackPlan({
    dryRun: !args.apply,
    redZoneConfirmed: Boolean(args['confirm-red-zone']),
    targetDir: path.resolve(args.target ?? process.cwd()),
  });
  const result = await applyRollbackPlan(plan);
  console.log(JSON.stringify({ actions: plan.actions, applied: result.applied, dryRun: plan.dryRun, skipped: result.skipped }, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? 'help';
  if (command === 'init') {
    await init(args);
  } else if (command === 'install') {
    await install(args);
  } else if (command === 'validate') {
    await validate(args);
  } else if (command === 'verify') {
    await verify(args);
  } else if (command === 'baseline') {
    await baseline(args);
  } else if (command === 'doctor') {
    await doctor(args);
  } else if (command === 'diff') {
    await diff(args);
  } else if (command === 'rollback') {
    await rollback(args);
  } else {
    console.log('Usage: loopengine <init|install|validate|verify|baseline|doctor|diff|rollback> [--project path] [--target codex|path] [--profile minimal|core|full] [--write|--apply] [--dry-run] [--verify] [--force] [--upgrade] [--confirm-red-zone] [--allow-manual]');
    console.log('MVP install uses --project <path> --target codex. Legacy install uses --target <path>. Install defaults to dry-run.');
  }
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: {
      code: error.code ?? 'LOOPENGINE_ERROR',
      message: error.message,
    },
  }, null, 2));
  process.exitCode = 1;
}
