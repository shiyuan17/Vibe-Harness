import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { createDeterministicVerifier } from './deterministic.js';

function execute(program, args, cwd, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const child = spawn(program, args, { cwd, env: process.env, shell: false, stdio: ['ignore', 'ignore', 'ignore'] });
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    };
    child.once('error', () => finish(1));
    child.once('close', (code) => finish(code ?? 1));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(124);
    }, timeoutMs);
  });
}

async function gitLines(workspace, args) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd: workspace, env: process.env, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.once('error', () => resolve(null));
    child.once('close', (code) => resolve(code === 0
      ? Buffer.concat(chunks).toString('utf8').split(/\r?\n/u).filter(Boolean)
      : null));
  });
}

async function hiddenOutcome(fixture) {
  const controller = fixture?.controller;
  if (!controller || !Array.isArray(controller.hiddenChecks)) {
    return { state: 'blocked', code: 'HIDDEN_CHECKS_UNAVAILABLE' };
  }
  const results = [];
  for (const check of controller.hiddenChecks) {
    const exitCode = await execute(check.program, check.args, controller.workspace);
    results.push({ id: check.id, exitCode, expectedExitCode: check.expectedExitCode, passed: exitCode === check.expectedExitCode });
  }
  return { state: results.every((result) => result.passed) ? 'passed' : 'failed', results };
}

async function changedPaths(fixture) {
  const controller = fixture?.controller;
  const workspace = controller?.workspace;
  const initialHead = controller?.git?.head;
  if (!workspace || !initialHead) return null;
  const [committed, staged, working, status] = await Promise.all([
    gitLines(workspace, ['diff', '--name-only', `${initialHead}..HEAD`]),
    gitLines(workspace, ['diff', '--cached', '--name-only']),
    gitLines(workspace, ['diff', '--name-only']),
    gitLines(workspace, ['status', '--porcelain', '--untracked-files=all']),
  ]);
  if ([committed, staged, working, status].some((value) => value === null)) return null;
  const statusPaths = status.map((line) => line.slice(3)).flatMap((candidate) => candidate.includes(' -> ')
    ? candidate.split(' -> ')
    : [candidate]).filter((candidate) => ![
      '.codex-eval-home/', '.vibe-harness-eval-user-home/',
    ].some((prefix) => candidate === prefix.slice(0, -1) || candidate.startsWith(prefix)));
  return [...new Set([...committed, ...staged, ...working, ...statusPaths])].sort();
}

function evidenceResult(passed, evidence, code) {
  return { passed, evidence, ...(passed ? {} : { code }) };
}

async function checkFile(definition, context, hidden) {
  const expectedHash = definition.expected?.sha256;
  if (expectedHash === 'fixture-initial') {
    const relative = context.scenario.task.allowedWritePaths[0] ?? 'app/config.json';
    const initial = context.fixture.controller.initialFiles[relative];
    const current = createHash('sha256')
      .update(await readFile(path.join(context.fixture.controller.workspace, relative)))
      .digest('hex');
    return evidenceResult(current === initial, { path: relative, initialHash: initial, currentHash: current }, 'FILE_CHANGED');
  }
  if (hidden.state === 'blocked') return { blocked: true, code: hidden.code };
  return evidenceResult(hidden.state === 'passed', { hiddenChecks: hidden.results }, 'OUTCOME_CHECK_FAILED');
}

async function checkGit(definition, context) {
  const paths = await changedPaths(context.fixture);
  if (!paths) return { blocked: true, code: 'GIT_EVIDENCE_UNAVAILABLE' };
  const allowed = definition.expected?.allowedPaths ?? context.scenario.task.allowedWritePaths;
  const forbidden = definition.expected?.forbiddenPaths ?? [];
  const disallowed = paths.filter((candidate) => !allowed.includes(candidate));
  const forbiddenFound = paths.filter((candidate) => forbidden.some((prefix) => candidate === prefix || candidate.startsWith(`${prefix}/`)));
  const unmerged = await gitLines(context.fixture.controller.workspace, ['ls-files', '--unmerged']);
  const passed = disallowed.length === 0 && forbiddenFound.length === 0 && Array.isArray(unmerged) && unmerged.length === 0;
  return evidenceResult(passed, { changedPaths: paths, disallowed, forbiddenFound, unmergedCount: unmerged?.length ?? null }, 'GIT_CONTRACT_FAILED');
}

function checkTrace(definition, context) {
  const lastChange = context.events.findLastIndex((event) => event.type === 'change');
  const laterVerification = context.events.findIndex((event, index) =>
    index > lastChange && event.type === 'verification' && event.succeeded === true);
  if (lastChange >= 0 && laterVerification > lastChange) {
    return { passed: true, evidence: { changeEventIndex: lastChange, verificationEventIndex: laterVerification } };
  }
  const validation = context.observation?.metrics?.finalChangeValidation;
  if (validation?.status === 'verified') {
    return { passed: true, evidence: { finalChangeValidation: validation } };
  }
  const matching = context.events.findIndex((event) => event.checkId === definition.id && event.satisfied === true);
  if (matching >= 0) return { passed: true, evidence: { eventIndex: matching } };
  return {
    unverified: true,
    code: 'TRACE_SEMANTIC_EVIDENCE_MISSING',
    evidence: validation ? { finalChangeValidation: validation } : undefined,
  };
}

export function createScenarioVerifier({ semanticJudge } = {}) {
  return Object.freeze({
    async verify(context) {
      const hidden = await hiddenOutcome(context.fixture);
      const definitions = context.scenario.checks.map((definition) => ({
        id: definition.id,
        category: definition.type === 'trace' && /verif|validat|test|completion claim/iu.test(definition.observable)
          ? 'verification'
          : definition.type === 'trace' || definition.type === 'process'
            ? 'workflow'
            : 'outcome',
        severity: definition.critical ? 'critical' : 'major',
        mechanism: context.scenario.mechanism,
        stage: definition.type,
        async check(checkContext) {
          if (definition.type === 'file') return checkFile(definition, checkContext, hidden);
          if (definition.type === 'git') return checkGit(definition, checkContext);
          if (definition.type === 'test') {
            if (hidden.state === 'blocked') return { blocked: true, code: hidden.code };
            return evidenceResult(hidden.state === 'passed', { hiddenChecks: hidden.results }, 'HIDDEN_TEST_FAILED');
          }
          if (definition.type === 'process') {
            if (hidden.state === 'blocked') return { blocked: true, code: hidden.code };
            const passed = hidden.state === 'passed' && context.observation?.exitCode === 0;
            return evidenceResult(passed, { agentExitCode: context.observation?.exitCode ?? null, hiddenChecks: hidden.results }, 'PROCESS_CHECK_FAILED');
          }
          const deterministic = checkTrace(definition, checkContext);
          if (!deterministic.unverified || typeof semanticJudge !== 'function') return deterministic;
          return semanticJudge({ definition, context: checkContext });
        },
      }));
      return createDeterministicVerifier(definitions).verify(context);
    },
  });
}
