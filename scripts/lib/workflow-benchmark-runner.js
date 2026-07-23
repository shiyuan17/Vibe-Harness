import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  blockingInteractionCount,
  claimsCompletion,
  validateWorkflowFixture,
  workflowFixture,
  workflowScenario,
} from './workflow-benchmark-fixtures.js';

const OUTPUT_LIMIT = 1024 * 1024;
let preparationTail = Promise.resolve();

async function serializePreparation(callback) {
  const previous = preparationTail;
  let release;
  preparationTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await callback();
  } finally {
    release();
  }
}

function runProcess(program, args, { cwd, env = process.env, input, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let overflow = false;
    let timedOut = false;
    const child = spawn(program, args, {
      cwd,
      detached: process.platform !== 'win32',
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const append = (current, chunk) => {
      const next = Buffer.concat([current, chunk]);
      if (next.length > OUTPUT_LIMIT) {
        overflow = true;
        terminate(child);
      }
      return next.subarray(0, OUTPUT_LIMIT);
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => resolve({ error, wallTimeMs: Date.now() - startedAt }));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        overflow,
        signal,
        stderr: stderr.toString('utf8'),
        stdout: stdout.toString('utf8'),
        timedOut,
        wallTimeMs: Date.now() - startedAt,
      });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child);
    }, timeoutMs);
    child.stdin.end(input);
  });
}

function terminate(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { shell: false, stdio: 'ignore', windowsHide: true }).unref();
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

async function writeFixture(workspace, files) {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(workspace, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

async function installCognis({ rootDir, workflow, workspace }) {
  const cli = path.join(rootDir, 'scripts/cognis.js');
  const commands = [
    ['init', '--project', workspace, '--profile', 'full', '--workflow', workflow],
    ['install', '--project', workspace, '--target', 'codex', '--profile', 'full', '--write', '--confirm-red-zone'],
  ];
  for (const args of commands) {
    const result = await runProcess(process.execPath, [cli, ...args], { cwd: rootDir });
    if (result.code !== 0) throw new Error(`Cognis ${args[0]} failed with exit ${result.code}`);
  }
}

async function prepareDirtyGit(workspace) {
  const commands = [
    ['init'],
    ['config', 'user.name', 'Cognis Eval'],
    ['config', 'user.email', 'eval@example.invalid'],
    ['add', '.'],
    ['commit', '-m', 'fixture baseline'],
  ];
  for (const args of commands) {
    const result = await runProcess('git', args, { cwd: workspace });
    if (result.code !== 0) throw new Error(`git ${args[0]} failed`);
  }
  await writeFile(path.join(workspace, 'unrelated.txt'), 'user-owned change\n', 'utf8');
}

async function fileSnapshot(root, current = root) {
  const snapshot = new Map();
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (['.git', '.codex-eval-home', '.cognis-eval-user-home', '.cognis', 'node_modules'].includes(entry.name)) continue;
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      for (const [name, hash] of await fileSnapshot(root, full)) snapshot.set(name, hash);
    } else if (entry.isFile()) {
      const name = path.relative(root, full).replaceAll('\\', '/');
      snapshot.set(name, createHash('sha256').update(await readFile(full)).digest('hex'));
    }
  }
  return snapshot;
}

function changedFiles(before, after) {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((name) => before.get(name) !== after.get(name)).sort();
}

async function invokeCodex({ authFile, caseDefinition, model, reasoningEffort, rootDir, timeoutMs, workspace }) {
  const request = {
    schemaVersion: 1,
    runId: 'workflow-benchmark',
    repetition: caseDefinition.repetition,
    workspace,
    governanceHash: caseDefinition.governanceHash,
    case: {
      id: caseDefinition.id,
      input: { fixture: { files: [] }, scenario: caseDefinition.scenario },
      oracle: { requiredArtifacts: [] },
    },
  };
  const environment = {
    ...process.env,
    CODEX_MODEL: model,
    CODEX_REASONING_EFFORT: reasoningEffort,
    COGNIS_EVAL_AUTH_FILE: authFile,
    COGNIS_EVAL_TRUST_PROJECT_HOOKS: '1',
  };
  const result = await runProcess(process.execPath, [path.join(rootDir, 'runtime/evals/codex-runner.mjs')], {
    cwd: workspace,
    env: environment,
    input: JSON.stringify(request),
    timeoutMs,
  });
  if (result.code !== 0 || result.timedOut || result.overflow) {
    return { error: result.timedOut ? 'timeout' : (result.overflow ? 'output-limit' : 'runner-unavailable'), wallTimeMs: result.wallTimeMs };
  }
  try {
    return { observation: JSON.parse(result.stdout), wallTimeMs: result.wallTimeMs };
  } catch {
    return { error: 'invalid-runner-output', wallTimeMs: result.wallTimeMs };
  }
}

function trajectoryTags({ blockingInteractions, expectedAction, observation, passed, validation }) {
  const tags = [];
  if (expectedAction && observation.metrics.toolCalls === 0) tags.push('no-action-turn');
  if (expectedAction && blockingInteractions > 0) tags.push('invalid-confirmation');
  if (expectedAction && !validation.agentVerified) tags.push('insufficient-verification');
  if (!passed && /\b(?:skill|router)\b/iu.test(observation.output) && !expectedAction) tags.push('wrong-skill');
  if (!passed && !tags.length) tags.push(expectedAction ? 'insufficient-verification' : 'safety-block');
  return [...new Set(tags)];
}

export async function runWorkflowAttempt({ authFile, item, model, reasoningEffort, repetition, rootDir, timeoutMs, workflow }) {
  const workspace = await mkdtemp(path.join(tmpdir(), `cognis-workflow-${workflow}-${item.id.toLowerCase()}-`));
  try {
    const fixture = workflowFixture(item, workspace);
    await serializePreparation(async () => {
      await writeFixture(workspace, fixture.files);
      await installCognis({ rootDir, workflow, workspace });
      if (fixture.dirtyGit) await prepareDirtyGit(workspace);
    });
    const before = await fileSnapshot(workspace);
    const scenario = workflowScenario(item, fixture);
    const invoked = await invokeCodex({
      authFile,
      caseDefinition: {
        governanceHash: createHash('sha256').update(`${workflow}:${scenario}`).digest('hex'),
        id: item.id,
        repetition,
        scenario,
      },
      model,
      reasoningEffort,
      rootDir,
      timeoutMs,
      workspace,
    });
    if (!invoked.observation) {
      return {
        blockingInteractions: 0,
        caseId: item.id,
        criticalFailures: 0,
        diagnostic: invoked.error,
        falseCompletionClaims: 0,
        infrastructureFailure: true,
        noActionTurns: 0,
        passed: false,
        repetition,
        scopeViolations: 0,
        toolCalls: 0,
        totalTokens: 0,
        trajectoryTags: [],
        wallTimeMs: invoked.wallTimeMs,
      };
    }
    if (invoked.observation.exitCode !== 0 || invoked.observation.metrics?.totalTokens === 0) {
      return {
        blockingInteractions: 0,
        caseId: item.id,
        criticalFailures: 0,
        diagnostic: invoked.observation.exitCode !== 0 ? `codex-exit-${invoked.observation.exitCode}` : 'zero-usage',
        falseCompletionClaims: 0,
        infrastructureFailure: true,
        noActionTurns: 0,
        passed: false,
        repetition,
        scopeViolations: 0,
        toolCalls: invoked.observation.metrics?.toolCalls ?? 0,
        totalTokens: invoked.observation.metrics?.totalTokens ?? 0,
        trajectoryTags: [],
        wallTimeMs: invoked.wallTimeMs,
      };
    }
    const after = await fileSnapshot(workspace);
    const changed = changedFiles(before, after);
    const validation = await validateWorkflowFixture({ changedFiles: changed, fixture, observation: invoked.observation, workspace });
    const messages = invoked.observation.metrics?.messages ?? [];
    const blockingInteractions = blockingInteractionCount(messages);
    const passed = validation.passed;
    const falseCompletionClaims = !passed && claimsCompletion(invoked.observation.output) ? 1 : 0;
    const expectedAction = fixture.kind === 'code';
    return {
      blockingInteractions,
      caseId: item.id,
      criticalFailures: item.critical && !passed ? 1 : 0,
      falseCompletionClaims,
      noActionTurns: expectedAction && invoked.observation.metrics.toolCalls === 0 ? 1 : 0,
      passed,
      repetition,
      scopeViolationFiles: validation.scopeViolationFiles,
      scopeViolations: validation.scopeViolations,
      toolCalls: invoked.observation.metrics?.toolCalls ?? 0,
      totalTokens: invoked.observation.metrics?.totalTokens ?? 0,
      trajectoryTags: trajectoryTags({ blockingInteractions, expectedAction, observation: invoked.observation, passed, validation }),
      validation: {
        agentVerified: validation.agentVerified ?? null,
        testsPassed: validation.testsPassed ?? null,
      },
      wallTimeMs: invoked.wallTimeMs,
    };
  } catch (error) {
    return {
      blockingInteractions: 0,
      caseId: item.id,
      criticalFailures: 0,
      diagnostic: error.message,
      falseCompletionClaims: 0,
      infrastructureFailure: true,
      noActionTurns: 0,
      passed: false,
      repetition,
      scopeViolations: 0,
      toolCalls: 0,
      totalTokens: 0,
      trajectoryTags: [],
      wallTimeMs: 0,
    };
  } finally {
    await rm(workspace, { force: true, maxRetries: 20, recursive: true, retryDelay: 250 });
  }
}

export async function writeJsonAtomic(target, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, target);
}
