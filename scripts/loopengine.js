#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectValidationCommands } from './lib/command-status.js';
import { applyRollbackPlan, createRollbackPlan } from './lib/install-state.js';
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
import { readFile } from 'node:fs/promises';

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
  console.log(JSON.stringify({
    actions: plan.actions,
    dryRun: plan.dryRun,
    governanceMode,
    previewFiles,
    profile: plan.profile,
    target: isMvpMode ? (args.target ?? config.target) : undefined,
    targetDir: plan.targetDir,
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
    console.log(JSON.stringify({ commandStatus, ok: true, scope: 'project', targetDir }, null, 2));
    return;
  }

  if (args.target) {
    const report = await inspectTargetInstall({
      profile: args.profile ?? 'codex-internal',
      rootDir,
      targetDir: path.resolve(args.target),
    });
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

async function doctor(args) {
  const targetDir = path.resolve(args.target ?? process.cwd());
  const pack = await validatePack(rootDir);
  const target = args.target
    ? await inspectTargetInstall({ profile: args.profile ?? 'codex-internal', rootDir, targetDir })
    : null;
  if (target && !args.verbose) {
    delete target.unmanaged;
  }
  console.log(JSON.stringify({ pack, rootDir, target, targetDir }, null, 2));
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
  } else if (command === 'doctor') {
    await doctor(args);
  } else if (command === 'diff') {
    await diff(args);
  } else if (command === 'rollback') {
    await rollback(args);
  } else {
    console.log('Usage: loopengine <init|install|validate|verify|doctor|diff|rollback> [--project path] [--target codex|path] [--profile minimal|core|full] [--write|--apply] [--dry-run] [--force] [--upgrade] [--confirm-red-zone] [--allow-manual]');
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
