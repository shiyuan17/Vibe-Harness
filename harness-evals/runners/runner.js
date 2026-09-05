import { buildResultV3 } from '../lib/result.js';
import { redactTraceValue, toAtifTrace } from '../traces/atif.js';

const REQUIRED_BACKEND_METHODS = ['prepare', 'run', 'resume', 'cancel', 'collect', 'cleanup'];

function assertBackend(backend) {
  if (!backend || typeof backend !== 'object') throw new TypeError('backend is required');
  for (const method of REQUIRED_BACKEND_METHODS) {
    if (typeof backend[method] !== 'function') throw new TypeError(`backend.${method} must be a function`);
  }
}

function assertExecution(executions, executionId) {
  const execution = executions.get(executionId);
  if (!execution) throw new Error(`unknown evaluation execution: ${executionId}`);
  return execution;
}

function requiredCapabilities(scenario) {
  return scenario.requirements?.capabilities ?? scenario.capabilities?.required ?? scenario.capabilities ?? [];
}

export function createHarnessRunner({
  backend,
  fixtureManager = { async prepare() { return null; }, async cleanup() {} },
  verifier = { async verify() { return { status: 'passed', checks: [] }; } },
  traceStore,
  now = () => new Date(),
} = {}) {
  assertBackend(backend);
  const capabilities = Object.freeze([...(backend.capabilities ?? [])]);
  const executions = new Map();
  let executionCounter = 0;

  async function persistTrace(execution, attempt) {
    if (!traceStore) return null;
    const trace = toAtifTrace({
      runId: `${execution.executionId}-${attempt.id}`,
      agent: attempt.observation?.agent ?? execution.agent ?? {},
      events: attempt.events,
      metrics: {
        inputTokens: attempt.tokenUsage?.inputTokens,
        outputTokens: attempt.tokenUsage?.outputTokens,
        cachedTokens: attempt.tokenUsage?.cachedTokens,
        toolCalls: attempt.events.filter((event) => event.type === 'tool-call').length,
      },
      extra: { execution_id: execution.executionId, attempt_id: attempt.id },
    });
    if (typeof traceStore === 'function') return traceStore({ execution, attempt, trace });
    if (typeof traceStore.write === 'function') return traceStore.write({ execution, attempt, trace });
    throw new TypeError('traceStore must be a function or expose write()');
  }

  async function executeAttempt(execution, operation, input = {}) {
    if (execution.cleaned) throw new Error(`evaluation execution has been cleaned up: ${execution.executionId}`);
    const ordinal = execution.attempts.length + 1;
    const attempt = {
      id: `attempt-${ordinal}`,
      ordinal,
      phase: input.phase ?? 'green',
      startedAt: now().toISOString(),
      status: 'running',
      events: [],
    };
    execution.attempts.push(attempt);
    try {
      const observation = await backend[operation]({
        executionId: execution.executionId,
        scenario: execution.scenario,
        fixture: execution.fixture?.agent ?? execution.fixture,
        condition: execution.condition,
        budget: execution.budget,
        attempt: { id: attempt.id, ordinal },
        input,
        backendState: execution.backendState,
      });
      attempt.observation = redactTraceValue(observation ?? {});
      attempt.events = redactTraceValue(observation?.events ?? []);
      attempt.status = observation?.status ?? 'unverified';
      attempt.completionClaim = typeof observation?.completionClaim === 'boolean' ? observation.completionClaim : null;
      attempt.durationMs = Number.isFinite(observation?.durationMs) ? observation.durationMs : null;
      attempt.tokenUsage = observation?.tokenUsage ?? null;
      attempt.contextUsage = observation?.contextUsage ?? null;
      attempt.recovery = observation?.recovery ?? null;
      const verified = await verifier.verify({
        scenario: execution.scenario,
        fixture: execution.fixture,
        observation: attempt.observation,
        events: attempt.events,
        attempt,
      });
      attempt.checks = verified.checks;
      attempt.verification = {
        passed: verified.status === 'passed',
        status: verified.status,
      };
      if (verified.status === 'passed' && attempt.status === 'unverified') attempt.status = 'passed';
      if (verified.status === 'failed') attempt.status = 'failed';
      if (verified.status === 'blocked' && attempt.status === 'passed') attempt.status = 'blocked';
    } catch (error) {
      attempt.status = 'degraded';
      attempt.code = operation === 'resume' ? 'RUNNER_RESUME_FAILED' : 'RUNNER_EXECUTION_FAILED';
      attempt.diagnostics = redactTraceValue([error instanceof Error ? error.message : String(error)]);
    }
    attempt.finishedAt = now().toISOString();
    try {
      const traceRef = await persistTrace(execution, attempt);
      if (traceRef) {
        execution.traceRefs.push({ attemptId: attempt.id, ...traceRef });
      }
    } catch (error) {
      attempt.trace = { state: 'unavailable', diagnostic: redactTraceValue(error instanceof Error ? error.message : String(error)) };
    }
    return structuredClone(attempt);
  }

  return Object.freeze({
    capabilities,

    async prepare({ scenario, fingerprint = {}, condition = {}, budget = {}, agent = {} } = {}) {
      if (!scenario || typeof scenario.id !== 'string') throw new TypeError('scenario with id is required');
      const missing = requiredCapabilities(scenario).filter((capability) => !capabilities.includes(capability));
      if (missing.length > 0) throw new Error(`runner backend lacks required capabilities: ${missing.join(', ')}`);
      executionCounter += 1;
      const executionId = `execution-${executionCounter}`;
      const fixture = await fixtureManager.prepare({ executionId, scenario, condition, budget });
      let backendState;
      try {
        backendState = await backend.prepare({
          executionId,
          scenario,
          fixture: fixture?.agent ?? fixture,
          condition,
          budget,
          agent,
        });
      } catch (error) {
        await fixtureManager.cleanup({ executionId, fixture });
        throw error;
      }
      const execution = {
        executionId,
        scenario,
        fingerprint,
        condition,
        budget,
        agent,
        fixture,
        backendState,
        attempts: [],
        traceRefs: [],
        preparedAt: now().toISOString(),
        cancelled: false,
        cleaned: false,
      };
      executions.set(executionId, execution);
      return { executionId, status: 'prepared', capabilities };
    },

    async run(executionId, input = {}) {
      return executeAttempt(assertExecution(executions, executionId), 'run', input);
    },

    async resume(executionId, input = {}) {
      return executeAttempt(assertExecution(executions, executionId), 'resume', { ...input, resumed: true });
    },

    async cancel(executionId, reason = 'cancelled') {
      const execution = assertExecution(executions, executionId);
      await backend.cancel({ executionId, backendState: execution.backendState, reason });
      execution.cancelled = true;
      execution.cancelReason = redactTraceValue(reason);
      return { executionId, status: 'cancelled' };
    },

    async collect(executionId) {
      const execution = assertExecution(executions, executionId);
      const backendEvidence = await backend.collect({ executionId, backendState: execution.backendState });
      const checks = execution.attempts.flatMap((attempt) => attempt.checks ?? []);
      if (execution.cancelled) {
        checks.push({
          id: 'execution-cancelled',
          category: 'infrastructure',
          severity: 'major',
          status: 'blocked',
          code: 'EXECUTION_CANCELLED',
          evidence: { reason: execution.cancelReason },
        });
      }
      return buildResultV3({
        scenario: execution.scenario,
        attempts: execution.attempts,
        checks,
        traceRefs: execution.traceRefs,
        fingerprint: execution.fingerprint,
        generatedAt: now().toISOString(),
        failures: backendEvidence?.failures,
      });
    },

    async cleanup(executionId) {
      const execution = assertExecution(executions, executionId);
      if (execution.cleaned) return { executionId, status: 'cleaned' };
      const errors = [];
      try {
        await backend.cleanup({ executionId, backendState: execution.backendState });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      try {
        await fixtureManager.cleanup({ executionId, fixture: execution.fixture });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      execution.cleaned = true;
      return { executionId, status: errors.length > 0 ? 'degraded' : 'cleaned', diagnostics: redactTraceValue(errors) };
    },
  });
}
