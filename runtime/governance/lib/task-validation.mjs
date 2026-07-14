import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, resolve, win32 } from 'node:path';

import { validateJsonAgainstSchema } from './schema-validation.mjs';
import { validateRedTeamReview } from './red-team-validation.mjs';

const FIELD_VALUES = {
  工作流档位: new Set(['快速', '轻量', '完整']),
  当前阶段: new Set(['获取事实', '做出决策', '执行', '验证', '交付']),
  当前状态: new Set(['空闲', '进行中', '阻塞', '等待人工', '等待依赖', '验证失败']),
  处理结果: new Set(['开放', '完成', '不做', '重复', '取消']),
};

function section(body, name) {
  const lines = body.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() === `## ${name}`);
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && /^##\s+/u.test(line.trim()));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

function substantive(value) {
  return typeof value === 'string' && value.trim().length > 0 && !/^(?:待定|无|TODO|TBD)$/iu.test(value.trim());
}

function parseFields(body) {
  const fields = {};
  const preamble = body.split(/^##\s+/mu, 1)[0];
  for (const match of preamble.matchAll(/^-\s*([^：:\r\n]+)[：:]\s*(.+)$/gmu)) {
    fields[match[1].trim()] = match[2].trim();
  }
  return fields;
}

function parseTable(sectionBody) {
  if (!sectionBody) return { headers: [], rows: [] };
  const rows = sectionBody.split(/\r?\n/u)
    .filter((line) => /^\s*\|.*\|\s*$/u.test(line))
    .map((line) => line.trim().slice(1, -1).split('|').map((cell) => cell.trim()));
  if (rows.length < 2) return { headers: [], rows: [] };
  return { headers: rows[0], rows: rows.slice(2).filter((row) => row.some(substantive)) };
}

function rowObjects(table) {
  return table.rows.map((row) => Object.fromEntries(table.headers.map((header, index) => [header, row[index] ?? ''])));
}

function parseControl(body, file, errors) {
  const controlSection = section(body, '完整流程控制');
  if (!controlSection) {
    errors.push(`${file}：完整任务缺少“完整流程控制”区块`);
    return null;
  }
  const block = controlSection.match(/```json\s*([\s\S]*?)```/u);
  if (!block) {
    errors.push(`${file}：“完整流程控制”必须包含 json 代码块`);
    return null;
  }
  try {
    return JSON.parse(block[1]);
  } catch (error) {
    errors.push(`${file}：“完整流程控制”JSON 无效：${error.message}`);
    return null;
  }
}

function validateArtifact(root, artifact) {
  const normalized = artifact.replaceAll('\\', '/');
  if (!artifact || isAbsolute(artifact) || win32.isAbsolute(artifact) || normalized.split('/').includes('..')) return '必须是项目内相对路径';
  if (!existsSync(resolve(root, artifact))) return `产物不存在：${artifact}`;
  return null;
}

function validateTask(root, file, body, schema) {
  const errors = [];
  const title = body.match(/^#\s+(\S+)\s+(.+)$/mu);
  if (!title) errors.push(`${file}：缺少“# <任务编号> <标题>”`);
  const fields = parseFields(body);
  for (const [name, allowed] of Object.entries(FIELD_VALUES)) {
    if (!fields[name]) errors.push(`${file}：缺少字段“${name}”`);
    else if (!allowed.has(fields[name])) errors.push(`${file}：字段“${name}”的值无效：${fields[name]}`);
  }
  for (const name of ['目标', '验收标准', '验证计划', '下一步动作']) {
    if (!substantive(section(body, name))) errors.push(`${file}：缺少或未填写“${name}”区块`);
  }

  const criteria = rowObjects(parseTable(section(body, '验收标准')));
  const criterionIds = criteria.map((row) => row['AC-ID']).filter(substantive);
  if (criteria.length === 0 || criterionIds.length !== criteria.length || criteria.some((row) => !substantive(row['标准']))) {
    errors.push(`${file}：“验收标准”必须使用 AC-ID 和标准两列表格`);
  }
  if (new Set(criterionIds).size !== criterionIds.length) errors.push(`${file}：验收标准 AC-ID 不得重复`);

  if (fields['当前状态'] === '阻塞') {
    for (const name of ['阻塞原因', '恢复提示']) if (!substantive(section(body, name))) errors.push(`${file}：阻塞任务缺少“${name}”`);
  } else if (['等待人工', '等待依赖'].includes(fields['当前状态']) && !substantive(section(body, '恢复提示'))) {
    errors.push(`${file}：等待任务缺少“恢复提示”`);
  }
  if (fields['工作流档位'] === '轻量' && !substantive(section(body, '写入范围'))) errors.push(`${file}：轻量任务缺少“写入范围”`);

  let control = null;
  if (fields['工作流档位'] === '完整') {
    control = parseControl(body, file, errors);
    if (control) {
      for (const error of validateJsonAgainstSchema(control, schema, '完整流程控制')) errors.push(`${file}：${error}`);
      if (['父任务', '子任务'].includes(control['任务类型'])) {
        if (!substantive(control['父任务编号']) && control['任务类型'] === '子任务') errors.push(`${file}：子任务缺少“父任务编号”`);
        if (!Number.isInteger(control['时间盒分钟']) || control['时间盒分钟'] < 1) errors.push(`${file}：父子任务缺少有效“时间盒分钟”`);
        if (!Array.isArray(control['冲突任务'])) errors.push(`${file}：父子任务缺少“冲突任务”数组`);
      }
    }
  }

  if (fields['处理结果'] === '完成') {
    if (!section(body, '剩余风险')?.trim()) errors.push(`${file}：完成任务缺少“剩余风险”`);
    const evidence = rowObjects(parseTable(section(body, '验收证据')));
    if (evidence.length === 0) errors.push(`${file}：完成任务缺少“验收证据”`);
    for (const row of evidence) {
      const criterionId = row['AC-ID'];
      if (!criterionIds.includes(criterionId)) errors.push(`${file}：验收证据引用未知 AC-ID：${criterionId}`);
      if (!['命令', '产物', '人工', '审查'].includes(row['证据类型'])) errors.push(`${file}：${criterionId} 的证据类型必须是命令、产物、人工或审查`);
      if (!substantive(row['命令或产物'])) errors.push(`${file}：${criterionId} 缺少“命令或产物”`);
      if (!substantive(row['核验时间']) || Number.isNaN(Date.parse(row['核验时间']))) errors.push(`${file}：${criterionId} 缺少有效核验时间`);
      if (!substantive(row['核验者']) || !substantive(row['实际结果'])) errors.push(`${file}：${criterionId} 缺少核验者或实际结果`);
      if (row['证据类型'] === '命令' && row['退出码'] !== '0') errors.push(`${file}：${criterionId} 命令证据退出码必须为 0`);
      if (row['证据类型'] === '产物') {
        const artifactError = validateArtifact(root, row['命令或产物']);
        if (artifactError) errors.push(`${file}：${criterionId} ${artifactError}`);
      }
    }
    for (const criterionId of criterionIds) if (!evidence.some((row) => row['AC-ID'] === criterionId)) errors.push(`${file}：${criterionId} 没有验收证据`);
    if (control) {
      if (control['人工确认'] === '需要') errors.push(`${file}：完成任务的人工确认不得为“需要”`);
      if (control['责任角色'] === control['核验者']) errors.push(`${file}：完整任务的核验者不得与实现者相同`);
      if (control['合并回主线状态'] === '待处理') errors.push(`${file}：完成任务仍有待处理的合并回主线状态`);
      errors.push(...validateRedTeamReview({ control, root, taskFile: file, taskId: title?.[1] }));
    }
  }
  return errors;
}

export function validateTasks(root) {
  const tasksRoot = resolve(root, 'docs/tasks');
  if (!existsSync(tasksRoot)) return [];
  const errors = [];
  let schema;
  try {
    schema = JSON.parse(readFileSync(resolve(root, 'docs/schemas/full-task-control.schema.json'), 'utf8'));
  } catch (error) {
    return [`完整流程控制 schema 无效：${error.message}`];
  }
  for (const entry of readdirSync(tasksRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = resolve(entry.parentPath ?? entry.path, entry.name);
    const relative = file.slice(root.length + 1).replaceAll('\\', '/');
    if (entry.name === 'task.json') {
      errors.push(`${relative}：不再支持 task.json，请迁移为中文 Markdown 任务合同`);
    } else if (entry.name.endsWith('.md')) {
      errors.push(...validateTask(root, relative, readFileSync(file, 'utf8'), schema));
    }
  }
  return errors;
}
