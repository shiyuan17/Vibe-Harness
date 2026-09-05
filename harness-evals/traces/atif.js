import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SECRET_KEY = /(api[-_]?key|authorization|credential|cookie|password|secret|session[-_]?id|token(?!s?$))/iu;
const SAFE_TOKEN_KEYS = new Set([
  'cachedTokens', 'completionTokens', 'contextTokens', 'inputTokens', 'outputTokens',
  'promptTokens', 'reasoningTokens', 'tokenUsage', 'totalTokens',
]);
const SECRET_TEXT = /\b(?:bearer\s+|token=|secret=|password=|api[-_]?key=|authorization=)[^\s,;]+/giu;
const WINDOWS_PATH = /[a-zA-Z]:\\(?:[^\\\s"']+\\?)*[^\\\s"']*/gu;
const POSIX_PATH = /(^|[\s"'=(])\/(?!\/)(?:[^/\s"'=]+\/)*[^/\s"'=]*/gu;
const MAX_TEXT_LENGTH = 64 * 1024;

function redactText(value) {
  const redacted = value
    .replace(SECRET_TEXT, '<redacted>')
    .replace(WINDOWS_PATH, '<path>')
    .replace(POSIX_PATH, (match, prefix) => `${prefix}<path>`);
  return redacted.length <= MAX_TEXT_LENGTH ? redacted : `${redacted.slice(0, MAX_TEXT_LENGTH)}<truncated>`;
}

export function redactTraceValue(value, key = '') {
  if (!SAFE_TOKEN_KEYS.has(key) && SECRET_KEY.test(key)) return '<redacted>';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactTraceValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      redactTraceValue(childValue, childKey),
    ]));
  }
  return value;
}

function stableRunId(value) {
  if (typeof value === 'string' && /^[A-Za-z0-9._-]{1,160}$/u.test(value)) return value;
  return `run-${createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 16)}`;
}

function stepFromEvent(event, index) {
  const base = {
    step_id: index + 1,
    timestamp: event.timestamp ?? new Date(0).toISOString(),
    source: event.source ?? (event.type === 'tool-result' ? 'system' : 'agent'),
  };
  if (event.type === 'tool-call') {
    return {
      ...base,
      source: 'agent',
      message: event.message ?? null,
      tool_calls: [{
        tool_call_id: stableRunId(event.callId ?? `call-${index + 1}`),
        function_name: event.name ?? 'unknown',
        arguments: event.arguments ?? (event.query === undefined ? {} : { query: event.query }),
        ...(event.extra ? { extra: event.extra } : {}),
      }],
      extra: { harness_event_type: event.type, ...(event.harness ?? {}) },
    };
  }
  if (event.type === 'tool-result') {
    return {
      ...base,
      source: 'system',
      message: event.message ?? null,
      observation: {
        results: [{
          source_call_id: stableRunId(event.callId ?? `call-${index}`),
          content: event.content ?? '',
          ...(event.extra ? { extra: event.extra } : {}),
        }],
      },
      extra: { harness_event_type: event.type, ...(event.harness ?? {}) },
    };
  }
  return {
    ...base,
    message: event.message ?? event.content ?? '',
    ...(event.modelName ? { model_name: event.modelName } : {}),
    ...(event.metrics ? {
      metrics: {
        ...(Number.isFinite(event.metrics.inputTokens) ? { prompt_tokens: event.metrics.inputTokens } : {}),
        ...(Number.isFinite(event.metrics.outputTokens) ? { completion_tokens: event.metrics.outputTokens } : {}),
        ...(Number.isFinite(event.metrics.cachedTokens) ? { cached_tokens: event.metrics.cachedTokens } : {}),
        ...(Number.isFinite(event.metrics.costUsd) ? { cost_usd: event.metrics.costUsd } : {}),
      },
    } : {}),
    extra: { harness_event_type: event.type ?? 'message', ...(event.harness ?? {}) },
  };
}

export function toAtifTrace({ runId, agent = {}, events = [], metrics = {}, subagents = [], extra = {} } = {}) {
  if (!Array.isArray(events) || !Array.isArray(subagents)) throw new TypeError('events and subagents must be arrays');
  const trace = {
    schema_version: 'ATIF-v1.8',
    trajectory_id: stableRunId(runId),
    session_id: stableRunId(runId),
    agent: {
      name: agent.name ?? 'unknown',
      version: agent.version ?? 'unknown',
      model_name: agent.modelName ?? agent.model ?? 'unknown',
      ...(agent.extra ? { extra: agent.extra } : {}),
    },
    steps: events.map(stepFromEvent),
    final_metrics: {
      total_prompt_tokens: Number.isFinite(metrics.inputTokens) ? metrics.inputTokens : 0,
      total_completion_tokens: Number.isFinite(metrics.outputTokens) ? metrics.outputTokens : 0,
      total_cached_tokens: Number.isFinite(metrics.cachedTokens) ? metrics.cachedTokens : 0,
      total_cost_usd: Number.isFinite(metrics.costUsd) ? metrics.costUsd : 0,
      total_steps: events.length,
    },
    ...(subagents.length > 0 ? {
      subagent_trajectories: subagents.map((subagent) => subagent.schema_version === 'ATIF-v1.8'
        ? subagent
        : toAtifTrace(subagent)),
    } : {}),
    extra: {
      harness: {
        tool_calls: Number.isFinite(metrics.toolCalls) ? metrics.toolCalls : null,
        ...extra,
      },
    },
  };
  return redactTraceValue(trace);
}

async function atomicWriteJson(target, value) {
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(redactTraceValue(value), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, target);
}

export async function writeTraceBundle(directory, { trace, events = [], artifacts = [] } = {}) {
  if (!trace || trace.schema_version !== 'ATIF-v1.8') throw new TypeError('trace must use ATIF-v1.8');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await Promise.all([
    atomicWriteJson(path.join(directory, 'trajectory.json'), trace),
    atomicWriteJson(path.join(directory, 'events.json'), { schemaVersion: 1, events }),
    atomicWriteJson(path.join(directory, 'artifacts.json'), { schemaVersion: 1, artifacts }),
  ]);
  return { artifacts: 'artifacts.json', events: 'events.json', trajectory: 'trajectory.json' };
}

export async function readTraceBundle(directory) {
  const [trace, eventDocument, artifactDocument] = await Promise.all([
    readFile(path.join(directory, 'trajectory.json'), 'utf8').then(JSON.parse),
    readFile(path.join(directory, 'events.json'), 'utf8').then(JSON.parse),
    readFile(path.join(directory, 'artifacts.json'), 'utf8').then(JSON.parse),
  ]);
  return { trace, events: eventDocument.events, artifacts: artifactDocument.artifacts };
}

const TAXONOMY = new Map([
  ['rule', 'Rule Failure'],
  ['planning', 'Planning Failure'],
  ['reasoning', 'Reasoning Failure'],
  ['tool', 'Tool Failure'],
  ['context', 'Context Failure'],
  ['coordination', 'Coordination Failure'],
  ['workflow', 'Verification Failure'],
  ['verification', 'Verification Failure'],
  ['recovery', 'Recovery Failure'],
  ['infrastructure', 'Infrastructure Failure'],
  ['fixture', 'Fixture Failure'],
  ['verifier', 'Verifier Failure'],
  ['collector', 'Collector Failure'],
]);

export function analyzeTrace(trace, checks = []) {
  const failedOrBlocked = checks.filter((check) => ['failed', 'blocked', 'unverified'].includes(check.status));
  const findings = failedOrBlocked.map((check) => ({
    checkId: check.id,
    code: check.code ?? check.id,
    taxonomy: check.taxonomy ?? TAXONOMY.get(check.category) ?? 'Unknown Failure',
    stage: check.stage ?? check.category ?? 'unknown',
    firstDeviation: check.evidence?.eventIndex === undefined ? null : { eventIndex: check.evidence.eventIndex },
    evidence: check.evidence ?? null,
    mechanism: check.mechanism ?? null,
    likelyCause: check.likelyCause ?? null,
    evidenceStrength: check.evidence ? 'deterministic' : 'insufficient',
    suggestedValidation: check.suggestedValidation ?? null,
  }));
  return {
    schemaVersion: 1,
    traceState: trace?.schema_version === 'ATIF-v1.8' || Array.isArray(trace?.steps) ? 'available' : 'unavailable',
    findings: redactTraceValue(findings),
  };
}
