import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { isAbsolute, relative, resolve, win32 } from 'node:path';

import { validateJsonAgainstSchema } from './schema-validation.mjs';

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const FIXED_FIELDS = [
  '版本', '编号', '类型', '来源角色', '目标角色', 'Agent/运行收据', '状态', '变更集指纹',
  '已完成', '未完成', '验证证据', '未验证项', '风险', '下一步', '恢复提示', '时间',
];
const ARRAY_FIELDS = ['已完成', '未完成', '验证证据', '未验证项', '风险'];
const EXCLUSIONS = ['.cognis/', 'docs/tasks/', 'docs/reviews/'];
const HANDOFF_IDENTITY_FIELDS = ['类型', '来源角色', '目标角色', 'Agent/运行收据', '变更集指纹'];
const TRANSITIONS = new Map([
  ['待接收', new Set(['已接收', '阻塞'])],
  ['已接收', new Set(['已返回', '阻塞'])],
  ['已返回', new Set()],
  ['阻塞', new Set()],
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function excluded(value) {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '');
  return EXCLUSIONS.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}

function git(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch {
    return null;
  }
}

function parseUntracked(status) {
  const result = [];
  const entries = status.split('\0').filter(Boolean);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code.includes('R') || code.includes('C')) index += 1;
    if (code === '??' && path && !excluded(path)) result.push(path);
  }
  return result.sort((left, right) => left.localeCompare(right));
}

function untrackedHash(root, item) {
  const target = resolve(root, item);
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) return `link:${item.replaceAll('\\', '/')}:${readlinkSync(target)}`;
  if (!stat.isFile()) return `other:${item.replaceAll('\\', '/')}:${stat.mode}`;
  return `file:${item.replaceAll('\\', '/')}:${sha256(readFileSync(target))}`;
}

export function computeWorkspaceFingerprintSync(root) {
  const repository = git(root, ['rev-parse', '--show-toplevel']);
  if (!repository || resolve(repository.trim()) !== resolve(root)) return 'unavailable';
  const head = git(root, ['rev-parse', 'HEAD']);
  const base = head?.trim() || 'UNBORN';
  const diff = git(root, head
    ? ['diff', '--binary', '--no-ext-diff', '--no-renames', 'HEAD', '--', '.', ':(exclude).cognis/**', ':(exclude)docs/tasks/**', ':(exclude)docs/reviews/**']
    : ['diff', '--cached', '--binary', '--no-ext-diff', '--no-renames', '--', '.', ':(exclude).cognis/**', ':(exclude)docs/tasks/**', ':(exclude)docs/reviews/**']);
  const status = git(root, ['-c', 'status.renames=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=no']);
  if (diff === null || status === null) return 'unavailable';
  return sha256(stableJson({ base, diff, untracked: parseUntracked(status).map((item) => untrackedHash(root, item)) }));
}

function receiptIntegrity(receipt) {
  const { integrityHash: _ignored, ...unsigned } = receipt;
  return sha256(`cognis-subagent-receipt-integrity-v${receipt.schemaVersion}\0${stableJson(unsigned)}`);
}

function safeReceipt(root, receiptPath) {
  const normalized = typeof receiptPath === 'string' ? receiptPath.replaceAll('\\', '/') : '';
  if (!/^\.cognis\/subagents\/receipts\/[a-f0-9]{64}\.json$/u.test(normalized)
    || isAbsolute(normalized) || win32.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    return { error: '运行收据必须是受支持的项目内相对路径' };
  }
  const target = resolve(root, normalized);
  const relation = relative(resolve(root), target);
  if (relation.startsWith('..') || isAbsolute(relation)) return { error: '运行收据路径逃逸项目边界' };
  let current = resolve(root);
  for (const segment of normalized.split('/')) {
    current = resolve(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) return { error: '运行收据路径不得经过符号链接' };
  }
  if (!existsSync(target)) return { error: `运行收据不存在：${normalized}` };
  try {
    return { receipt: JSON.parse(readFileSync(target, 'utf8')), target };
  } catch (error) {
    return { error: `运行收据 JSON 无效：${error.message}` };
  }
}

function safeProjectArtifact(root, artifactPath) {
  const normalized = typeof artifactPath === 'string' ? artifactPath.replaceAll('\\', '/') : '';
  if (!normalized || isAbsolute(normalized) || win32.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    return '人工等价核验证据必须是项目内相对路径';
  }
  const target = resolve(root, normalized);
  const relation = relative(resolve(root), target);
  if (relation.startsWith('..') || isAbsolute(relation)) return '人工等价核验证据路径逃逸项目边界';
  let current = resolve(root);
  for (const segment of normalized.split('/').filter(Boolean)) {
    current = resolve(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) return '人工等价核验证据路径不得经过符号链接';
  }
  if (!existsSync(target)) return `人工等价核验证据不存在：${normalized}`;
  const artifact = lstatSync(target);
  if (!artifact.isFile()) return '人工等价核验证据必须是常规文件';
  if (artifact.size === 0) return '人工等价核验证据不得为空';
  return null;
}

function normalizedIdentity(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').trim().toUpperCase().toLowerCase().normalize('NFKC')
    : '';
}

function validateManualEquivalent(control, handoffs, root) {
  const errors = [];
  const records = control?.['人工等价核验'];
  if (!Array.isArray(records)) return ['人工等价模式缺少“人工等价核验”记录'];
  const expected = new Map([['cognis_tester', '通过'], ['cognis_reviewer', '批准']]);
  const roles = new Set();
  const verifiers = new Set();
  const responsibleRole = normalizedIdentity(control?.['责任角色']);
  for (const [index, record] of records.entries()) {
    const label = `人工等价核验[${index}]`;
    if (!expected.has(record?.['角色'])) errors.push(`${label} 角色无效`);
    else if (roles.has(record['角色'])) errors.push(`${label} 角色重复`);
    else roles.add(record['角色']);
    const verifier = normalizedIdentity(record?.['核验者']);
    if (!verifier) errors.push(`${label} 缺少可追责核验者`);
    else {
      if (verifier === responsibleRole) errors.push(`${label} 核验者不得是实现者或责任角色`);
      if (verifiers.has(verifier)) errors.push(`${label} Tester 与 Reviewer 必须由不同核验者承担`);
      verifiers.add(verifier);
    }
    if (expected.has(record?.['角色']) && record?.['结论'] !== expected.get(record['角色'])) {
      errors.push(`${label} 结论必须为“${expected.get(record['角色'])}”`);
    }
    if (Number.isNaN(Date.parse(record?.['时间'] ?? ''))) errors.push(`${label} 时间无效`);
    const artifactError = safeProjectArtifact(root, record?.['证据']);
    if (artifactError) errors.push(`${label} ${artifactError}`);
    const handoff = handoffs.find((item) => item?.['类型'] === '子任务回传'
      && item?.['来源角色'] === record?.['角色']
      && item?.['Agent/运行收据'] === record?.['证据']
      && item?.['状态'] === '已返回');
    if (!handoff) errors.push(`${label} 缺少对应的已返回 Handoff`);
    else if (handoff['变更集指纹'] !== record?.['变更集指纹']) errors.push(`${label} 与 Handoff 变更集指纹不匹配`);
  }
  for (const role of expected.keys()) if (!roles.has(role)) errors.push(`人工等价核验缺少 ${role}`);
  return errors;
}

function validateReceipt(receipt, receiptPath, record, receiptSchema) {
  const errors = [];
  const filenameId = receiptPath.replaceAll('\\', '/').match(/([a-f0-9]{64})\.json$/u)?.[1];
  if (receiptSchema) errors.push(...validateJsonAgainstSchema(receipt, receiptSchema, '运行收据'));
  for (const field of ['receiptId', 'sessionIdHash', 'agentIdHash', 'turnIdHash', 'integrityHash']) {
    if (!HASH_PATTERN.test(receipt?.[field] ?? '')) errors.push(`运行收据 ${field} 无效`);
  }
  if (receipt?.schemaVersion !== 2 || receipt?.receiptId !== filenameId) errors.push('运行收据版本、编号或文件名不匹配');
  if (receipt?.status !== 'sealed' || receipt?.outputValidation?.status !== 'valid') errors.push('运行收据未合格封存');
  if (receipt?.role !== record['来源角色']) errors.push('运行收据角色与 Handoff 来源角色不匹配');
  const expectedConclusion = receipt?.role === 'cognis_tester' ? 'passed' : 'approved';
  if (receipt?.outputValidation?.conclusion !== expectedConclusion || receipt?.outputValidation?.missing?.length !== 0) {
    errors.push('运行收据角色结论未通过');
  }
  if (!Number.isInteger(receipt?.continuationCount) || receipt.continuationCount < 0 || receipt.continuationCount > 1) errors.push('运行收据续跑次数无效');
  if (receipt?.attestationScope !== 'project-local-tamper-evidence') errors.push('运行收据 attestation scope 无效');
  if (Number.isNaN(Date.parse(receipt?.startedAt ?? '')) || Number.isNaN(Date.parse(receipt?.completedAt ?? ''))
    || Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt)) errors.push('运行收据生命周期时间无效');
  if (Date.parse(record['时间']) < Date.parse(receipt?.completedAt ?? '')) errors.push('Handoff 时间早于运行收据完成时间');
  if (receipt?.startWorkspaceFingerprint !== receipt?.completedWorkspaceFingerprint
    || receipt?.completedWorkspaceFingerprint !== record['变更集指纹']) errors.push('运行收据起止指纹或 Handoff 变更集指纹不匹配');
  if (!HASH_PATTERN.test(receipt?.startEvidenceFingerprint ?? '')
    || receipt?.startEvidenceFingerprint !== receipt?.completedEvidenceFingerprint) errors.push('运行收据受保护证据指纹无效或已变化');
  if (receipt?.invalidReason !== undefined) errors.push('合格封存收据不得包含 invalidReason');
  if (HASH_PATTERN.test(receipt?.integrityHash ?? '') && receiptIntegrity(receipt) !== receipt.integrityHash) errors.push('运行收据 integrity hash 无效');
  return errors;
}

function evidenceTime(row) {
  const timestamp = Date.parse(row?.['核验时间']);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function hasSuccessfulCommandEvidence(evidence, command, minimumTime) {
  return (evidence ?? []).some((row) => row?.['证据类型'] === '命令'
    && row?.['命令或产物'] === command
    && String(row?.['退出码']) === '0'
    && evidenceTime(row) !== null
    && evidenceTime(row) > minimumTime);
}

export function validateHandoffRecords({ control, currentFingerprint, evidence = [], file, handoffSchema, handoffs, receiptSchema, root }) {
  const errors = [];
  if (control?.['控制版本'] !== 3) return errors;
  if (!Array.isArray(handoffs)) return [`${file}：v3 任务缺少“交接记录”JSON 数组`];
  const histories = new Map();
  const receiptOwners = new Map();
  const verificationReceipts = new Map();
  const manualMode = control?.['独立核验模式'] === '人工等价';
  if (manualMode) errors.push(...validateManualEquivalent(control, handoffs, root).map((error) => `${file}：${error}`));
  for (const [index, record] of handoffs.entries()) {
    const label = `${file}：交接记录[${index}]`;
    if (handoffSchema) for (const error of validateJsonAgainstSchema(record, handoffSchema, '交接记录')) errors.push(`${label} ${error}`);
    for (const field of FIXED_FIELDS) if (!Object.hasOwn(record ?? {}, field)) errors.push(`${label} 缺少“${field}”`);
    for (const field of ARRAY_FIELDS) if (!Array.isArray(record?.[field])) errors.push(`${label} “${field}”必须是数组`);
    if (record?.['版本'] !== 1) errors.push(`${label} 版本必须为 1`);
    if (!['阶段交接', '子任务回传', '暂停恢复'].includes(record?.['类型'])) errors.push(`${label} 类型无效`);
    if (!['待接收', '已接收', '已返回', '阻塞'].includes(record?.['状态'])) errors.push(`${label} 状态无效`);
    if (Number.isNaN(Date.parse(record?.['时间'] ?? ''))) errors.push(`${label} 时间无效`);
    if (!record?.['编号']) continue;
    const history = histories.get(record['编号']) ?? [];
    const previous = history.at(-1);
    if (!previous && record['状态'] !== '待接收') errors.push(`${label} 首个状态必须为“待接收”`);
    if (previous && !TRANSITIONS.get(previous['状态'])?.has(record['状态'])) {
      errors.push(`${label} 非法状态转换：${previous['状态']} -> ${record['状态']}`);
    }
    if (previous) {
      for (const field of HANDOFF_IDENTITY_FIELDS) {
        if (record[field] !== previous[field]) errors.push(`${label} Handoff 身份字段“${field}”不得改变`);
      }
    }
    if (previous && Date.parse(record['时间']) <= Date.parse(previous['时间'])) errors.push(`${label} 状态时间必须递增`);
    history.push(record);
    histories.set(record['编号'], history);

    if (record['类型'] !== '子任务回传') continue;
    const receiptPath = record['Agent/运行收据'];
    const owner = receiptOwners.get(receiptPath);
    if (owner && owner !== record['编号']) errors.push(`${label} 运行收据被不同 Handoff 重复引用`);
    receiptOwners.set(receiptPath, record['编号']);
    if (!manualMode && record['状态'] === '已返回') {
      const loaded = safeReceipt(root, receiptPath);
      if (loaded.error) errors.push(`${label} ${loaded.error}`);
      else {
        errors.push(...validateReceipt(loaded.receipt, receiptPath, record, receiptSchema).map((error) => `${label} ${error}`));
        verificationReceipts.set(record['来源角色'], loaded.receipt);
      }
    }
  }
  const status = control?._taskStatus;
  if (['等待人工', '等待依赖', '阻塞'].includes(status)) {
    const resume = handoffs.some((record) => record?.['类型'] === '暂停恢复' && ['待接收', '已接收', '阻塞'].includes(record?.['状态']));
    if (!resume) errors.push(`${file}：暂停或等待的 v3 任务缺少有效“暂停恢复”Handoff`);
  }
  if (control?._taskResult === '完成') {
    const fingerprint = currentFingerprint ?? computeWorkspaceFingerprintSync(root);
    const verificationTimes = [];
    if (manualMode) {
      for (const record of control['人工等价核验'] ?? []) {
        if (fingerprint === 'unavailable' || record?.['变更集指纹'] !== fingerprint) {
          errors.push(`${file}：${record?.['角色'] ?? '人工等价核验'} 的变更集指纹已失效，必须重新核验`);
        }
        const timestamp = Date.parse(record?.['时间'] ?? '');
        if (!Number.isNaN(timestamp)) verificationTimes.push(timestamp);
      }
    }
    for (const role of ['cognis_tester', 'cognis_reviewer']) {
      const returned = [...handoffs].reverse().find((record) => record?.['类型'] === '子任务回传'
        && record?.['来源角色'] === role && record?.['状态'] === '已返回');
      const label = role === 'cognis_tester' ? 'Tester' : 'Reviewer';
      if (!returned) errors.push(`${file}：完整 v3 任务缺少 ${label} 的有效回传`);
      else if (fingerprint === 'unavailable' || returned['变更集指纹'] !== fingerprint) errors.push(`${file}：${label} 的变更集指纹已失效，必须重新核验`);
      const completedAt = Date.parse(verificationReceipts.get(role)?.completedAt ?? '');
      if (!manualMode && !Number.isNaN(completedAt)) verificationTimes.push(completedAt);
    }
    if (['单任务', '父任务'].includes(control?.['任务类型'])) {
      const integrationCommands = control?.['集成验证'];
      if (!Array.isArray(integrationCommands) || integrationCommands.length === 0) {
        errors.push(`${file}：完整 v3 任务缺少 fan-in 后“集成验证”命令`);
      } else if (verificationTimes.length >= 2) {
        const minimumTime = Math.max(...verificationTimes);
        for (const command of integrationCommands) {
          if (!hasSuccessfulCommandEvidence(evidence, command, minimumTime)) {
            errors.push(`${file}：集成验证缺少 Tester/Reviewer 回传后的本轮成功证据：${command}`);
          }
        }
      }
    }
  }
  return errors;
}
