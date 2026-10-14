import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { assertInsideDir, assertSafePathInside, pathExists } from '../manifest.js';
import { resolveOcrEndpoint } from '../ocr-config.js';
import { inspectPlaywrightTool } from '../../../runtime/tools/playwright-cli/run.mjs';
import { projectStateDir } from '../project-layout.js';
import { createToolProvisioningPlan, hasOcrCredentials, phaseRequest } from './environment.js';
import { readToolState } from './tool-state.js';
import { boundedTimeout, createDiagnostic, sanitizeDiagnosticValue } from './subprocess.js';

export function publicFailure(spec, phase, error, targetDir) {
  const output = [error?.message, error?.stderr, error?.stdout].filter(Boolean).join('\n').toLowerCase();
  const code = spec.id === 'openCodeReview' && output.includes('protocol_not_supported')
    ? 'OPEN_CODE_REVIEW_PROTOCOL_UNSUPPORTED'
    : phase === 'dependency-install' && ['eai_again', 'econnrefused', 'econnreset', 'etimedout', 'enetunreach', 'enotfound', 'proxy', 'registry'].some(item => output.includes(item))
      ? 'TOOL_DEPENDENCY_NETWORK_ERROR'
      : typeof error?.code === 'string' && error.code.startsWith('TOOL_') ? error.code : 'TOOL_PROVISION_FAILED';
  const diagnostic = createDiagnostic(Object.assign(new Error(error?.message ?? ''), error, { code }), phase, targetDir);
  return { code, diagnostic: sanitizeDiagnosticValue(diagnostic, targetDir), phase, status: 'degraded', version: spec.version };
}

export function ready(spec, phase = 'ready', details = {}) {
  return { ...details, phase, status: 'ready', version: spec.version };
}

export function withProvisioningMetadata(spec, state, startedAt, { reused = false } = {}) {
  const summaries = {
    degraded: state.diagnostic?.message ?? 'Provisioning failed.',
    pending: 'Provisioning is deferred.',
    'pending-config': 'Provisioning requires additional configuration.',
    ready: reused ? 'Existing compliant tool state reused.' : 'Provisioning completed.',
    unsupported: 'Tool is not available for this platform.',
  };
  return {
    ...state,
    finishedAt: new Date().toISOString(),
    logSummary: summaries[state.status] ?? 'Provisioning state recorded.',
    result: state.status,
    source: spec.source ?? `npm:${spec.packageName}@${spec.version}`,
    startedAt,
  };
}

export async function runToolPhases(spec, commandRunner, env, targetDir, phases = spec.phases, signal, ocrResolution) {
  for (const phase of phases) {
    if (spec.id === 'openCodeReview' && phase === 'llm-test' && !hasOcrCredentials(env)) {
      return {
        ...(ocrResolution?.diagnostic ? { diagnostic: ocrResolution.diagnostic } : {}),
        phase: 'llm-config', status: 'pending-config', version: spec.version,
      };
    }
    try {
      const request = await phaseRequest(spec, phase, targetDir, env);
      await commandRunner({ ...request, signal, timeout: boundedTimeout(env, request.timeout) });
    } catch (error) {
      error.phase = phase;
      throw error;
    }
  }
  return ready(spec);
}

export async function lockFingerprint(spec) {
  const lockPath = path.join(spec.toolDir, 'package-lock.json');
  const fingerprintPath = await pathExists(lockPath) ? lockPath : path.join(spec.toolDir, 'package.json');
  if (!(await pathExists(fingerprintPath))) return null;
  return createHash('sha256').update(await readFile(fingerprintPath)).digest('hex');
}

export async function chromeDevtoolsRuntimeAvailable(spec) {
  return pathExists(path.join(
    spec.toolDir,
    'node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js',
  ));
}

export async function inspectProfileTools(profile, targetDir, resolvedModules, toolIds, { allowPreview = false } = {}) {
  const statePath = path.join(await projectStateDir(targetDir), 'tool-state/tools.json');
  assertInsideDir(targetDir, statePath, 'tool state');
  await assertSafePathInside(targetDir, statePath, 'tool state');
  const state = await readToolState(targetDir);
  const tools = {};
  for (const spec of createToolProvisioningPlan({ allowPreview, profile, resolvedModules, targetDir, toolIds })) {
    await assertSafePathInside(targetDir, spec.toolDir, spec.id + ' tool directory');
    if (spec.id === 'playwrightCli') {
      const inspected = await inspectPlaywrightTool({ targetDir, toolDir: spec.toolDir });
      tools[spec.id] = {
        phase: inspected.status === 'ready' ? 'ready' : 'first-use',
        status: inspected.status === 'unavailable' ? 'degraded' : inspected.status,
        version: spec.version,
      };
    } else {
      tools[spec.id] = state?.tools?.[spec.id] ?? (spec.id === 'openCodeReview' && !(await resolveOcrEndpoint({ env: process.env })).env
        ? { phase: 'llm-config', status: 'pending-config', version: spec.version }
        : { phase: 'install', status: 'pending', version: spec.version });
    }
  }
  return tools;
}

export function toolWarnings(tools) {
  return Object.entries(tools)
    .filter(([, tool]) => tool.status !== 'ready')
    .map(([id, tool]) => ({
      code: `${id.replace(/([a-z])([A-Z])/gu, '$1_$2').toUpperCase()}_${tool.status.replaceAll('-', '_').toUpperCase()}`,
      ...(tool.diagnostic ? { diagnostic: tool.diagnostic } : {}),
      message: tool.diagnostic?.message ?? `${id} is ${tool.status} during ${tool.phase}.`,
      tool: id,
    }));
}
