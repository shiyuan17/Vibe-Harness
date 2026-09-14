import { createMultiTargetInstallPlan, diffMultiTargetInstall } from './install-planner.js';
import { readInstallState } from './install-state.js';
import {
  projectTargets,
  readRequiredProjectConfig,
  resolveValidationCommands,
  validateProfileName,
  validateProjectConfig,
} from './project-config.js';
import { detectProjectProfile } from './project-profile.js';

// The pack repository installs itself to dogfood the installer. Pack-level
// validation only compares individual assets, so drift in the pieces the
// installer *generates* (the managed AGENTS.md block, rendered targets) stays
// invisible until someone runs the project-level command by hand. This runs the
// same conformance diff as `vibe-harness validate --project <repo>` so a stale
// self-installed copy fails the repository gate instead of accumulating.
// `targetDir` is overridable so the check can be pointed at a synthetic
// installation while still planning from the pack under `rootDir`.
export async function checkSelfInstallConformance(rootDir, { targetDir = rootDir } = {}) {
  const installState = await readInstallState(targetDir);
  if (!installState) {
    return { ok: true, reason: 'self-install-state-missing', skipped: true };
  }
  const config = await readRequiredProjectConfig(targetDir);
  validateProjectConfig(config);
  const profile = validateProfileName(config.profile);
  const targets = projectTargets(config);
  const projectProfile = await detectProjectProfile({ config, targetDir });
  const validationCommands = resolveValidationCommands(config, projectProfile);
  const renderData = { ...config, profile, projectProfile, targets, validationCommands };
  const requestedModules = config.modules ?? installState.requestedModules;
  const requestedPlugins = config.plugins ?? installState.requestedPlugins ?? [];
  const rtkHooksEnabled = requestedPlugins.includes('rtk')
    && (Object.hasOwn(config.hooks?.rtk ?? {}, 'enabled')
      ? Boolean(config.hooks.rtk.enabled)
      : Boolean(installState.rtkHooksEnabled));
  const planOptions = {
    allowPreview: true,
    managedAgentsBlock: true,
    profile,
    renderData,
    requestedModules,
    requestedPlugins,
    rootDir,
    rtkHooksEnabled,
    selectedTargets: targets,
    targetDir,
    targets,
  };
  const plan = await createMultiTargetInstallPlan({ ...planOptions, dryRun: true, force: true });
  const report = await diffMultiTargetInstall({ ...planOptions, aggregatePlan: plan });
  const changed = report.changed.map((item) => item.target).sort();
  const missing = report.missing.map((item) => item.target).sort();
  const staleProjections = [...report.staleProjections].sort();
  return {
    changed,
    missing,
    ok: changed.length === 0 && missing.length === 0 && staleProjections.length === 0,
    reason: 'compared',
    resolvedModules: plan.resolvedModules,
    skipped: false,
    staleProjections,
    targets,
    unmanagedCount: report.summary.unmanagedCount,
  };
}
