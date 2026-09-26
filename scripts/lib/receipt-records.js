// Linear execution receipt and handoff records.
//
// docs/rules/linear-workflow.md §5 and
// skills/integrations/linear-workflow/references/execution-receipt.md define the
// immutable, append-only comments that record one Agent run instance. This
// module is the fixed part of that protocol: builders that never copy host
// identifiers, per-record validation, the redaction guard, and the conflict
// analysis over one Issue's comment history. Posting to Linear stays with the
// caller; nothing here fabricates a write.
import { randomUUID } from 'node:crypto';

export const START_RECEIPT_SCHEMA = 'vibe-harness.linear-execution/v1';
export const START_RECEIPT_SCHEMA_V2 = 'vibe-harness.linear-execution/v2';
export const TERMINAL_EVENT_SCHEMA = 'vibe-harness.linear-execution-event/v1';
export const HANDOFF_SCHEMA = 'vibe-harness.handoff/v1';

export const RECEIPT_SOURCES = Object.freeze(['explicit-user-request', 'existing-delegate', 'authorized-handoff']);
export const AUTO_CLAIM_RECEIPT_SOURCE = 'authorized-auto-claim';
export const TERMINAL_EVENT_TYPES = Object.freeze(['released', 'aborted', 'handed-off', 'local-work-completed']);
export const HANDOFF_STATUSES = Object.freeze(['complete', 'in-progress', 'blocked']);
export const RECEIPT_ROLES = Object.freeze(['writer']);
export const HANDOFF_FINAL_CHECK_RELEVANCE = 'reviewed';
export const HANDOFF_FINAL_CHECK_STATUS = 'passed';

export const START_RECEIPT_KEYS = Object.freeze(['schema', 'executionId', 'source', 'agentKey', 'hostKind', 'delegateId', 'runtimeInstanceId', 'role', 'dagRootIssue', 'dagNodeIssue', 'startedAt']);
export const START_RECEIPT_KEYS_V2 = Object.freeze([...START_RECEIPT_KEYS, 'grantId']);
export const TERMINAL_EVENT_KEYS = Object.freeze(['schema', 'eventId', 'executionId', 'eventType', 'successorExecutionId', 'occurredAt']);
export const TERMINAL_EVENT_OPTIONAL_KEYS = Object.freeze(['handoff']);
export const HANDOFF_KEYS = Object.freeze(['schema', 'completion', 'finalCheck', 'unresolvedItems']);

const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const issuePattern = /^[A-Z][A-Z0-9]{0,15}-[0-9]{1,10}$/u;
const keyPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/iu;
const utcTimestampPattern = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?Z$/u;

// Values that must never reach a structured comment. Matches are reported by
// path and category only: echoing the matched text would leak the secret into
// the very log or receipt the guard exists to protect.
const SENSITIVE_VALUE_PATTERNS = [
  { code: 'RECEIPT_LOCAL_PATH', detail: 'absolute filesystem path', pattern: /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/u },
  { code: 'RECEIPT_LOCAL_PATH', detail: 'UNC path', pattern: /(?:^|[=\s(["'])\\\\[^\\\s]/u },
  { code: 'RECEIPT_LOCAL_PATH', detail: 'POSIX home path', pattern: /(?:^|\/)(?:Users|home|root|Volumes)\//u },
  { code: 'RECEIPT_CREDENTIAL', detail: 'provider token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/u },
  { code: 'RECEIPT_CREDENTIAL', detail: 'bearer token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/iu },
  { code: 'RECEIPT_CREDENTIAL', detail: 'private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  { code: 'RECEIPT_IDENTITY_VALUE', detail: 'email address', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u },
];

// Field names that are host or session identity by construction. Keys are
// normalized before matching so thread_id, threadId and thread-id all match.
const SENSITIVE_KEY_TOKENS = Object.freeze([
  'accesstoken', 'apikey', 'bearertoken', 'computername', 'conversation', 'cookie', 'credential', 'cwd', 'email',
  'homedir', 'hostname', 'hostuser', 'localpath', 'machinename', 'oauth', 'password', 'refreshtoken', 'repopath',
  'reporoot', 'secretkey', 'session', 'thread', 'userid', 'userkey', 'username', 'workdir', 'workspacepath',
]);

/** @returns {value is Record<string, any>} */
function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isUtcTimestamp(value) {
  return typeof value === 'string' && utcTimestampPattern.test(value) && Number.isFinite(Date.parse(value));
}

function collector() {
  const problems = [];
  return {
    problems,
    push(code, message, severity = 'error') {
      problems.push({ code, message, severity });
    },
  };
}

function result(problems) {
  return {
    ok: !problems.some((problem) => problem.severity === 'error'),
    problems: problems.sort((left, right) => left.code.localeCompare(right.code)),
  };
}

function requireKeys(value, requiredKeys, push) {
  for (const key of requiredKeys) {
    // A key that is present but undefined cannot be serialized, so it is
    // reported as missing rather than silently dropped.
    if (!Object.hasOwn(value, key) || value[key] === undefined) push('RECEIPT_FIELD_MISSING', `${key} is required`, 'error');
  }
}

function warnUnknownKeys(value, allowedKeys, push) {
  for (const key of Object.keys(value)) {
    // Unknown additions may be ignored by a v1 consumer, but they are still
    // reported so a typo cannot silently drop a field.
    if (!allowedKeys.includes(key)) push('RECEIPT_FIELD_UNKNOWN', `${key} is not part of the v1 record shape`, 'warning');
  }
}

function checkUuid(value, label, push, { nullable = false } = {}) {
  if (value === undefined || (nullable && value === null)) return;
  if (typeof value !== 'string' || !uuidV4Pattern.test(value)) {
    push('RECEIPT_FIELD_NOT_UUID_V4', `${label} must be a freshly generated UUID v4`, 'error');
  }
}

function checkNullableString(value, label, push) {
  if (value === undefined) return;
  if (value !== null && !isNonEmptyString(value)) {
    push('RECEIPT_FIELD_TYPE', `${label} must be a non-empty string or null`, 'error');
  }
}

function checkIssueReference(value, label, { nullable = false } = {}, push) {
  if (value === undefined) return;
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !issuePattern.test(value)) {
    push('RECEIPT_FIELD_NOT_ISSUE', `${label} must be a Linear Issue identifier${nullable ? ' or null' : ''}`, 'error');
  }
}

function checkProductKey(value, label, push) {
  if (value === undefined) return;
  if (typeof value !== 'string' || !keyPattern.test(value)) {
    push('RECEIPT_FIELD_NOT_PRODUCT_KEY', `${label} must be a stable low-cardinality product key`, 'error');
  }
}

function checkTimestamp(value, label, push) {
  if (value === undefined) return;
  if (!isUtcTimestamp(value)) {
    push('RECEIPT_FIELD_NOT_TIMESTAMP', `${label} must be an RFC3339 UTC timestamp and must not be backdated`, 'error');
  }
}

/**
 * Report values and field names that must never appear in a receipt, event or
 * handoff payload: host/user identity, local paths, tokens, cookies and
 * session identifiers.
 */
export function scanSensitiveFields(value, prefix = '') {
  const findings = [];
  const visit = (current, currentPath) => {
    if (typeof current === 'string') {
      for (const rule of SENSITIVE_VALUE_PATTERNS) {
        if (rule.pattern.test(current)) {
          findings.push({ code: rule.code, detail: rule.detail, path: currentPath.replace(/\.$/u, '') });
        }
      }
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${currentPath}[${index}]`));
      return;
    }
    if (!isObject(current)) return;
    for (const [key, nested] of Object.entries(current)) {
      const normalized = key.replaceAll(/[^a-z0-9]/giu, '').toLowerCase();
      if (SENSITIVE_KEY_TOKENS.includes(normalized) || SENSITIVE_KEY_TOKENS.some((token) => normalized.startsWith(token))) {
        findings.push({ code: 'RECEIPT_IDENTITY_FIELD', detail: `field name ${key} carries host or session identity`, path: `${currentPath}${key}` });
      }
      visit(nested, `${currentPath}${key}.`);
    }
  };
  visit(value, prefix);
  return findings;
}

function sensitiveProblems(value, push) {
  for (const finding of scanSensitiveFields(value)) {
    push(finding.code, `${finding.path} carries ${finding.detail}; structured records must not contain host, session or credential data`, 'error');
  }
}

/** Validate a Start Receipt (`vibe-harness.linear-execution/v1`). */
export function validateStartReceipt(value) {
  const { problems, push } = collector();
  if (!isObject(value)) {
    push('RECEIPT_NOT_OBJECT', 'a start receipt must be a JSON object');
    return result(problems);
  }
  const autoClaim = value.schema === START_RECEIPT_SCHEMA_V2;
  const keys = autoClaim ? START_RECEIPT_KEYS_V2 : START_RECEIPT_KEYS;
  requireKeys(value, keys, push);
  warnUnknownKeys(value, keys, push);
  if (value.schema !== START_RECEIPT_SCHEMA && !autoClaim) {
    push('RECEIPT_SCHEMA_INVALID', `schema must be ${START_RECEIPT_SCHEMA} or ${START_RECEIPT_SCHEMA_V2}`, 'error');
  }
  checkUuid(value.executionId, 'executionId', push);
  checkUuid(value.runtimeInstanceId, 'runtimeInstanceId', push);
  if (autoClaim && value.source !== AUTO_CLAIM_RECEIPT_SOURCE) {
    push('RECEIPT_SOURCE_INVALID', `v2 source must be ${AUTO_CLAIM_RECEIPT_SOURCE}`, 'error');
  } else if (!autoClaim && value.source !== undefined && !RECEIPT_SOURCES.includes(value.source)) {
    push('RECEIPT_SOURCE_INVALID', `source must be one of ${RECEIPT_SOURCES.join(', ')}`, 'error');
  }
  if (autoClaim) checkUuid(value.grantId, 'grantId', push);
  if (value.role !== undefined && !RECEIPT_ROLES.includes(value.role)) {
    push('RECEIPT_ROLE_INVALID', `role must be one of ${RECEIPT_ROLES.join(', ')}`, 'error');
  }
  checkProductKey(value.agentKey, 'agentKey', push);
  checkProductKey(value.hostKind, 'hostKind', push);
  checkNullableString(value.delegateId, 'delegateId', push);
  checkIssueReference(value.dagRootIssue, 'dagRootIssue', { nullable: true }, push);
  checkIssueReference(value.dagNodeIssue, 'dagNodeIssue', {}, push);
  checkTimestamp(value.startedAt, 'startedAt', push);
  sensitiveProblems(value, push);
  return result(problems);
}

/** Validate a Terminal Event (`vibe-harness.linear-execution-event/v1`). */
export function validateTerminalEvent(value) {
  const { problems, push } = collector();
  if (!isObject(value)) {
    push('RECEIPT_NOT_OBJECT', 'a terminal event must be a JSON object');
    return result(problems);
  }
  requireKeys(value, TERMINAL_EVENT_KEYS, push);
  warnUnknownKeys(value, [...TERMINAL_EVENT_KEYS, ...TERMINAL_EVENT_OPTIONAL_KEYS], push);
  if (value.schema !== TERMINAL_EVENT_SCHEMA) push('RECEIPT_SCHEMA_INVALID', `schema must be ${TERMINAL_EVENT_SCHEMA}`, 'error');
  checkUuid(value.eventId, 'eventId', push);
  checkUuid(value.executionId, 'executionId', push);
  checkUuid(value.successorExecutionId, 'successorExecutionId', push, { nullable: true });
  checkTimestamp(value.occurredAt, 'occurredAt', push);
  if (value.eventType !== undefined && !TERMINAL_EVENT_TYPES.includes(value.eventType)) {
    push('RECEIPT_EVENT_TYPE_INVALID', `eventType must be one of ${TERMINAL_EVENT_TYPES.join(', ')}`, 'error');
  }
  if (value.eventType === 'handed-off') {
    if (!isNonEmptyString(value.successorExecutionId)) {
      push('RECEIPT_HANDOFF_SUCCESSOR_REQUIRED', 'a handed-off event must carry the pre-generated successorExecutionId', 'error');
    } else if (value.successorExecutionId === value.executionId) {
      push('RECEIPT_HANDOFF_SUCCESSOR_SELF', 'successorExecutionId must be a new executionId, not the one being terminated', 'error');
    }
  } else if (value.successorExecutionId !== null && value.successorExecutionId !== undefined) {
    push('RECEIPT_HANDOFF_SUCCESSOR_NOT_ALLOWED', 'successorExecutionId is only allowed on handed-off events', 'error');
  }
  if (Object.hasOwn(value, 'handoff')) {
    if (value.eventType !== 'handed-off') {
      push('RECEIPT_HANDOFF_PAYLOAD_NOT_ALLOWED', 'a handoff payload is only allowed on handed-off events', 'error');
    } else {
      for (const problem of validateHandoffPayload(value.handoff).problems) problems.push(problem);
    }
  }
  sensitiveProblems(value, push);
  return result(problems);
}

/**
 * Validate a Handoff Completion Payload (`vibe-harness.handoff/v1`). A payload
 * may only claim completion when the final check references a reviewed and
 * passed receipt; anything else is a progress handoff.
 */
export function validateHandoffPayload(value) {
  const { problems, push } = collector();
  if (!isObject(value)) {
    push('RECEIPT_NOT_OBJECT', 'a handoff payload must be a JSON object');
    return result(problems);
  }
  requireKeys(value, HANDOFF_KEYS, push);
  warnUnknownKeys(value, HANDOFF_KEYS, push);
  if (value.schema !== HANDOFF_SCHEMA) push('RECEIPT_SCHEMA_INVALID', `schema must be ${HANDOFF_SCHEMA}`, 'error');
  const completion = value.completion;
  const finalCheck = value.finalCheck;
  if (!isObject(completion)) {
    push('RECEIPT_FIELD_TYPE', 'completion must be an object with status and accepted', 'error');
  } else {
    warnUnknownKeys(completion, ['status', 'accepted'], push);
    if (!HANDOFF_STATUSES.includes(completion.status)) {
      push('RECEIPT_HANDOFF_STATUS_INVALID', `completion.status must be one of ${HANDOFF_STATUSES.join(', ')}`, 'error');
    }
    if (typeof completion.accepted !== 'boolean') push('RECEIPT_FIELD_TYPE', 'completion.accepted must be a boolean', 'error');
  }
  if (!isObject(finalCheck)) {
    // A malformed or absent final check does not make the record illegal; it
    // only means the handoff cannot be read as complete.
    push('RECEIPT_FINAL_CHECK_MISSING', 'finalCheck must be an object with receiptId, relevance and status', 'warning');
  } else {
    warnUnknownKeys(finalCheck, ['receiptId', 'relevance', 'status'], push);
    if (!isNonEmptyString(finalCheck.receiptId)) push('RECEIPT_FINAL_CHECK_MISSING', 'finalCheck.receiptId must reference the final check receipt', 'warning');
    if (finalCheck.relevance !== HANDOFF_FINAL_CHECK_RELEVANCE) {
      push('RECEIPT_FINAL_CHECK_NOT_REVIEWED', `finalCheck.relevance must be ${HANDOFF_FINAL_CHECK_RELEVANCE} to count as complete`, 'warning');
    }
    if (finalCheck.status !== HANDOFF_FINAL_CHECK_STATUS) {
      push('RECEIPT_FINAL_CHECK_NOT_PASSED', `finalCheck.status must be ${HANDOFF_FINAL_CHECK_STATUS} to count as complete`, 'warning');
    }
  }
  if (!Array.isArray(value.unresolvedItems)) {
    push('RECEIPT_FIELD_TYPE', 'unresolvedItems must be an array; use an empty array when nothing is unresolved', 'error');
  } else {
    const seenIds = new Set();
    value.unresolvedItems.forEach((item, index) => {
      if (!isObject(item)) {
        push('RECEIPT_FIELD_TYPE', `unresolvedItems[${index}] must be an object with id, summary and owner`, 'error');
        return;
      }
      warnUnknownKeys(item, ['id', 'summary', 'owner'], push);
      for (const key of ['id', 'summary', 'owner']) {
        if (!isNonEmptyString(item[key])) {
          push(key === 'owner' ? 'RECEIPT_UNRESOLVED_OWNER_MISSING' : 'RECEIPT_FIELD_MISSING', `unresolvedItems[${index}].${key} must be a non-empty string`, 'error');
        }
      }
      if (isNonEmptyString(item.id)) {
        if (seenIds.has(item.id)) push('RECEIPT_UNRESOLVED_DUPLICATE_ID', `unresolvedItems[${index}].id ${item.id} is used twice`, 'warning');
        seenIds.add(item.id);
      }
    });
  }
  if (isObject(completion) && (completion.status === 'complete' || completion.accepted === true)) {
    const supported = completion.status === 'complete'
      && completion.accepted === true
      && isObject(finalCheck)
      && finalCheck.relevance === HANDOFF_FINAL_CHECK_RELEVANCE
      && finalCheck.status === HANDOFF_FINAL_CHECK_STATUS
      && isNonEmptyString(finalCheck.receiptId);
    if (!supported) {
      push(
        'RECEIPT_HANDOFF_COMPLETION_UNSUPPORTED',
        'a complete handoff requires completion.status=complete, completion.accepted=true and a finalCheck that is reviewed and passed',
        'error',
      );
    }
  }
  sensitiveProblems(value, push);
  return result(problems);
}

/** True only when the payload satisfies every completion precondition. */
export function handoffClaimsComplete(value) {
  return isObject(value)
    && isObject(value.completion)
    && value.completion.status === 'complete'
    && value.completion.accepted === true
    && isObject(value.finalCheck)
    && isNonEmptyString(value.finalCheck.receiptId)
    && value.finalCheck.relevance === HANDOFF_FINAL_CHECK_RELEVANCE
    && value.finalCheck.status === HANDOFF_FINAL_CHECK_STATUS
    && Array.isArray(value.unresolvedItems);
}

/**
 * Build a Start Receipt with freshly generated run identifiers.
 *
 * @param {Record<string, any>} [options]
 */
export function buildStartReceipt({
  agentKey,
  dagNodeIssue,
  dagRootIssue = null,
  delegateId = null,
  executionId = randomUUID(),
  grantId,
  hostKind,
  role = 'writer',
  runtimeInstanceId = randomUUID(),
  schema = START_RECEIPT_SCHEMA,
  source = 'explicit-user-request',
  startedAt = new Date().toISOString(),
} = {}) {
  return {
    schema,
    executionId,
    source,
    agentKey,
    hostKind,
    delegateId,
    runtimeInstanceId,
    role,
    dagRootIssue,
    dagNodeIssue,
    startedAt,
    ...(schema === START_RECEIPT_SCHEMA_V2 ? { grantId } : {}),
  };
}

/**
 * Build a Terminal Event, enforcing the successor rules per event type.
 *
 * @param {Record<string, any>} [options]
 */
export function buildTerminalEvent({
  eventId = randomUUID(),
  executionId,
  eventType,
  handoff = null,
  occurredAt = new Date().toISOString(),
  successorExecutionId = null,
} = {}) {
  if (eventType === 'handed-off' && !isNonEmptyString(successorExecutionId)) {
    throw new Error('a handed-off event requires the pre-generated successorExecutionId');
  }
  if (eventType !== 'handed-off' && successorExecutionId !== null) {
    throw new Error('successorExecutionId is only valid on handed-off events');
  }
  return {
    schema: TERMINAL_EVENT_SCHEMA,
    eventId,
    executionId,
    eventType,
    successorExecutionId,
    occurredAt,
    ...(handoff === null ? {} : { handoff }),
  };
}

/**
 * Build a Handoff Completion Payload.
 *
 * @param {Record<string, any>} [options]
 */
export function buildHandoffPayload({
  accepted = false,
  finalCheckReceiptId,
  finalCheckRelevance = HANDOFF_FINAL_CHECK_RELEVANCE,
  finalCheckStatus = HANDOFF_FINAL_CHECK_STATUS,
  status = 'in-progress',
  unresolvedItems = [],
} = {}) {
  return {
    schema: HANDOFF_SCHEMA,
    completion: { status, accepted },
    finalCheck: {
      receiptId: finalCheckReceiptId,
      relevance: finalCheckRelevance,
      status: finalCheckStatus,
    },
    unresolvedItems: unresolvedItems.map((item) => ({ id: item.id, summary: item.summary, owner: item.owner })),
  };
}

function normalizeLedger(input) {
  if (Array.isArray(input)) return { comments: input, issue: null };
  if (isObject(input)) {
    const comments = input.comments ?? input.records ?? input.items;
    if (Array.isArray(comments)) return { comments, issue: isNonEmptyString(input.issue) ? input.issue : null };
  }
  return null;
}

/**
 * Analyse one Issue's structured comment history: which executions are active,
 * which terminal events exist, and which protocol conflicts must stop the
 * caller. Conflicts are fail-closed; pendings describe incomplete but legal
 * intermediate states such as a handoff whose successor is not confirmed yet.
 *
 * @param {unknown} input array of comments, or `{issue, comments}`
 * @param {{issue?: string|null}} [options]
 */
export function analyzeReceiptLedger(input, { issue = null } = {}) {
  const conflicts = [];
  const pendings = [];
  const warnings = [];
  const ledger = normalizeLedger(input);
  const expectedIssue = issue ?? ledger?.issue ?? null;
  if (!ledger) {
    conflicts.push({ code: 'LEDGER_NOT_A_LIST', message: 'ledger must be an array of structured comments or an object with a comments array' });
    return summarizeLedger({ comments: [], conflicts, pendings, duplicateCount: 0, receipts: new Map(), eventsByExecution: new Map(), warnings });
  }

  const receipts = new Map();
  const eventsByExecution = new Map();
  const seen = new Map();
  let duplicateCount = 0;

  for (const [index, record] of ledger.comments.entries()) {
    const schema = isObject(record) ? record.schema : null;
    const isReceipt = schema === START_RECEIPT_SCHEMA || schema === START_RECEIPT_SCHEMA_V2;
    const isEvent = schema === TERMINAL_EVENT_SCHEMA;
    if (!isReceipt && !isEvent) {
      conflicts.push({ code: 'LEDGER_UNKNOWN_RECORD', message: `record[${index}] is not a ${START_RECEIPT_SCHEMA}, ${START_RECEIPT_SCHEMA_V2} or ${TERMINAL_EVENT_SCHEMA} object` });
      continue;
    }
    const validation = isReceipt ? validateStartReceipt(record) : validateTerminalEvent(record);
    for (const problem of validation.problems.filter((item) => item.severity === 'error')) {
      conflicts.push({ code: problem.code, message: `record[${index}]: ${problem.message}` });
    }
    const identifier = isReceipt ? record.executionId : record.eventId;
    if (!isNonEmptyString(identifier)) continue;
    const dedupeKey = `${isReceipt ? 'receipt' : 'event'}:${identifier}`;
    const serialized = JSON.stringify(record);
    const previous = seen.get(dedupeKey);
    if (previous !== undefined) {
      if (previous === serialized) {
        // Same id and identical fields: the transport retry is idempotent.
        duplicateCount += 1;
      } else {
        conflicts.push({
          code: 'RECEIPT_ID_CONFLICT',
          message: `record[${index}] reuses ${isReceipt ? 'executionId' : 'eventId'} ${identifier} with different content; stop and let a human resolve it`,
        });
      }
      continue;
    }
    seen.set(dedupeKey, serialized);
    if (isReceipt) receipts.set(record.executionId, { index, record });
    else {
      const list = eventsByExecution.get(record.executionId) ?? [];
      list.push({ index, record });
      eventsByExecution.set(record.executionId, list);
    }
  }

  for (const [executionId, list] of eventsByExecution) {
    const receipt = receipts.get(executionId);
    if (!receipt) {
      conflicts.push({ code: 'RECEIPT_EVENT_ORPHANED', message: `terminal event ${list[0].record.eventId} references unknown execution ${executionId}` });
      continue;
    }
    if (list.length > 1) {
      conflicts.push({
        code: 'RECEIPT_MULTIPLE_TERMINAL_EVENTS',
        message: `execution ${executionId} has ${list.length} terminal events (${list.map((item) => item.record.eventType).join(', ')}); exactly one may be valid`,
      });
    }
    for (const entry of list) {
      const event = entry.record;
      if (entry.index < receipt.index) {
        warnings.push({ code: 'RECEIPT_EVENT_PRECEDES_RECEIPT', message: `terminal event for ${executionId} appears before its start receipt in comment order` });
      }
      if (isUtcTimestamp(event.occurredAt) && isUtcTimestamp(receipt.record.startedAt) && Date.parse(event.occurredAt) < Date.parse(receipt.record.startedAt)) {
        warnings.push({ code: 'RECEIPT_EVENT_PRECEDES_START', message: `terminal event for ${executionId} occurred before startedAt` });
      }
    }

    const event = list[0].record;
    if (event.eventType !== 'handed-off') continue;
    const successorId = isNonEmptyString(event.successorExecutionId) ? event.successorExecutionId : null;
    const successor = successorId === null ? undefined : receipts.get(successorId);
    if (!successor) {
      pendings.push({
        code: 'RECEIPT_HANDOFF_INCOMPLETE',
        message: `execution ${executionId} is handed off to ${successorId ?? '(missing successor id)'} but no start receipt confirms the successor`,
      });
    } else {
      if (successor.record.source !== 'authorized-handoff') {
        conflicts.push({
          code: 'RECEIPT_HANDOFF_SOURCE_INVALID',
          message: `successor ${successorId} must use source=authorized-handoff, received ${JSON.stringify(successor.record.source ?? null)}`,
        });
      }
      if (successor.record.dagNodeIssue !== receipt.record.dagNodeIssue) {
        conflicts.push({
          code: 'RECEIPT_HANDOFF_TARGET_MISMATCH',
          message: `successor ${successorId} targets ${successor.record.dagNodeIssue ?? '(missing issue)'} instead of ${receipt.record.dagNodeIssue ?? '(missing issue)'}`,
        });
      }
    }
    if (!Object.hasOwn(event, 'handoff')) {
      pendings.push({ code: 'RECEIPT_HANDOFF_PAYLOAD_MISSING', message: `handoff of ${executionId} carries no ${HANDOFF_SCHEMA} payload, so no completion state is declared` });
    } else if (validateHandoffPayload(event.handoff).ok) {
      if (!handoffClaimsComplete(event.handoff)) {
        pendings.push({
          code: 'RECEIPT_HANDOFF_NOT_COMPLETE',
          message: `handoff of ${executionId} declares a progress state: status=${event.handoff.completion.status}, accepted=${event.handoff.completion.accepted}`,
        });
      }
    }
  }

  for (const [executionId, receipt] of receipts) {
    if (receipt.record.source !== 'authorized-handoff') continue;
    const referenced = [...eventsByExecution.values()]
      .flat()
      .some((entry) => entry.record.eventType === 'handed-off' && entry.record.successorExecutionId === executionId);
    if (!referenced) {
      warnings.push({
        code: 'RECEIPT_HANDOFF_PREDECESSOR_UNSEEN',
        message: `execution ${executionId} claims source=authorized-handoff but no handed-off event in this ledger points at it`,
      });
    }
  }

  const active = [...receipts.entries()].filter(([executionId]) => !eventsByExecution.has(executionId));
  const activeByIssue = new Map();
  for (const [executionId, entry] of active) {
    const issueKey = isNonEmptyString(entry.record.dagNodeIssue) ? entry.record.dagNodeIssue.toUpperCase() : '(unknown issue)';
    activeByIssue.set(issueKey, [...(activeByIssue.get(issueKey) ?? []), executionId]);
  }
  for (const [issueKey, executionIds] of activeByIssue) {
    if (executionIds.length > 1) {
      conflicts.push({
        code: 'RECEIPT_MULTIPLE_ACTIVE_EXECUTIONS',
        message: `${issueKey} has ${executionIds.length} active executions (${executionIds.join(', ')}); at most one is allowed`,
      });
    }
  }
  if (expectedIssue !== null) {
    for (const [executionId, entry] of receipts) {
      const issueKey = isNonEmptyString(entry.record.dagNodeIssue) ? entry.record.dagNodeIssue.toUpperCase() : null;
      if (issueKey !== null && issueKey !== expectedIssue.toUpperCase()) {
        conflicts.push({
          code: 'LEDGER_ISSUE_MISMATCH',
          message: `execution ${executionId} targets ${issueKey}, but this ledger is bound to ${expectedIssue.toUpperCase()}`,
        });
      }
    }
  }

  return summarizeLedger({ activeByIssue, comments: ledger.comments, conflicts, duplicateCount, eventsByExecution, issue: expectedIssue, pendings, receipts, warnings });
}

function summarizeLedger({ activeByIssue = new Map(), comments, conflicts, duplicateCount, eventsByExecution, issue = null, pendings, receipts, warnings }) {
  const executions = [...receipts.entries()].map(([executionId, entry]) => {
    const terminals = eventsByExecution.get(executionId) ?? [];
    const terminal = terminals[0]?.record ?? null;
    return {
      agentKey: entry.record.agentKey ?? null,
      executionId,
      issue: entry.record.dagNodeIssue ?? null,
      source: entry.record.source ?? null,
      startedAt: entry.record.startedAt ?? null,
      successorExecutionId: terminal?.successorExecutionId ?? null,
      terminalEventType: terminal?.eventType ?? null,
    };
  }).sort((left, right) => left.executionId.localeCompare(right.executionId));
  const activeExecutions = executions.filter((execution) => execution.terminalEventType === null).map((execution) => execution.executionId);
  return {
    activeExecutions,
    activeByIssue: Object.fromEntries([...activeByIssue].map(([key, value]) => [key, value])),
    conflictCount: conflicts.length,
    conflicts,
    duplicateCount,
    executions,
    issue,
    ok: conflicts.length === 0,
    pendingCount: pendings.length,
    pendings,
    recordCount: comments.length,
    schemaVersion: 1,
    status: conflicts.length > 0 ? 'failed' : pendings.length > 0 ? 'incomplete' : 'passed',
    uniqueRecordCount: receipts.size + [...eventsByExecution.values()].reduce((total, list) => total + list.length, 0),
    warningCount: warnings.length,
    warnings,
  };
}

/** Human-readable summary of a ledger analysis. */
export function summarizeReceiptLedger(analysis) {
  const lines = [
    `status: ${analysis.status}`,
    `records: ${analysis.recordCount} (unique ${analysis.uniqueRecordCount}, idempotent duplicates ${analysis.duplicateCount})`,
    `executions: ${analysis.executions.length} (active ${analysis.activeExecutions.length})`,
  ];
  if (analysis.issue) lines.push(`issue: ${analysis.issue}`);
  for (const execution of analysis.executions) {
    lines.push(`  ${execution.executionId} ${execution.source} ${execution.issue ?? '(no issue)'} -> ${execution.terminalEventType ?? 'active'}`);
  }
  for (const conflict of analysis.conflicts) lines.push(`conflict: ${conflict.code} ${conflict.message}`);
  for (const pending of analysis.pendings) lines.push(`pending: ${pending.code} ${pending.message}`);
  for (const warning of analysis.warnings) lines.push(`warning: ${warning.code} ${warning.message}`);
  return lines.join('\n');
}
