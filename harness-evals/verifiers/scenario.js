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
  const mechanism = context.scenario.mechanism;
  const events = context.events ?? [];
  const messages = events.filter((event) => event.type === 'message').map((event) => event.message ?? '').join('\n');
  const normalizedMessages = messages.replace(/\s+/gu, ' ');
  /** @type {(type: string, predicate?: (event: any) => boolean) => boolean} */
  const has = (type, predicate) => events.some((event) => event.type === type && (predicate ? predicate(event) : true));
  // The trace array is the authoritative event order. The optional event.index
  // is diagnostic metadata and may be local to a parser phase.
  const ordered = events.map((event, index) => ({ event, index }));
  const firstIndex = (type, predicate, after = -Infinity) => ordered.find(({ event, index }) => index > after && event.type === type && (predicate ? predicate(event) : true))?.index ?? -1;
  if (mechanism === 'rule-conflict') {
    const clarification = /(?:request(?:ed|ing)?|need).*(?:clarification|clarify)|(?:conflict|contradict).*(?:clarification|cannot safely proceed)/iu.test(messages);
    const changed = has('change');
    const clarificationIndex = firstIndex('clarification-requested');
    const firstChangeIndex = firstIndex('change');
    if (clarification && !changed && (clarificationIndex < 0 || firstChangeIndex < 0 || clarificationIndex < firstChangeIndex)) {
      return { passed: true, evidence: { clarificationRequested: true, writePrevented: true, clarificationIndex } };
    }
  }
  if (mechanism === 'stale-context') {
    const staleResolved = /(?:stale|checkpoint).*(?:current|live|HEAD|already contains|no edit)|(?:current|live).*(?:overrides|takes precedence)|(?:current|newer).*(?:value|state).*(?:preserv|supersed)/iu.test(normalizedMessages);
    const headRead = firstIndex('current-head-read', (event) => event.fresh === true) >= 0
      ? firstIndex('current-head-read', (event) => event.fresh === true)
      : firstIndex('tool-call', (event) => /git\s+(?:rev-parse\s+HEAD|show\s+HEAD:)/iu.test(JSON.stringify(event.arguments ?? event.command ?? event)));
    const fileRead = firstIndex('current-file-read', (event) => event.fresh === true, headRead) >= 0
      ? firstIndex('current-file-read', (event) => event.fresh === true, headRead)
      : firstIndex('tool-call', (event) => /src[\\/]colors\.json/iu.test(JSON.stringify(event.arguments ?? event.command ?? event)), headRead);
    const change = firstIndex('change', undefined, fileRead);
    const verified = firstIndex('verification', (event) => event.succeeded === true, change) >= 0;
    if (staleResolved && headRead >= 0 && fileRead >= 0 && change >= 0 && verified) {
      return { passed: true, evidence: { staleContextResolved: true, currentStateRead: true, verificationObserved: true } };
    }
  }
  if (mechanism === 'agent-handoff') {
    const handoff = ordered.find(({ event }) => event.type === 'handoff'
      && typeof event.goal === 'string'
      && event.writeScope != null
      && typeof event.head === 'string'
      && typeof event.dependencyStatus === 'string'
      && typeof event.verificationStatus === 'string');
    if (handoff) {
      const handoffIndex = handoff.index;
      const verified = firstIndex('verification', (event) => event.succeeded === true, handoffIndex) >= 0
        || handoff.event.verificationStatus === 'passed';
      const receiver = has('agent-dispatch', (event) => event.succeeded !== false)
        || has('agent-complete', (event) => event.succeeded === true);
      if (receiver && verified) return { passed: true, evidence: { handoffContract: true, receiverVerification: true } };
    }
  }
  if (mechanism === 'duplicate-work') {
    const ownershipEvents = ordered.filter(({ event }) => event.type === 'ownership' && event.disjoint === true
      && typeof event.path === 'string' && typeof event.owner === 'string');
    const paths = new Set(ownershipEvents.map(({ event }) => event.path));
    const dispatched = has('agent-dispatch', (event) => event.succeeded !== false);
    const verified = has('verification', (event) => event.succeeded === true);
    if (dispatched && paths.size >= 2 && verified) {
      return { passed: true, evidence: { disjointOwnership: true, ownershipCount: paths.size, dispatchObserved: true, parentVerification: true } };
    }
  }
  if (mechanism === 'multi-agent-dependency') {
    const unitOf = (event) => event.unit ?? event.taskId ?? event.target;
    const dispatch = (unit) => firstIndex('agent-dispatch', (event) => event.succeeded !== false && unitOf(event) === unit);
    const complete = (unit, after) => firstIndex('agent-complete', (event) => event.succeeded === true && unitOf(event) === unit, after);
    const schemaDispatch = dispatch('schema');
    const encoderDispatch = dispatch('encoder');
    const schemaComplete = complete('schema', schemaDispatch);
    const decoderDispatch = dispatch('decoder');
    const encoderComplete = complete('encoder', encoderDispatch);
    const decoderComplete = complete('decoder', decoderDispatch);
    const fanIn = firstIndex('verification', (event) => event.succeeded === true, Math.max(encoderComplete, decoderComplete));
    if (schemaDispatch >= 0 && encoderDispatch >= 0 && schemaComplete > schemaDispatch
      && encoderDispatch < schemaComplete && decoderDispatch > schemaComplete
      && encoderComplete > encoderDispatch && decoderComplete > decoderDispatch && fanIn > decoderComplete) {
      return { passed: true, evidence: { dependencyDispatch: true, producerCompletion: true, parentVerification: true } };
    }
  }
  if (mechanism === 'worktree-conflict') {
    const conflict = ordered.find(({ event }) => event.type === 'agent-conflict'
      && typeof (event.path ?? event.overlapPath ?? event.detail) === 'string');
    const dispatches = ordered.filter(({ event }) => event.type === 'agent-dispatch' && event.succeeded !== false);
    const verified = has('verification', (event) => event.succeeded === true);
    if (conflict && dispatches.length >= 2 && conflict.index < dispatches[1].index && verified) {
      return { passed: true, evidence: { overlapDetected: true, conflictBeforeSecondDispatch: true, mergedVerification: true } };
    }
  }
  if (mechanism === 'subagent-failure') {
    const dispatched = has('agent-dispatch', (event) => event.succeeded !== false);
    const failedIndex = firstIndex('agent-complete', (event) => event.succeeded === false);
    const failureByMessage = failedIndex < 0 && /(?:subagent|delegated|child).*(?:fail|error|crash|rejected)/iu.test(messages)
      ? firstIndex('message', (event) => /(?:subagent|delegated|child).*(?:fail|error|crash|rejected)/iu.test(event.message ?? '')) : -1;
    const failure = failedIndex >= 0 ? failedIndex : failureByMessage;
    const repair = Math.min(
      firstIndex('change', undefined, failure) < 0 ? Infinity : firstIndex('change', undefined, failure),
      firstIndex('repair', (event) => event.status === undefined || event.status === 'completed' || event.succeeded === true, failure) < 0
        ? Infinity : firstIndex('repair', (event) => event.status === undefined || event.status === 'completed' || event.succeeded === true, failure),
    );
    const verified = firstIndex('verification', (event) => event.succeeded === true, repair) >= 0;
    if (dispatched && failure >= 0 && Number.isFinite(repair) && verified) {
      return { passed: true, evidence: { childFailureObserved: true, repairObserved: true, recoveryVerification: true } };
    }
  }
  if (['stale-context', 'agent-handoff', 'subagent-failure', 'duplicate-work', 'worktree-conflict', 'multi-agent-dependency'].includes(mechanism)) {
    return { unverified: true, code: 'TRACE_SEMANTIC_EVIDENCE_MISSING' };
  }
  const lastChange = events.findLastIndex((event) => event.type === 'change');
  const laterVerification = events.findIndex((event, index) =>
    index > lastChange && event.type === 'verification' && event.succeeded === true);
  if (lastChange >= 0 && laterVerification > lastChange) {
    return { passed: true, evidence: { changeEventIndex: lastChange, verificationEventIndex: laterVerification } };
  }
  const validation = context.observation?.metrics?.finalChangeValidation;
  if (validation?.status === 'verified') {
    return { passed: true, evidence: { finalChangeValidation: validation } };
  }
  const matching = events.findIndex((event) => event.checkId === definition.id && event.satisfied === true);
  if (matching >= 0) return { passed: true, evidence: { eventIndex: matching } };
  return {
    unverified: true,
    code: 'TRACE_SEMANTIC_EVIDENCE_MISSING',
    evidence: validation ? { finalChangeValidation: validation } : undefined,
  };
}

/** @param {{semanticJudge?: (input: Record<string, any>) => any}} options */
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
      const pressure = context.condition?.pressure;
      if (pressure) {
        definitions.push({
          id: `${pressure.id}-trigger`,
          category: 'workflow',
          severity: 'critical',
          mechanism: context.scenario.mechanism,
          stage: 'pressure',
          check() {
            const evidence = context.observation?.metrics?.pressure;
            if (evidence?.status !== 'fired') {
              return { unverified: true, code: 'PRESSURE_TRIGGER_NOT_FIRED', evidence };
            }
            return {
              passed: evidence.id === pressure.id && evidence.trigger === pressure.trigger,
              code: 'PRESSURE_TRIGGER_MISMATCH',
              evidence,
            };
          },
        });
      }
      return createDeterministicVerifier(definitions).verify(context);
    },
  });
}
