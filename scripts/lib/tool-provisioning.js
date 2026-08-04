import { mkdir } from 'node:fs/promises';

import { assertSafePathInside } from './manifest.js';
import { resolveOcrEndpoint } from './ocr-config.js';
import { preparePlaywrightTool } from '../../runtime/tools/playwright-cli/run.mjs';
import { resolveRtkAsset } from '../../runtime/tools/rtk/run.mjs';
import { readProductEnv } from './product-identity.js';

import { createToolProvisioningPlan, componentEnvironment, hasOcrCredentials } from './tool-provisioning/environment.js';
import { inspectProvisioningMarker, readToolState, removeProvisioningMarker, writeProvisioningMarker, writeToolState } from './tool-provisioning/tool-state.js';
import { boundedTimeout, defaultCommandRunner, defaultPhaseRunner, runMcpHandshake, runToolCommand } from './tool-provisioning/subprocess.js';
import {
  chromeDevtoolsRuntimeAvailable,
  codebaseMemoryRuntimeAvailable,
  defaultRuntimeVersionRunner,
  inspectProfileTools,
  lockFingerprint,
  publicFailure,
  ready,
  repairCodebaseMemoryBinary,
  reusableOptionalRuntime,
  runToolPhases,
  toolWarnings,
  verifyProvisionedOptionalRuntime,
  withOptionalToolIdentity,
  withProvisioningMetadata,
} from './tool-provisioning/runtime-probe.js';
import {
  extractManagedCbmIgnoreBlock,
  extractManagedMcpBlock,
  mergeManagedCbmIgnoreBlock,
  mergeManagedMcpBlock,
  removeManagedCbmIgnoreBlock,
  removeManagedMcpBlock,
} from './tool-provisioning/managed-blocks.js';

export {
  extractManagedMcpBlock,
  removeManagedMcpBlock,
  mergeManagedMcpBlock,
  extractManagedCbmIgnoreBlock,
  removeManagedCbmIgnoreBlock,
  mergeManagedCbmIgnoreBlock,
  createToolProvisioningPlan,
  runToolCommand,
  runMcpHandshake,
  repairCodebaseMemoryBinary,
  inspectProvisioningMarker,
  inspectProfileTools,
  toolWarnings,
};

export async function provisionProfileTools({ allowPreview = false, arch = process.arch, codebaseMemoryRepair = repairCodebaseMemoryBinary, commandRunner, env = process.env, force = false, mcpConflicts = [], ocrHomeDir, platform = process.platform, profile, resolvedModules, runtimeVersionRunner = defaultRuntimeVersionRunner, signal, targetDir, toolIds }) {
  const ctx = await buildProvisionContext({
    allowPreview, env, ocrHomeDir, profile, resolvedModules, targetDir, toolIds, commandRunner,
  });
  const { marker, plan } = ctx;
  let currentTool = null;
  await writeProvisioningMarker(targetDir, marker);
  try {
    const previous = await readToolState(targetDir);
    const tools = {};
    const fingerprints = {};
    for (const spec of plan) {
      currentTool = spec.id;
      await writeProvisioningMarker(targetDir, {
        ...marker,
        currentTool,
        updatedAt: new Date().toISOString(),
      });
      const startedAt = new Date().toISOString();
      if (signal?.aborted) throw Object.assign(new Error('Tool provisioning was cancelled.'), { code: 'TOOL_CANCELLED' });
      await assertSafePathInside(targetDir, spec.toolDir, `${spec.id} tool directory`);
      await provisionSingleTool(spec, {
        arch, codebaseMemoryRepair, ctx, env, fingerprints, force, mcpConflicts,
        ocrResolution: ctx.ocrResolution,
        platform, previous, provisionEnv: ctx.provisionEnv, runtimeVersionRunner, signal, startedAt, targetDir, tools,
      });
    }
    for (const spec of plan) {
      if (tools[spec.id]) tools[spec.id] = withOptionalToolIdentity(spec, tools[spec.id], platform, arch);
    }
    applyMcpConflictDegradation(tools, mcpConflicts);
    const persistedTools = toolIds?.length ? { ...(previous?.tools ?? {}), ...tools } : tools;
    const persistedFingerprints = toolIds?.length ? { ...(previous?.fingerprints ?? {}), ...fingerprints } : fingerprints;
    await writeToolState(targetDir, persistedTools, persistedFingerprints);
    await removeProvisioningMarker(targetDir);
    return tools;
  } catch (error) {
    await writeProvisioningMarker(targetDir, {
      ...marker,
      code: signal?.aborted || error.code === 'TOOL_CANCELLED' ? 'TOOL_CANCELLED' : 'PROVISIONING_INTERRUPTED',
      currentTool,
      finishedAt: new Date().toISOString(),
      status: signal?.aborted || error.code === 'TOOL_CANCELLED' ? 'interrupted' : 'failed',
    });
    throw error;
  }
}

async function buildProvisionContext({ allowPreview, env, ocrHomeDir, profile, resolvedModules, targetDir, toolIds, commandRunner }) {
  const plan = createToolProvisioningPlan({ allowPreview, profile, resolvedModules, targetDir, toolIds });
  const ocrResolution = await resolveOcrEndpoint({ env, homeDir: ocrHomeDir });
  const provisionEnv = { ...env, ...(ocrResolution.env ?? {}) };
  const effectiveCommandRunner = commandRunner ?? (readProductEnv(env, 'TEST_OFFLINE').value === '1'
    ? async () => { throw Object.assign(new Error('Offline test fixture.'), { code: 'TOOL_TEST_OFFLINE' }); }
    : null);
  const provisioningStartedAt = new Date().toISOString();
  const marker = {
    parentPid: process.pid,
    startedAt: provisioningStartedAt,
    status: 'active',
    tools: plan.map((spec) => spec.id),
  };
  return { effectiveCommandRunner, marker, ocrResolution, plan, provisionEnv, provisioningStartedAt };
}

async function provisionSingleTool(spec, {
  arch, codebaseMemoryRepair, ctx, env, fingerprints, force, mcpConflicts, ocrResolution, platform, previous, provisionEnv,
  runtimeVersionRunner, signal, startedAt, targetDir, tools,
}) {
  if (spec.mode === 'lazy') {
    tools[spec.id] = withProvisioningMetadata(
      spec,
      { phase: 'first-use', status: 'pending', version: spec.version },
      startedAt,
    );
    return;
  }
  if (spec.id === 'rtk') {
    try {
      resolveRtkAsset({ platform, arch });
    } catch (error) {
      tools[spec.id] = withProvisioningMetadata(
        spec,
        publicFailure(spec, 'binary-install', error, targetDir),
        startedAt,
      );
      return;
    }
  }
  await mkdir(spec.toolDir, { recursive: true });
  const fingerprint = await lockFingerprint(spec);
  fingerprints[spec.id] = fingerprint;
  const { phases, reusable } = await evaluateToolReusability(spec, {
    env, force, mcpConflicts, platform, arch, previous, provisionEnv, fingerprint,
  });
  if (reusable && !['chromeDevtoolsMcp', 'codebaseMemoryMcp'].includes(spec.id)) {
    tools[spec.id] = withProvisioningMetadata(spec, previous?.tools?.[spec.id], startedAt, { reused: true });
    return;
  }
  try {
    if (ctx.effectiveCommandRunner) {
      tools[spec.id] = await runToolPhases(
        spec,
        ctx.effectiveCommandRunner,
        provisionEnv,
        targetDir,
        phases,
        signal,
        ocrResolution,
        codebaseMemoryRepair,
      );
    } else if (spec.id === 'playwrightCli') {
      const runCommand = async (command, args, options) => defaultCommandRunner({
        args,
        command,
        cwd: options.cwd,
        env: options.env,
        signal,
        timeout: boundedTimeout(env, 600_000),
      });
      const result = await preparePlaywrightTool({
        env: componentEnvironment(spec, targetDir, provisionEnv),
        runCommand,
        targetDir,
        toolDir: spec.toolDir,
      });
      tools[spec.id] = result.status === 'ready' ? ready(spec) : { phase: 'browser-install', status: 'degraded', version: spec.version };
    } else {
      tools[spec.id] = await runToolPhases(
        spec,
        defaultPhaseRunner,
        provisionEnv,
        targetDir,
        phases,
        signal,
        ocrResolution,
        codebaseMemoryRepair,
      );
    }
  } catch (error) {
    if (signal?.aborted || error.code === 'TOOL_CANCELLED') throw error;
    const phase = spec.phases.find((item) => item === error?.phase) ?? 'provision';
    tools[spec.id] = publicFailure(spec, phase, error, targetDir);
  }
  if (tools[spec.id].status === 'ready' && ['rtk', 'astGrep'].includes(spec.id)) {
    try {
      tools[spec.id] = {
        ...tools[spec.id],
        binarySha256: await verifyProvisionedOptionalRuntime(
          spec,
          targetDir,
          { arch, env: provisionEnv, platform, runtimeVersionRunner },
        ),
      };
    } catch (error) {
      tools[spec.id] = publicFailure(spec, 'version-check', error, targetDir);
    }
  }
  tools[spec.id] = withProvisioningMetadata(spec, tools[spec.id], startedAt);
}

async function evaluateToolReusability(spec, {
  env, force, mcpConflicts = [], platform, arch, previous, provisionEnv, fingerprint,
}) {
  const previousTool = previous?.tools?.[spec.id];
  const reusableStatus = previousTool?.status === 'ready'
    || (spec.id === 'openCodeReview' && previousTool?.status === 'pending-config' && !hasOcrCredentials(provisionEnv));
  const reusableRuntime = spec.id === 'codebaseMemoryMcp'
    ? await codebaseMemoryRuntimeAvailable(spec)
    : spec.id === 'chromeDevtoolsMcp'
      ? await chromeDevtoolsRuntimeAvailable(spec)
      : spec.id === 'astGrep'
        ? await reusableOptionalRuntime(spec, previousTool, platform, arch)
        : spec.id === 'rtk'
          ? await reusableOptionalRuntime(spec, previousTool, platform, arch)
          : true;
  const mcpServerName = {
    chromeDevtoolsMcp: 'chrome-devtools',
    codebaseMemoryMcp: 'codebase-memory-mcp',
  }[spec.id];
  const reusable = (
    !force
    && fingerprint
    && previous?.fingerprints?.[spec.id] === fingerprint
    && reusableStatus
    && reusableRuntime
    && !mcpConflicts.includes(mcpServerName ?? spec.id)
  );
  const phases = reusable
    ? spec.phases.filter((phase) => !['dependency-install', 'binary-install'].includes(phase))
    : spec.phases;
  return { phases, reusable };
}

function applyMcpConflictDegradation(tools, mcpConflicts) {
  const conflictIds = {
    'chrome-devtools': 'chromeDevtoolsMcp',
    'codebase-memory-mcp': 'codebaseMemoryMcp',
  };
  for (const conflict of mcpConflicts) {
    const id = conflictIds[conflict];
    if (id && tools[id]) {
      tools[id] = {
        ...tools[id],
        code: 'MCP_CONFIG_CONFLICT',
        diagnostic: {
          code: 'MCP_CONFIG_CONFLICT',
          message: `An unmanaged MCP server already uses the ${conflict} name.`,
          phase: 'mcp-config',
          truncated: false,
        },
        phase: 'mcp-config',
        result: 'degraded',
        status: 'degraded',
        logSummary: `An unmanaged MCP server already uses the ${conflict} name.`,
      };
    }
  }
}
