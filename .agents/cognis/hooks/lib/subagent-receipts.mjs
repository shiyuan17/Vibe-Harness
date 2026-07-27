import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const RECEIPT_VERSION = 2;
const LEGACY_RECEIPT_VERSION = 1;
const RECEIPT_ROLES = new Set(['cognis_tester', 'cognis_reviewer']);
const REQUIRED_OUTPUT_FIELDS = ['状态', '变更摘要', '变更路径', '验证证据', '未验证项', '剩余风险', '下一步动作'];
const FINGERPRINT_EXCLUSIONS = ['.cognis/', 'docs/tasks/', 'docs/reviews/'];
const PROTECTED_EVIDENCE_ROOTS = ['docs/tasks', 'docs/reviews'];
const ROLE_CONCLUSIONS = new Map([
  ['cognis_tester', new Map([['通过', 'passed'], ['阻塞', 'blocked']])],
  ['cognis_reviewer', new Map([['批准', 'approved'], ['要求修改', 'changes-requested'], ['缺少证据而阻塞', 'evidence-blocked']])],
]);
const ACCEPTED_CONCLUSIONS = new Map([['cognis_tester', 'passed'], ['cognis_reviewer', 'approved']]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizedRelative(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '');
}

function excludedFromFingerprint(relativePath) {
  const normalized = normalizedRelative(relativePath);
  return FINGERPRINT_EXCLUSIONS.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}

async function statOrNull(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertNoLinkPath(rootDir, target, label) {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${label} escapes the project boundary.`);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await statOrNull(current);
    if (stat?.isSymbolicLink()) throw new Error(`${label} must not traverse a symbolic link or reparse point.`);
  }
}

async function runGit(rootDir, args, { allowFailure = false, encoding = 'utf8' } = {}) {
  try {
    return await execFileAsync('git', args, {
      cwd: rootDir,
      encoding,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

function parseUntracked(status) {
  const result = [];
  const entries = status.split('\0').filter(Boolean);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const code = entry.slice(0, 2);
    const relativePath = entry.slice(3);
    if (code.includes('R') || code.includes('C')) index += 1;
    if (code === '??' && relativePath && !excludedFromFingerprint(relativePath)) result.push(relativePath);
  }
  return result.sort((left, right) => left.localeCompare(right));
}

async function hashUntracked(rootDir, relativePath) {
  const target = path.resolve(rootDir, relativePath);
  await assertNoLinkPath(rootDir, path.dirname(target), 'Untracked fingerprint path');
  const stat = await lstat(target);
  if (stat.isSymbolicLink()) return `link:${normalizedRelative(relativePath)}:${await readlink(target)}`;
  if (!stat.isFile()) return `other:${normalizedRelative(relativePath)}:${stat.mode}`;
  return `file:${normalizedRelative(relativePath)}:${sha256(await readFile(target))}`;
}

export function hashIdentifier(kind, value) {
  if (typeof kind !== 'string' || !kind || typeof value !== 'string' || !value) {
    throw new Error('Receipt identifiers require non-empty kind and value strings.');
  }
  return sha256(`cognis-subagent-receipt-v1\0${kind}\0${value}`);
}

export async function computeWorkspaceFingerprint(rootDir) {
  const root = path.resolve(rootDir);
  const repository = await runGit(root, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (!repository || path.resolve(repository.stdout.trim()) !== root) return 'unavailable';
  const head = await runGit(root, ['rev-parse', 'HEAD'], { allowFailure: true });
  const base = head?.stdout.trim() || 'UNBORN';
  const diffArgs = head
    ? ['diff', '--binary', '--no-ext-diff', '--no-renames', 'HEAD', '--', '.', ':(exclude).cognis/**', ':(exclude)docs/tasks/**', ':(exclude)docs/reviews/**']
    : ['diff', '--cached', '--binary', '--no-ext-diff', '--no-renames', '--', '.', ':(exclude).cognis/**', ':(exclude)docs/tasks/**', ':(exclude)docs/reviews/**'];
  const [diff, status] = await Promise.all([
    runGit(root, diffArgs),
    runGit(root, ['-c', 'status.renames=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=no']),
  ]);
  const untracked = parseUntracked(status.stdout);
  const untrackedHashes = await Promise.all(untracked.map((item) => hashUntracked(root, item)));
  return sha256(stableJson({ base, diff: diff.stdout, untracked: untrackedHashes }));
}

async function evidenceEntries(rootDir, relativeRoot) {
  const targetRoot = path.join(rootDir, relativeRoot);
  await assertNoLinkPath(rootDir, targetRoot, 'Protected evidence path');
  const stat = await statOrNull(targetRoot);
  if (!stat) return [`missing:${normalizedRelative(relativeRoot)}`];
  if (!stat.isDirectory()) return [`other:${normalizedRelative(relativeRoot)}:${stat.mode}`];
  const entries = [];
  async function visit(target, relative) {
    for (const entry of (await readdir(target, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const child = path.join(target, entry.name);
      const childRelative = normalizedRelative(path.join(relative, entry.name));
      if (entry.isSymbolicLink()) throw new Error('Protected evidence path must not traverse a symbolic link or reparse point.');
      if (entry.isDirectory()) await visit(child, childRelative);
      else if (entry.isFile()) entries.push(`file:${childRelative}:${sha256(await readFile(child))}`);
      else entries.push(`other:${childRelative}`);
    }
  }
  await visit(targetRoot, relativeRoot);
  return entries;
}

export async function computeProtectedEvidenceFingerprint(rootDir) {
  try {
    const entries = (await Promise.all(PROTECTED_EVIDENCE_ROOTS.map((item) => evidenceEntries(rootDir, item)))).flat();
    return sha256(stableJson(entries));
  } catch {
    return 'unavailable';
  }
}

async function receiptDirectory(rootDir, { create = false } = {}) {
  const stateRoot = '.cognis';
  const target = path.join(rootDir, stateRoot, 'subagents', 'receipts');
  await assertNoLinkPath(rootDir, target, 'Subagent receipt directory');
  if (create) {
    await mkdir(target, { recursive: true });
    await assertNoLinkPath(rootDir, target, 'Subagent receipt directory');
  }
  return { relative: `${stateRoot}/subagents/receipts`, target };
}

function receiptIntegrity(receipt) {
  const { integrityHash: _ignored, ...unsigned } = receipt;
  return sha256(`cognis-subagent-receipt-integrity-v${receipt.schemaVersion}\0${stableJson(unsigned)}`);
}

function sealIntegrity(receipt) {
  return { ...receipt, integrityHash: receiptIntegrity(receipt) };
}

function validateReceiptShape(receipt, filename) {
  const errors = [];
  const required = [
    'schemaVersion', 'receiptId', 'sessionIdHash', 'agentIdHash', 'turnIdHash', 'role', 'status',
    'startedAt', 'startWorkspaceFingerprint', 'startEvidenceFingerprint', 'attestationScope',
    'continuationCount', 'outputValidation', 'integrityHash',
  ];
  for (const field of required) if (!Object.hasOwn(receipt, field)) errors.push(`missing ${field}`);
  if (receipt.schemaVersion !== RECEIPT_VERSION) errors.push('unsupported schemaVersion');
  for (const field of ['receiptId', 'sessionIdHash', 'agentIdHash', 'turnIdHash', 'integrityHash']) {
    if (!HASH_PATTERN.test(receipt[field] ?? '')) errors.push(`invalid ${field}`);
  }
  if (filename && filename !== `${receipt.receiptId}.json`) errors.push('receipt filename does not match receiptId');
  if (!RECEIPT_ROLES.has(receipt.role)) errors.push('invalid role');
  if (!['started', 'continuation-requested', 'sealed', 'invalid'].includes(receipt.status)) errors.push('invalid status');
  if (receipt.attestationScope !== 'project-local-tamper-evidence') errors.push('invalid attestationScope');
  if (!Number.isInteger(receipt.continuationCount) || receipt.continuationCount < 0 || receipt.continuationCount > 1) errors.push('invalid continuationCount');
  if (Number.isNaN(Date.parse(receipt.startedAt ?? ''))) errors.push('invalid startedAt');
  for (const field of ['startWorkspaceFingerprint', 'startEvidenceFingerprint']) {
    if (receipt[field] !== 'unavailable' && !HASH_PATTERN.test(receipt[field] ?? '')) errors.push(`invalid ${field}`);
  }
  if (!receipt.outputValidation || !['pending', 'valid', 'invalid'].includes(receipt.outputValidation.status)
    || !Array.isArray(receipt.outputValidation.missing)
    || !['pending', 'passed', 'blocked', 'approved', 'changes-requested', 'evidence-blocked', 'unrecognized'].includes(receipt.outputValidation.conclusion)) {
    errors.push('invalid outputValidation');
  }
  if (['sealed', 'invalid'].includes(receipt.status)) {
    if (Number.isNaN(Date.parse(receipt.completedAt ?? ''))) errors.push('invalid completedAt');
    for (const field of ['completedWorkspaceFingerprint', 'completedEvidenceFingerprint']) {
      if (receipt[field] !== 'unavailable' && !HASH_PATTERN.test(receipt[field] ?? '')) errors.push(`invalid ${field}`);
    }
  }
  if (receipt.status === 'sealed') {
    if (receipt.outputValidation?.status !== 'valid' || receipt.outputValidation?.missing?.length !== 0) errors.push('sealed receipt output is not valid');
    if (receipt.outputValidation?.conclusion !== ACCEPTED_CONCLUSIONS.get(receipt.role)) errors.push('sealed receipt conclusion is not accepted');
    if (receipt.invalidReason !== undefined) errors.push('sealed receipt must not contain invalidReason');
  }
  if (receipt.status === 'invalid' && typeof receipt.invalidReason !== 'string') errors.push('invalid receipt is missing invalidReason');
  if (HASH_PATTERN.test(receipt.integrityHash ?? '') && receiptIntegrity(receipt) !== receipt.integrityHash) errors.push('integrity hash mismatch');
  return errors;
}

function validateLegacyReceiptShape(receipt, filename) {
  const errors = [];
  if (receipt?.schemaVersion !== LEGACY_RECEIPT_VERSION) errors.push('unsupported schemaVersion');
  for (const field of ['receiptId', 'sessionIdHash', 'agentIdHash', 'turnIdHash', 'integrityHash']) {
    if (!HASH_PATTERN.test(receipt?.[field] ?? '')) errors.push(`invalid ${field}`);
  }
  if (filename !== `${receipt?.receiptId}.json`) errors.push('receipt filename does not match receiptId');
  if (HASH_PATTERN.test(receipt?.integrityHash ?? '') && receiptIntegrity(receipt) !== receipt.integrityHash) errors.push('integrity hash mismatch');
  return errors;
}

export async function writeExclusive(target, value) {
  const handle = await open(target, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.close();
  } catch (error) {
    try {
      await handle.close();
    } catch {
      // Preserve the original write or close error.
    }
    try {
      await rm(target, { force: true });
    } catch {
      // Cleanup is best effort; the original failure remains authoritative.
    }
    throw error;
  }
}

async function replaceAtomically(target, value) {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeExclusive(temporary, value);
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function assertRole(role) {
  if (!RECEIPT_ROLES.has(role)) throw new Error(`Unsupported governed subagent role: ${String(role)}`);
}

export function validateSubagentOutput(role, message) {
  assertRole(role);
  const body = typeof message === 'string' ? message : '';
  const values = {};
  const duplicates = new Set();
  let fence = null;
  let nestedContainer = false;
  let htmlBlockEnd = null;
  const lines = body.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (fence) {
      const closing = line.match(/^ {0,3}(`+|~+)[ \t]*$/u)?.[1];
      if (closing && closing[0] === fence.character && closing.length >= fence.length) fence = null;
      continue;
    }
    if (htmlBlockEnd) {
      if (htmlBlockEnd === 'blank' ? line.trim() === '' : htmlBlockEnd.test(line)) htmlBlockEnd = null;
      continue;
    }
    if (line.trim() === '') {
      nestedContainer = false;
      continue;
    }
    if (nestedContainer) continue;
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (fenceMatch) {
      fence = { character: fenceMatch[1][0], length: fenceMatch[1].length };
      continue;
    }
    const htmlStart = line.match(/^ {0,3}(?:<!--|<\?|<!\[CDATA\[|<![A-Z]|<(script|pre|style|textarea)(?:\s|>|$)|<\/?[A-Za-z][^>]*>)/iu);
    if (htmlStart) {
      if (/^ {0,3}<!--/u.test(line) && !line.includes('-->')) htmlBlockEnd = /-->/u;
      else if (/^ {0,3}<\?/u.test(line) && !line.includes('?>')) htmlBlockEnd = /\?>/u;
      else if (/^ {0,3}<!\[CDATA\[/u.test(line) && !line.includes(']]>')) htmlBlockEnd = /\]\]>/u;
      else if (/^ {0,3}<![A-Z]/u.test(line) && !line.includes('>')) htmlBlockEnd = />/u;
      else if (htmlStart[1] && !new RegExp(`</${htmlStart[1]}\\s*>`, 'iu').test(line)) {
        htmlBlockEnd = new RegExp(`</${htmlStart[1]}\\s*>`, 'iu');
      } else if (!htmlStart[1]) htmlBlockEnd = 'blank';
      continue;
    }
    if (/^ {0,3}(?:>|(?:[-+*]|\d{1,9}[.)])[ \t]+)/u.test(line)) {
      nestedContainer = true;
      continue;
    }
    if (/^(?:[ \t]|#{1,6}[ \t])/u.test(line)) continue;
    if (/^ {0,3}(?:=+|-+)[ \t]*$/u.test(lines[index + 1] ?? '')) continue;
    const match = line.match(/^([^：:'"\r\n]+)[：:]\s*(.+)$/u);
    if (!match) continue;
    const field = match[1].trim();
    if (!REQUIRED_OUTPUT_FIELDS.includes(field)) continue;
    if (Object.hasOwn(values, field)) duplicates.add(field);
    else values[field] = match[2].trim();
  }
  const missing = REQUIRED_OUTPUT_FIELDS.filter((field) => !values[field] || /^(?:TODO|TBD|N\/A|待定)$/iu.test(values[field]));
  for (const field of duplicates) missing.push(`${field}（必须且只能出现一次）`);
  const conclusion = ROLE_CONCLUSIONS.get(role).get(values['状态']) ?? 'unrecognized';
  if (conclusion === 'unrecognized' && !missing.includes('状态')) {
    missing.push(role === 'cognis_tester' ? '状态（必须为“通过”或“阻塞”）' : '状态（必须为“批准”“要求修改”或“缺少证据而阻塞”）');
  }
  return { conclusion, status: missing.length === 0 ? 'valid' : 'invalid', missing };
}

export async function startSubagentReceipt(rootDir, input, { now = new Date() } = {}) {
  assertRole(input.agentType);
  for (const [label, value] of [['session_id', input.sessionId], ['agent_id', input.agentId], ['turn_id', input.turnId]]) {
    if (typeof value !== 'string' || !value) throw new Error(`${label} is required for subagent receipts.`);
  }
  const directory = await receiptDirectory(rootDir, { create: true });
  const identity = {
    sessionIdHash: hashIdentifier('session', input.sessionId),
    agentIdHash: hashIdentifier('agent', input.agentId),
    turnIdHash: hashIdentifier('turn', input.turnId),
  };
  const startedAt = now.toISOString();
  const [startWorkspaceFingerprint, startEvidenceFingerprint] = await Promise.all([
    computeWorkspaceFingerprint(rootDir),
    computeProtectedEvidenceFingerprint(rootDir),
  ]);
  const receiptId = sha256(`cognis-subagent-run-v2\0${stableJson({ ...identity, role: input.agentType })}`);
  const receipt = sealIntegrity({
    schemaVersion: RECEIPT_VERSION,
    receiptId,
    ...identity,
    role: input.agentType,
    status: 'started',
    startedAt,
    startWorkspaceFingerprint,
    startEvidenceFingerprint,
    attestationScope: 'project-local-tamper-evidence',
    continuationCount: 0,
    outputValidation: { status: 'pending', missing: [], conclusion: 'pending' },
  });
  const target = path.join(directory.target, `${receiptId}.json`);
  try {
    await writeExclusive(target, receipt);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('A receipt already exists for this subagent run.', { cause: error });
    throw error;
  }
  return { receipt, relativePath: `${directory.relative}/${receiptId}.json` };
}

async function activeReceipt(rootDir, input) {
  const report = await inspectSubagentReceipts(rootDir);
  const agentIdHash = hashIdentifier('agent', input.agentId);
  const sessionIdHash = hashIdentifier('session', input.sessionId);
  const turnIdHash = hashIdentifier('turn', input.turnId);
  const sameRun = report.receipts.filter((item) => item.sessionIdHash === sessionIdHash
    && item.agentIdHash === agentIdHash
    && item.turnIdHash === turnIdHash
    && item.role === input.agentType);
  const matches = sameRun.filter((item) => ['started', 'continuation-requested'].includes(item.status));
  if (matches.length !== 1) {
    if (matches.length > 1) throw new Error('Duplicate active subagent receipts were found.');
    if (sameRun.length > 0) throw new Error('Subagent receipt is already sealed or invalid.');
    throw new Error('Subagent start receipt is missing.');
  }
  const receipt = matches[0];
  const directory = await receiptDirectory(rootDir);
  return { directory, receipt, target: path.join(directory.target, `${receipt.receiptId}.json`) };
}

export async function finishSubagentReceipt(rootDir, input, { now = new Date() } = {}) {
  assertRole(input.agentType);
  const current = await activeReceipt(rootDir, input);
  const [completedWorkspaceFingerprint, completedEvidenceFingerprint] = await Promise.all([
    computeWorkspaceFingerprint(rootDir),
    computeProtectedEvidenceFingerprint(rootDir),
  ]);
  const outputValidation = validateSubagentOutput(input.agentType, input.lastAssistantMessage);
  const workspaceChanged = current.receipt.startWorkspaceFingerprint === 'unavailable'
    || completedWorkspaceFingerprint === 'unavailable'
    || current.receipt.startWorkspaceFingerprint !== completedWorkspaceFingerprint;
  const evidenceChanged = current.receipt.startEvidenceFingerprint === 'unavailable'
    || completedEvidenceFingerprint === 'unavailable'
    || current.receipt.startEvidenceFingerprint !== completedEvidenceFingerprint;
  if (workspaceChanged || evidenceChanged) {
    const receipt = sealIntegrity({
      ...current.receipt,
      status: 'invalid',
      completedAt: now.toISOString(),
      completedWorkspaceFingerprint,
      completedEvidenceFingerprint,
      outputValidation,
      invalidReason: workspaceChanged ? 'workspace-fingerprint-changed' : 'protected-evidence-changed',
    });
    await replaceAtomically(current.target, receipt);
    return { block: false, receipt, reason: workspaceChanged
      ? 'The frozen Git-visible change set changed during independent verification.'
      : 'Protected task or review evidence changed during independent verification.' };
  }
  if (outputValidation.status !== 'valid' && current.receipt.continuationCount === 0 && !input.stopHookActive) {
    const receipt = sealIntegrity({
      ...current.receipt,
      status: 'continuation-requested',
      continuationCount: 1,
      outputValidation,
    });
    await replaceAtomically(current.target, receipt);
    return { block: true, receipt, reason: `Subagent output is missing required fields: ${outputValidation.missing.join(', ')}.` };
  }
  const structurallyValid = outputValidation.status === 'valid';
  const accepted = structurallyValid && outputValidation.conclusion === ACCEPTED_CONCLUSIONS.get(input.agentType);
  const receipt = sealIntegrity({
    ...current.receipt,
    status: accepted ? 'sealed' : 'invalid',
    completedAt: now.toISOString(),
    completedWorkspaceFingerprint,
    completedEvidenceFingerprint,
    outputValidation,
    ...(accepted ? {} : { invalidReason: structurallyValid ? 'subagent-conclusion-not-accepted' : 'subagent-output-not-accepted' }),
  });
  await replaceAtomically(current.target, receipt);
  return {
    block: false,
    receipt,
    reason: accepted
      ? 'Subagent receipt sealed.'
      : structurallyValid
        ? `Subagent conclusion was not accepted: ${outputValidation.conclusion}.`
        : `Subagent output remains incomplete after one continuation: ${outputValidation.missing.join(', ')}.`,
  };
}

export async function inspectSubagentReceipts(rootDir) {
  const summary = {
    status: 'absent',
    counts: { started: 0, continuationRequested: 0, sealed: 0, invalid: 0, legacy: 0 },
    reasons: [],
    receipts: [],
  };
  let directory;
  try {
    directory = await receiptDirectory(rootDir);
    const stat = await statOrNull(directory.target);
    if (!stat) return summary;
    if (!stat.isDirectory()) throw new Error('Subagent receipt path is not a directory.');
  } catch (error) {
    return { ...summary, status: 'invalid', reasons: [error.message] };
  }
  const seen = new Set();
  for (const entry of await readdir(directory.target, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      summary.reasons.push(`Unexpected receipt entry: ${entry.name}`);
      continue;
    }
    try {
      const target = path.join(directory.target, entry.name);
      await assertNoLinkPath(rootDir, target, 'Subagent receipt');
      const receipt = JSON.parse(await readFile(target, 'utf8'));
      if (receipt?.schemaVersion === LEGACY_RECEIPT_VERSION) {
        const errors = validateLegacyReceiptShape(receipt, entry.name);
        if (errors.length > 0) summary.reasons.push(`${entry.name}: ${errors.join(', ')}`);
        else summary.counts.legacy += 1;
        continue;
      }
      const errors = validateReceiptShape(receipt, entry.name);
      if (seen.has(receipt.receiptId)) errors.push('duplicate receiptId');
      seen.add(receipt.receiptId);
      if (errors.length > 0) {
        summary.reasons.push(`${entry.name}: ${errors.join(', ')}`);
        continue;
      }
      summary.receipts.push(receipt);
      if (receipt.status === 'continuation-requested') summary.counts.continuationRequested += 1;
      else summary.counts[receipt.status] += 1;
    } catch (error) {
      summary.reasons.push(`${entry.name}: ${error.message}`);
    }
  }
  summary.status = summary.reasons.length > 0 ? 'invalid' : 'healthy';
  return summary;
}

export function verifyReceiptIntegrity(receipt, filename) {
  return validateReceiptShape(receipt, filename);
}

export const subagentReceiptConstants = {
  fingerprintExclusions: [...FINGERPRINT_EXCLUSIONS],
  protectedEvidenceRoots: [...PROTECTED_EVIDENCE_ROOTS],
  requiredOutputFields: [...REQUIRED_OUTPUT_FIELDS],
  roles: [...RECEIPT_ROLES],
};
