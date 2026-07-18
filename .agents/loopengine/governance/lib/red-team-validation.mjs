import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';

const CONCLUSIONS = new Set(['待审查', '批准', '要求修改', '缺少证据而阻塞']);
const SEVERITIES = new Set(['Critical', 'High', 'Medium', 'Low']);
const STATUSES = new Set(['开放', '已修复', '延期']);

function substantive(value) {
  return typeof value === 'string' && value.trim().length > 0 && !/^(?:待定|无|TODO|TBD)$/iu.test(value.trim());
}

function sameIdentity(left, right) {
  if (!substantive(left) || !substantive(right)) return false;
  return left.normalize('NFKC').trim().toLowerCase() === right.normalize('NFKC').trim().toLowerCase();
}

function outsideRoot(relativePath) {
  return relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
}

function maskCodeBlocks(body) {
  let fence = null;
  return body.split(/\r?\n/u).map((line) => {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/u);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence.character && fenceMatch[1].length >= fence.length) fence = null;
      return '';
    }
    if (fenceMatch) {
      fence = { character: fenceMatch[1][0], length: fenceMatch[1].length };
      return '';
    }
    return /^(?: {4}|\t)/u.test(line) ? '' : line;
  }).join('\n');
}

function section(body, name, structuralBody = body) {
  const lines = body.split(/\r?\n/u);
  const structuralLines = structuralBody.split(/\r?\n/u);
  const start = structuralLines.findIndex((line) => line.trim() === `## ${name}`);
  if (start < 0) return null;
  const end = structuralLines.findIndex((line, index) => index > start && /^##\s+/u.test(line.trim()));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

function sectionCount(body, name) {
  return body.split(/\r?\n/u).filter((line) => line.trim() === `## ${name}`).length;
}

function parseFields(body) {
  const fields = {};
  const duplicates = new Set();
  const preamble = body.split(/^##\s+/mu, 1)[0];
  for (const match of preamble.matchAll(/^-\s*([^：:\r\n]+)[：:]\s*(.+)$/gmu)) {
    const name = match[1].trim();
    if (Object.hasOwn(fields, name)) duplicates.add(name);
    fields[name] = match[2].trim();
  }
  return { duplicates, fields };
}

function parseTable(sectionBody) {
  if (!sectionBody) return { headers: [], rows: [], validRowWidths: false, validSeparator: false };
  const rows = sectionBody.split(/\r?\n/u)
    .filter((line) => /^\s*\|.*\|\s*$/u.test(line))
    .map((line) => line.trim().slice(1, -1).split('|').map((cell) => cell.trim()));
  const headers = rows[0] ?? [];
  const separator = rows[1] ?? [];
  const validSeparator = headers.length > 0
    && separator.length === headers.length
    && separator.every((cell) => /^:?-{3,}:?$/u.test(cell));
  const dataRows = validSeparator ? rows.slice(2).filter((row) => row.some(substantive)) : [];
  return {
    headers,
    rows: dataRows,
    validRowWidths: validSeparator && dataRows.every((row) => row.length === headers.length),
    validSeparator,
  };
}

function rowObjects(table) {
  return table.rows.map((row) => Object.fromEntries(table.headers.map((header, index) => [header, row[index] ?? ''])));
}

function sameColumns(actual, expected) {
  return actual.length === expected.length && actual.every((column, index) => column === expected[index]);
}

function resolveReviewPacket(root, artifact) {
  const normalized = typeof artifact === 'string' ? artifact.replaceAll('\\', '/') : '';
  if (!substantive(artifact)
    || isAbsolute(artifact)
    || win32.isAbsolute(artifact)
    || normalized.split('/').includes('..')
    || !normalized.toLowerCase().endsWith('.md')) {
    return { error: '红队审查包必须是项目内相对路径（Markdown）' };
  }
  const candidate = resolve(root, artifact);
  const lexicalRelative = relative(resolve(root), candidate);
  if (outsideRoot(lexicalRelative)) {
    return { error: '红队审查包必须是项目内相对路径（Markdown）' };
  }
  if (!existsSync(candidate)) return { error: `红队审查包产物不存在：${artifact}` };
  try {
    if (!statSync(candidate).isFile()) return { error: '红队审查包必须是文件' };
    const realRelative = relative(realpathSync(root), realpathSync(candidate));
    if (outsideRoot(realRelative)) {
      return { error: '红队审查包必须位于项目目录内' };
    }
    return { body: readFileSync(candidate, 'utf8') };
  } catch (error) {
    return { error: `红队审查包无法读取：${error.code ?? error.message}` };
  }
}

function validateFindings(body, prefix) {
  const errors = [];
  const findingsTable = parseTable(section(body, '问题列表'));
  const requiredFindingHeaders = ['问题编号', '严重度', '状态', '位置', '触发方式', '影响', '最小修复方向'];
  if (!findingsTable.validSeparator) {
    return [`${prefix}Red Team 审查包“问题列表”Markdown separator 无效`];
  }
  if (!sameColumns(findingsTable.headers, requiredFindingHeaders)) {
    return [`${prefix}Red Team 审查包“问题列表”表头必须严格匹配规范`];
  }
  if (!findingsTable.validRowWidths) {
    return [`${prefix}Red Team 审查包“问题列表”每行列数必须与表头一致`];
  }
  const deferralsTable = parseTable(section(body, 'Medium 延期'));
  const requiredDeferralHeaders = ['问题编号', '理由', '责任人', '关闭条件', '批准者'];
  let deferrals = [];
  if (!deferralsTable.validSeparator) {
    errors.push(`${prefix}Red Team 审查包“Medium 延期”Markdown separator 无效`);
  } else if (!sameColumns(deferralsTable.headers, requiredDeferralHeaders)) {
    errors.push(`${prefix}Red Team 审查包“Medium 延期”表头必须严格匹配规范`);
  } else if (!deferralsTable.validRowWidths) {
    errors.push(`${prefix}Red Team 审查包“Medium 延期”每行列数必须与表头一致`);
  } else {
    deferrals = rowObjects(deferralsTable);
  }
  const findings = rowObjects(findingsTable);
  const findingIds = new Set();
  const deferralIds = new Set();
  for (const deferral of deferrals) {
    const id = deferral['问题编号'];
    if (!substantive(id) || requiredDeferralHeaders.slice(1).some((header) => !substantive(deferral[header]))) {
      errors.push(`${prefix}Red Team Medium 延期记录必须完整填写`);
      continue;
    }
    if (deferralIds.has(id)) errors.push(`${prefix}Red Team Medium 延期问题编号重复：${id}`);
    deferralIds.add(id);
  }
  for (const finding of findings) {
    const id = finding['问题编号'];
    const severity = finding['严重度'];
    const status = finding['状态'];
    if (!substantive(id) || requiredFindingHeaders.slice(1).some((header) => !substantive(finding[header]))) {
      errors.push(`${prefix}Red Team finding 必须完整填写`);
      continue;
    }
    if (findingIds.has(id)) errors.push(`${prefix}Red Team 问题编号重复：${id}`);
    findingIds.add(id);
    if (!SEVERITIES.has(severity)) errors.push(`${prefix}${id} 的 Red Team 严重度无效：${severity}`);
    if (!STATUSES.has(status)) errors.push(`${prefix}${id} 的 Red Team 状态无效：${status}`);
    if (['Critical', 'High'].includes(severity) && status !== '已修复') {
      errors.push(`${prefix}${id} ${severity} finding 必须已修复`);
    }
    if (severity === 'Medium' && !['已修复', '延期'].includes(status)) {
      errors.push(`${prefix}${id} Medium finding 必须已修复或延期`);
    }
    if (severity === 'Medium' && status === '延期' && !deferralIds.has(id)) {
      errors.push(`${prefix}${id} Medium finding 缺少完整延期记录`);
    }
  }
  return errors;
}

export function validateRedTeamReview({ control, root, taskFile, taskId }) {
  const prefix = `${taskFile}：`;
  const errors = [];
  for (const field of ['红队审查者', '红队审查包', '红队审查结论']) {
    if (!substantive(control[field])) errors.push(`${prefix}完成的完整任务缺少“${field}”`);
  }
  if (sameIdentity(control['红队审查者'], control['责任角色'])) {
    errors.push(`${prefix}完整任务的红队审查者不得与实现者相同`);
  }
  if (substantive(control['红队审查结论']) && control['红队审查结论'] !== '批准') {
    errors.push(`${prefix}完成任务的红队审查结论必须为“批准”`);
  }
  if (!substantive(control['红队审查包'])) return errors;
  const packet = resolveReviewPacket(root, control['红队审查包']);
  if (packet.error) return [...errors, `${prefix}${packet.error}`];

  const body = packet.body;
  const structuralBody = maskCodeBlocks(body);
  if (/<!--|-->/u.test(structuralBody)) return [...errors, `${prefix}Red Team 审查包不得包含 HTML 注释`];
  if (/<\/?[A-Za-z][\s\S]*?>|<\?|<!\[CDATA\[|<![A-Z]/iu.test(structuralBody)) {
    return [...errors, `${prefix}Red Team 审查包不得包含 raw HTML`];
  }
  const requiredSections = ['审查范围', '问题列表', 'Medium 延期', '已核验证据', '未覆盖审查轴与剩余风险', '结论'];
  const sectionErrors = requiredSections
    .filter((name) => sectionCount(structuralBody, name) !== 1)
    .map((name) => `${prefix}Red Team 审查包“${name}”区块必须且只能出现一次`);
  if (sectionErrors.length > 0) return [...errors, ...sectionErrors];
  const parsedFields = parseFields(structuralBody);
  const fields = parsedFields.fields;
  for (const field of ['任务编号', '审查者', '审查对象', '审查时间']) {
    if (!substantive(fields[field])) errors.push(`${prefix}Red Team 审查包缺少“${field}”`);
    if (parsedFields.duplicates.has(field)) errors.push(`${prefix}Red Team 审查包“${field}”必须且只能出现一次`);
  }
  if (fields['任务编号'] !== taskId) errors.push(`${prefix}Red Team 审查包任务编号与任务合同不一致`);
  if (!sameIdentity(fields['审查者'], control['红队审查者'])) errors.push(`${prefix}Red Team 审查包审查者与任务合同不一致`);
  if (substantive(fields['审查时间']) && Number.isNaN(Date.parse(fields['审查时间']))) {
    errors.push(`${prefix}Red Team 审查包缺少有效审查时间`);
  }
  for (const name of ['审查范围', '已核验证据', '未覆盖审查轴与剩余风险']) {
    if (!substantive(section(body, name, structuralBody))) errors.push(`${prefix}Red Team 审查包缺少或未填写“${name}”`);
  }
  const conclusion = section(structuralBody, '结论')?.trim();
  if (!CONCLUSIONS.has(conclusion)) errors.push(`${prefix}Red Team 审查包结论无效`);
  if (conclusion !== control['红队审查结论']) errors.push(`${prefix}Red Team 审查包结论与任务合同不一致`);
  errors.push(...validateFindings(structuralBody, prefix));
  return errors;
}
