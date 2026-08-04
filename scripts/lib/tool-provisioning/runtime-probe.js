import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { assertInsideDir, assertSafePathInside, pathExists } from '../manifest.js';
import { resolveOcrEndpoint } from '../ocr-config.js';
import { inspectPlaywrightTool } from '../../../runtime/tools/playwright-cli/run.mjs';
import { resolveRtkAsset } from '../../../runtime/tools/rtk/run.mjs';
import { projectStateDir } from '../project-layout.js';

import { allowedEnvironment, createToolProvisioningPlan, hasOcrCredentials, phaseRequest } from './environment.js';
import { readToolState } from './tool-state.js';
import { boundedTimeout, createDiagnostic, execFileAsync, maxDiagnosticOutput } from './subprocess.js';

const codebaseMemoryWindowsBinaryHashes = new Map([
  ['0.9.0', '9a205fa5ae759fbc866bfe1554f0c05a303be9ae6e0a00f94d875dc0c25e0680'],
]);

function diagnosticCode(error) {
  const output = `${error?.message ?? ''}\n${error?.stderr ?? ''}\n${error?.stdout ?? ''}`;
  if (/repo_path\s+is\s+outside\s+the\s+allowed\s+root/iu.test(output)) return 'INDEX_PATH_OUTSIDE_ALLOWED_ROOT';
  if (/(?:index|database|graph).*(?:corrupt|invalid)|corrupt.*(?:index|database|graph)|需要重新索引/iu.test(output)) {
    return 'INDEX_CORRUPT_REINDEX_REQUIRED';
  }
  return typeof error?.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code)
    ? error.code
    : 'TOOL_PROVISION_FAILED';
}

export function publicFailure(spec, phase, error, targetDir) {
  const code = diagnosticCode(error);
  const diagnosticError = Object.assign(new Error(error?.message ?? ''), error, { code });
  return {
    code,
    diagnostic: createDiagnostic(diagnosticError, phase, targetDir),
    phase,
    status: code === 'RTK_UNSUPPORTED_PLATFORM' ? 'unsupported' : 'degraded',
    version: spec.version,
  };
}

export function ready(spec, phase = 'ready', details = {}) {
  return { ...details, phase, status: 'ready', version: spec.version };
}

function toolContractError(code, message) {
  return Object.assign(new Error(message), { code });
}

function parseCommandJson(output, code, message) {
  const line = String(output?.stdout ?? '')
    .split(/\r?\n/gu)
    .map((item) => item.trim())
    .findLast((item) => item.startsWith('{'));
  if (!line) throw toolContractError(code, message);
  try {
    return JSON.parse(line);
  } catch {
    throw toolContractError(code, message);
  }
}

function normalizedProjectPath(value) {
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function validateIndexResult(output) {
  const result = parseCommandJson(output, 'INDEX_OUTPUT_INVALID', 'Index command did not return valid JSON.');
  const hint = typeof result.hint === 'string' ? result.hint : '';
  if (/(?:integrity|database).*(?:corrupt|failed)|corrupt.*(?:index|database)|重新索引|re-?run.*index/iu.test(hint)) {
    throw toolContractError('INDEX_CORRUPT_REINDEX_REQUIRED', 'Index database is corrupt; re-index is required.');
  }
  if (result.status !== 'indexed' || typeof result.project !== 'string' || !result.project.trim()) {
    throw toolContractError('INDEX_RESULT_INVALID', 'Index command did not confirm an indexed project.');
  }
  return result.project;
}

function validateIndexStatus(output, targetDir) {
  const result = parseCommandJson(output, 'INDEX_OUTPUT_INVALID', 'Index verification did not return valid JSON.');
  if (result.status !== 'ready') {
    throw toolContractError('INDEX_NOT_READY', 'Indexed project is not ready.');
  }
  if (typeof result.root_path !== 'string'
    || normalizedProjectPath(result.root_path) !== normalizedProjectPath(targetDir)) {
    throw toolContractError('INDEX_ROOT_MISMATCH', 'Indexed project root does not match the target project.');
  }
  if (!Number.isInteger(result.nodes) || result.nodes < 0
    || !Number.isInteger(result.edges) || result.edges < 0) {
    throw toolContractError('INDEX_STATUS_INVALID', 'Index verification did not return valid graph counts.');
  }
  return {
    edges: result.edges,
    mode: 'moderate',
    nodes: result.nodes,
    status: 'ready',
  };
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

export function withOptionalToolIdentity(spec, state, platform, arch) {
  if (!['rtk', 'astGrep'].includes(spec.id)) return state;
  return {
    ...state,
    platform: `${platform}-${arch}`,
    source: state.source ?? spec.source ?? `npm:${spec.packageName}@${spec.version}`,
  };
}

export async function runToolPhases(
  spec,
  commandRunner,
  env,
  targetDir,
  phases = spec.phases,
  signal,
  ocrResolution,
  codebaseMemoryRepair = repairCodebaseMemoryBinary,
) {
  const context = {};
  const retriedCorruptIndex = new Set();
  for (const phase of phases) {
    if (spec.id === 'openCodeReview' && phase === 'llm-test' && !hasOcrCredentials(env)) {
      return {
        ...(ocrResolution?.diagnostic ? { diagnostic: ocrResolution.diagnostic } : {}),
        phase: 'llm-config',
        status: 'pending-config',
        version: spec.version,
      };
    }
    try {
      const request = await phaseRequest(spec, phase, targetDir, env, context);
      request.signal = signal;
      request.timeout = boundedTimeout(env, request.timeout);
      const output = await commandRunner(request);
      if (spec.id === 'codebaseMemoryMcp'
        && phase === 'binary-install'
        && !(await codebaseMemoryRuntimeAvailable(spec))
        && !(await codebaseMemoryRepair(spec))) {
        throw toolContractError(
          'BINARY_INSTALL_INCOMPLETE',
          'codebase-memory-mcp binary install completed without a usable runtime.',
        );
      }
      if (phase === 'index') context.indexProject = validateIndexResult(output);
      if (phase === 'index-verify') context.index = validateIndexStatus(output, targetDir);
    } catch (error) {
      if (spec.id === 'codebaseMemoryMcp'
        && phase === 'binary-install'
        && /(?:binary\s+not\s+found|download\s+failed|install\s+failed)/iu.test(`${error?.message ?? ''}\n${error?.stderr ?? ''}`)
        && await codebaseMemoryRepair(spec)) {
        continue;
      }
      if (spec.id === 'codebaseMemoryMcp'
        && phase === 'index'
        && /(?:binary\s+not\s+found|download\s+failed|install\s+failed)/iu.test(`${error?.message ?? ''}\n${error?.stderr ?? ''}`)
        && await codebaseMemoryRepair(spec)) {
        const retryRequest = await phaseRequest(spec, phase, targetDir, env, context);
        retryRequest.signal = signal;
        retryRequest.timeout = boundedTimeout(env, retryRequest.timeout);
        const retryOutput = await commandRunner(retryRequest);
        context.indexProject = validateIndexResult(retryOutput);
        continue;
      }
      if (spec.id === 'codebaseMemoryMcp'
        && phase === 'index'
        && diagnosticCode(error) === 'INDEX_CORRUPT_REINDEX_REQUIRED'
        && !retriedCorruptIndex.has(phase)) {
        retriedCorruptIndex.add(phase);
        const cacheDir = path.join(await projectStateDir(targetDir), 'tool-state/codebase-memory-mcp/cache');
        await assertSafePathInside(targetDir, cacheDir, 'codebase-memory cache');
        await rm(cacheDir, { force: true, recursive: true });
        const projectIndexDir = path.join(targetDir, '.codebase-memory');
        await assertSafePathInside(targetDir, projectIndexDir, 'codebase-memory project index');
        await rm(projectIndexDir, { force: true, recursive: true });
        context.codebaseMemoryCacheDir = cacheDir;
        const retryRequest = await phaseRequest(spec, phase, targetDir, env, context);
        retryRequest.signal = signal;
        retryRequest.timeout = boundedTimeout(env, retryRequest.timeout);
        try {
          const retryOutput = await commandRunner(retryRequest);
          context.indexProject = validateIndexResult(retryOutput);
          continue;
        } catch (retryError) {
          error = retryError;
        }
      }
      error.phase = phase;
      throw error;
    }
  }
  return ready(spec, 'ready', context.index ? { index: context.index } : {});
}

export async function lockFingerprint(spec) {
  const lockPath = path.join(spec.toolDir, 'package-lock.json');
  const fingerprintPath = await pathExists(lockPath) ? lockPath : path.join(spec.toolDir, 'package.json');
  if (!(await pathExists(fingerprintPath))) return null;
  return createHash('sha256').update(await readFile(fingerprintPath)).digest('hex');
}

async function codebaseMemoryRuntimeAvailable(spec) {
  const packageDir = path.join(spec.toolDir, 'node_modules/codebase-memory-mcp');
  const binary = process.platform === 'win32' ? 'codebase-memory-mcp.exe' : 'codebase-memory-mcp';
  return await pathExists(path.join(packageDir, 'bin.js'))
    && await pathExists(path.join(packageDir, 'bin', binary));
}

export async function chromeDevtoolsRuntimeAvailable(spec) {
  return pathExists(path.join(
    spec.toolDir,
    'node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js',
  ));
}

function astGrepBinaryPath(spec, platform = process.platform) {
  const binaryName = platform === 'win32' ? 'ast-grep.exe' : 'ast-grep';
  return path.join(spec.toolDir, 'node_modules/@ast-grep/cli', binaryName);
}

async function astGrepRuntimeAvailable(spec, platform = process.platform) {
  return pathExists(astGrepBinaryPath(spec, platform));
}

function rtkBinaryPath(spec, platform = process.platform) {
  const binaryName = platform === 'win32' ? 'rtk.exe' : 'rtk';
  return path.join(spec.toolDir, 'bin', binaryName);
}

async function rtkRuntimeAvailable(spec, platform = process.platform, arch = process.arch) {
  try {
    resolveRtkAsset({ platform, arch });
  } catch {
    return false;
  }
  return pathExists(rtkBinaryPath(spec, platform));
}

async function optionalRuntimeHash(spec, platform = process.platform) {
  const binary = spec.id === 'rtk' ? rtkBinaryPath(spec, platform) : astGrepBinaryPath(spec, platform);
  await assertSafePathInside(spec.toolDir, binary, `${spec.id} runtime binary`);
  if (!(await pathExists(binary))) return null;
  return createHash('sha256').update(await readFile(binary)).digest('hex');
}

export async function reusableOptionalRuntime(spec, previousTool, platform, arch) {
  if (previousTool?.version !== spec.version || !previousTool?.binarySha256) return false;
  if (spec.id === 'rtk' && !(await rtkRuntimeAvailable(spec, platform, arch))) return false;
  if (spec.id === 'astGrep' && !(await astGrepRuntimeAvailable(spec, platform))) return false;
  return await optionalRuntimeHash(spec, platform) === previousTool.binarySha256;
}

async function locateCodebaseMemoryBinary() {
  const { stdout } = await execFileAsync('where.exe', ['codebase-memory-mcp'], { windowsHide: true });
  return stdout.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
}

export async function repairCodebaseMemoryBinary(spec, {
  locateBinary = locateCodebaseMemoryBinary,
  platform = process.platform,
} = {}) {
  if (platform !== 'win32') return false;
  try {
    const source = await locateBinary();
    if (!source) return false;
    const expectedHash = codebaseMemoryWindowsBinaryHashes.get(spec.version);
    if (!expectedHash) return false;
    const sourceHash = createHash('sha256').update(await readFile(source)).digest('hex');
    if (sourceHash !== expectedHash) return false;
    const destination = path.join(spec.toolDir, 'node_modules/codebase-memory-mcp/bin/codebase-memory-mcp.exe');
    await assertSafePathInside(spec.toolDir, destination, 'codebase-memory binary');
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    const destinationHash = createHash('sha256').update(await readFile(destination)).digest('hex');
    return destinationHash === expectedHash;
  } catch {
    return false;
  }
}

export async function defaultRuntimeVersionRunner(request) {
  return execFileAsync(request.command, request.args, {
    cwd: request.cwd,
    env: request.env,
    maxBuffer: maxDiagnosticOutput,
    timeout: 5_000,
    windowsHide: true,
  });
}

function inspectedRuntimeFailure(spec, code, message, targetDir) {
  const error = toolContractError(code, message);
  return {
    ...publicFailure(spec, 'runtime-check', error, targetDir),
    code,
  };
}

function exactVersionPattern(version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|\\s|v)${escaped}(?:\\s|$)`, 'u');
}

export async function verifyProvisionedOptionalRuntime(spec, targetDir, {
  arch,
  env,
  platform,
  runtimeVersionRunner,
}) {
  const prefix = spec.id === 'rtk' ? 'RTK' : 'AST_GREP';
  const available = spec.id === 'rtk'
    ? await rtkRuntimeAvailable(spec, platform, arch)
    : await astGrepRuntimeAvailable(spec, platform);
  if (!available) {
    throw toolContractError(`${prefix}_RUNTIME_MISSING`, `The project-local ${spec.id} binary is missing after installation.`);
  }
  const command = spec.id === 'rtk' ? rtkBinaryPath(spec, platform) : astGrepBinaryPath(spec, platform);
  let result;
  try {
    result = await runtimeVersionRunner({
      args: ['--version'],
      command,
      cwd: targetDir,
      env: allowedEnvironment(spec, env),
    });
  } catch {
    throw toolContractError(`${prefix}_RUNTIME_INVALID`, `The project-local ${spec.id} binary failed its provisioning version check.`);
  }
  const output = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
  if (!exactVersionPattern(spec.version).test(output)) {
    throw toolContractError(`${prefix}_VERSION_MISMATCH`, `The project-local ${spec.id} binary did not report pinned version ${spec.version}.`);
  }
  const binarySha256 = await optionalRuntimeHash(spec, platform);
  if (!binarySha256) {
    throw toolContractError(`${prefix}_RUNTIME_MISSING`, `The project-local ${spec.id} binary disappeared after its version check.`);
  }
  return binarySha256;
}

async function inspectReadyRuntime(spec, saved, fingerprint, targetDir, {
  arch,
  platform,
}) {
  const prefix = spec.id === 'rtk' ? 'RTK' : 'AST_GREP';
  if (saved.version !== spec.version) {
    return inspectedRuntimeFailure(
      spec,
      `${prefix}_STATE_VERSION_MISMATCH`,
      `The recorded ${spec.id} version does not match the pinned version; provision the tool again.`,
      targetDir,
    );
  }
  const available = spec.id === 'rtk'
    ? await rtkRuntimeAvailable(spec, platform, arch)
    : await astGrepRuntimeAvailable(spec, platform);
  if (!available) {
    return inspectedRuntimeFailure(
      spec,
      `${prefix}_RUNTIME_MISSING`,
      spec.id === 'rtk'
        ? 'The project-local RTK binary is missing; provision the tool again or use the original command directly.'
        : 'The project-local ast-grep binary is missing; provision the tool again or use rg/project search and record the fallback.',
      targetDir,
    );
  }
  const currentFingerprint = await lockFingerprint(spec);
  if (!fingerprint || !currentFingerprint || fingerprint !== currentFingerprint) {
    return inspectedRuntimeFailure(
      spec,
      `${prefix}_FINGERPRINT_MISMATCH`,
      `The project-local ${spec.id} package metadata no longer matches the provisioned state; provision the tool again.`,
      targetDir,
    );
  }
  if (!saved.binarySha256) {
    return inspectedRuntimeFailure(
      spec,
      `${prefix}_BINARY_HASH_MISSING`,
      `The recorded ${spec.id} state has no verified binary hash; provision the tool again.`,
      targetDir,
    );
  }
  const currentHash = await optionalRuntimeHash(spec, platform);
  if (currentHash !== saved.binarySha256) {
    return inspectedRuntimeFailure(
      spec,
      `${prefix}_BINARY_HASH_MISMATCH`,
      `The project-local ${spec.id} binary no longer matches its provisioning hash; provision the tool again.`,
      targetDir,
    );
  }
  return saved;
}

export async function inspectProfileTools(profile, targetDir, resolvedModules, toolIds, {
  allowPreview = false,
  arch = process.arch,
  platform = process.platform,
} = {}) {
  const statePath = path.join(await projectStateDir(targetDir), 'tool-state/tools.json');
  assertInsideDir(targetDir, statePath, 'tool state');
  await assertSafePathInside(targetDir, statePath, 'tool state');
  const state = await readToolState(targetDir);
  const tools = {};
  for (const spec of createToolProvisioningPlan({ allowPreview, profile, resolvedModules, targetDir, toolIds })) {
    await assertSafePathInside(targetDir, spec.toolDir, `${spec.id} tool directory`);
    const saved = state?.tools?.[spec.id];
    if (spec.id === 'rtk') {
      try {
        resolveRtkAsset({ platform, arch });
        tools[spec.id] = saved ?? { phase: 'install', status: 'pending', version: spec.version };
        if (tools[spec.id].status === 'ready') {
          tools[spec.id] = await inspectReadyRuntime(
            spec,
            tools[spec.id],
            state?.fingerprints?.[spec.id],
            targetDir,
            { arch, platform },
          );
        }
      } catch (error) {
        tools[spec.id] = publicFailure(spec, 'install', error, targetDir);
      }
    } else if (spec.id === 'astGrep') {
      tools[spec.id] = saved ?? { phase: 'install', status: 'pending', version: spec.version };
      if (tools[spec.id].status === 'ready') {
        tools[spec.id] = await inspectReadyRuntime(
          spec,
          tools[spec.id],
          state?.fingerprints?.[spec.id],
          targetDir,
          { arch, platform },
        );
      }
    } else if (spec.id === 'playwrightCli') {
      const inspected = await inspectPlaywrightTool({ targetDir, toolDir: spec.toolDir });
      tools[spec.id] = {
        phase: inspected.status === 'ready' ? 'ready' : 'first-use',
        status: inspected.status === 'unavailable' ? 'degraded' : inspected.status,
        version: spec.version,
      };
    } else {
      tools[spec.id] = saved ?? (spec.id === 'openCodeReview' && !(await resolveOcrEndpoint({ env: process.env })).env
        ? { phase: 'llm-config', status: 'pending-config', version: spec.version }
        : { phase: 'install', status: 'pending', version: spec.version });
    }
    tools[spec.id] = withOptionalToolIdentity(spec, tools[spec.id], platform, arch);
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

export { codebaseMemoryRuntimeAvailable };
