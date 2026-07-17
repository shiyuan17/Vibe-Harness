import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, resolve, win32 } from 'node:path';

import { validateJsonAgainstSchema } from './schema-validation.mjs';
import { validateRedTeamReview } from './red-team-validation.mjs';

const FIELD_VALUES = {
  工作流档位: new Set(['快速', '轻量', '完整']),
  当前阶段: new Set(['获取事实', '做出决策', '执行', '验证', '交付']),
  当前状态: new Set(['空闲', '进行中', '阻塞', '等待人工', '等待依赖', '验证失败']),
  处理结果: new Set(['开放', '完成', '不做', '重复', '取消']),
};

const FIELD_ALIASES = {
  'Workflow tier': '工作流档位',
  'Current phase': '当前阶段',
  'Current status': '当前状态',
  Result: '处理结果',
};

const FIELD_ENUMS = {
  工作流档位: { 快速: 'fast', 轻量: 'lightweight', 完整: 'full' },
  当前阶段: { 获取事实: 'facts', 做出决策: 'decision', 执行: 'execution', 验证: 'verification', 交付: 'delivery' },
  当前状态: { 空闲: 'idle', 进行中: 'in_progress', 阻塞: 'blocked', 等待人工: 'awaiting_human', 等待依赖: 'awaiting_dependency', 验证失败: 'verification_failed' },
  处理结果: { 开放: 'open', 完成: 'completed', 不做: 'wont_do', 重复: 'duplicate', 取消: 'cancelled' },
};

const SECTION_ALIASES = {
  目标: ['目标', 'Goal'],
  约束: ['约束', 'Constraints'],
  写入范围: ['写入范围', 'Write scope'],
  验收标准: ['验收标准', 'Acceptance criteria'],
  验证计划: ['验证计划', 'Verification plan'],
  下一步动作: ['下一步动作', 'Next action'],
  评测映射: ['评测映射', 'Evaluation mapping'],
  完整流程控制: ['完整流程控制', 'Full workflow control'],
  阻塞原因: ['阻塞原因', 'Blocker'],
  恢复提示: ['恢复提示', 'Resume hint'],
  剩余风险: ['剩余风险', 'Residual risks'],
  验收证据: ['验收证据', 'Acceptance evidence'],
};

const TABLE_HEADER_ALIASES = {
  Standard: '标准',
  'Evidence type': '证据类型',
  'Command or artifact': '命令或产物',
  'Verified at': '核验时间',
  Verifier: '核验者',
  'Actual result': '实际结果',
  'Exit code': '退出码',
  'Eval-ID': 'Eval-ID',
  'AC-ID': 'AC-ID',
};

function section(body, name) {
  const lines = body.split(/\r?\n/u);
  const names = SECTION_ALIASES[name] ?? [name];
  const start = lines.findIndex((line) => names.some((candidate) => line.trim() === `## ${candidate}`));
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
    const rawName = match[1].trim();
    const name = FIELD_ALIASES[rawName] ?? rawName;
    const rawValue = match[2].trim();
    const valueAliases = FIELD_ENUMS[name] ?? {};
    const canonicalValue = Object.entries(valueAliases).find(([, normalized]) => normalized === rawValue)?.[0] ?? rawValue;
    fields[name] = canonicalValue;
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
  return table.rows.map((row) => Object.fromEntries(table.headers.map((header, index) => {
    const canonicalHeader = TABLE_HEADER_ALIASES[header] ?? header;
    const rawValue = row[index] ?? '';
    const value = canonicalHeader === '证据类型'
      ? ({ command: '命令', artifact: '产物', manual: '人工', review: '审查', evaluation: '评测' }[rawValue] ?? rawValue)
      : rawValue;
    return [canonicalHeader, value];
  })));
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
  const target = resolve(root, artifact);
  let current = root;
  for (const segment of normalized.split('/').filter(Boolean)) {
    current = resolve(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) return '产物路径不得经过符号链接';
  }
  if (!existsSync(target)) return `产物不存在：${artifact}`;
  return null;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function round(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function validateRunAggregates(run, suite) {
  const errors = [];
  const dimensions = ['correctness', 'safety', 'evidenceQuality', 'efficiency'];
  const definitions = new Map(suite.cases.map((item) => [item.id, item]));
  for (const result of run.cases) {
    const definition = definitions.get(result.id);
    if (!definition) {
      errors.push(`评测 run 包含 suite 未定义案例：${result.id}`);
      continue;
    }
    const dimensionScores = Object.fromEntries(dimensions.map((dimension) => {
      const assertions = result.assertions.filter((item) => item.dimension === dimension);
      return [dimension, assertions.length === 0 ? 1 : round(assertions.filter((item) => item.passed).length / assertions.length)];
    }));
    const weight = dimensions.reduce((total, dimension) => total + definition.weights[dimension], 0);
    const score = round(dimensions.reduce((total, dimension) => total + dimensionScores[dimension] * definition.weights[dimension], 0) / weight);
    const criticalAssertions = result.assertions.filter((item) => item.critical).length;
    const criticalFailures = result.assertions.filter((item) => item.critical && !item.passed).length;
    if (result.capability !== definition.capability
      || result.weight !== weight
      || result.score !== score
      || stableJson(result.dimensionScores) !== stableJson(dimensionScores)
      || result.criticalAssertions !== criticalAssertions
      || result.criticalFailures !== criticalFailures
      || result.passed !== (criticalFailures === 0)) errors.push(`评测 run 案例聚合不一致：${result.id}`);
  }
  const grouped = new Map();
  for (const result of run.cases) grouped.set(result.capability, [...(grouped.get(result.capability) ?? []), result]);
  const capabilities = [...grouped].sort(([left], [right]) => left.localeCompare(right)).map(([id, cases]) => {
    const totalWeight = cases.reduce((total, item) => total + item.weight, 0);
    return { id, caseCount: cases.length, passedCount: cases.filter((item) => item.passed).length, score: round(cases.reduce((total, item) => total + item.score * item.weight, 0) / totalWeight) };
  });
  const criticalAssertions = run.cases.reduce((total, item) => total + item.criticalAssertions, 0);
  const criticalFailures = run.cases.reduce((total, item) => total + item.criticalFailures, 0);
  const overallScore = round(capabilities.reduce((total, item) => total + item.score, 0) / capabilities.length);
  const criticalPassRate = criticalAssertions === 0 ? 1 : round((criticalAssertions - criticalFailures) / criticalAssertions);
  if (stableJson(run.capabilities) !== stableJson(capabilities) || run.overallScore !== overallScore || run.criticalPassRate !== criticalPassRate) {
    errors.push('评测 run 总体聚合不一致');
  }
  return errors;
}

function validateEvaluationArtifact(root, artifact, evalId) {
  const artifactError = validateArtifact(root, artifact);
  if (artifactError) return [artifactError];
  const normalized = artifact.replaceAll('\\', '/');
  if (!normalized.startsWith('.loopengine/evals/runs/') || !normalized.endsWith('.json')) {
    return ['评测证据必须指向 .loopengine/evals/runs/ 下的 run JSON'];
  }
  let run;
  let runSchema;
  try {
    run = JSON.parse(readFileSync(resolve(root, artifact), 'utf8'));
    runSchema = JSON.parse(readFileSync(resolve(root, 'docs/schemas/eval-run.schema.json'), 'utf8'));
  } catch (error) {
    return [`评测 run 或 schema JSON 无效：${error.message}`];
  }
  const errors = validateJsonAgainstSchema(run, runSchema, '评测 run');
  if (run?.schemaVersion !== 1 || run?.status !== 'passed') errors.push('评测 run 必须是 schemaVersion 1 且状态为 passed');
  if (run?.reference?.status !== 'matched') errors.push('评测 run 的 reference 状态必须为 matched');
  const relatedPaths = [
    ['suite', run?.suite?.path],
    ['reference', run?.reference?.path],
  ];
  for (const [label, relatedPath] of relatedPaths) {
    const relatedError = validateArtifact(root, relatedPath ?? '');
    if (relatedError) errors.push(`评测 ${label} ${relatedError}`);
  }
  let suite;
  let reference;
  let config = {};
  if (errors.length === 0) {
    try {
      suite = JSON.parse(readFileSync(resolve(root, run.suite.path), 'utf8'));
      reference = JSON.parse(readFileSync(resolve(root, run.reference.path), 'utf8'));
      const suiteSchema = JSON.parse(readFileSync(resolve(root, 'docs/schemas/eval-suite.schema.json'), 'utf8'));
      const referenceSchema = JSON.parse(readFileSync(resolve(root, 'docs/schemas/eval-reference.schema.json'), 'utf8'));
      errors.push(...validateJsonAgainstSchema(suite, suiteSchema, '评测 suite'));
      errors.push(...validateJsonAgainstSchema(reference, referenceSchema, '评测 reference'));
      try { config = JSON.parse(readFileSync(resolve(root, 'loopengine.config.json'), 'utf8')); } catch {}
    } catch (error) {
      errors.push(`评测 suite、reference 或 schema JSON 无效：${error.message}`);
    }
  }
  if (suite && reference && errors.length === 0) {
    const hash = createHash('sha256').update(stableJson(suite)).digest('hex');
    if (run.suite.id !== suite.id || run.suite.version !== suite.version || run.suite.hash !== hash || run.fingerprint.suiteHash !== hash) {
      errors.push('评测 run 与 suite 标识或 hash 不一致');
    }
    if (reference.suite.id !== run.suite.id
      || reference.suite.version !== run.suite.version
      || reference.mode !== run.mode
      || stableJson(reference.fingerprint) !== stableJson(run.fingerprint)) errors.push('评测 run 与 reference fingerprint 不一致');
    const configuredRepetitions = config.evaluations?.repetitions ?? 3;
    const expectedRepetitions = new Map(suite.cases.map((item) => [
      item.id,
      run.mode === 'offline' ? 1 : Math.min(item.repetitions ?? suite.defaultRepetitions, configuredRepetitions),
    ]));
    const declaredRepetitions = new Map(run.caseRepetitions.map((item) => [item.id, item.count]));
    if (declaredRepetitions.size !== run.caseRepetitions.length
      || expectedRepetitions.size !== declaredRepetitions.size
      || [...expectedRepetitions].some(([id, count]) => declaredRepetitions.get(id) !== count)
      || [...expectedRepetitions].some(([id, count]) => run.cases.filter((item) => item.id === id).length !== count)) {
      errors.push('评测 run 的案例重复次数与 suite/config 不一致');
    }
    errors.push(...validateRunAggregates(run, suite));
    const thresholds = config.evaluations?.thresholds ?? { criticalPassRate: 1, overallScore: 0.9, maxCapabilityRegression: 0.05 };
    if (run.criticalPassRate < thresholds.criticalPassRate || run.overallScore < thresholds.overallScore) errors.push('评测 run 未达到项目绝对阈值');
    const referenceCapabilities = new Map(reference.capabilities.map((item) => [item.id, item.score]));
    if (run.capabilities.some((item) => (referenceCapabilities.get(item.id) ?? item.score) - item.score > thresholds.maxCapabilityRegression)) {
      errors.push('评测 run 的能力域回归超过阈值');
    }
  }
  const results = Array.isArray(run?.cases) ? run.cases.filter((item) => item?.id === evalId) : [];
  const repetitions = Array.isArray(run?.caseRepetitions)
    ? run.caseRepetitions.filter((item) => item?.id === evalId)
    : [];
  if (repetitions.length !== 1
    || results.length !== repetitions[0]?.count
    || results.some((item) => !item?.passed)) {
    errors.push(`评测 run 缺少全部通过的案例重复：${evalId}`);
  }
  return errors;
}

function validateChildHandoff(control, file) {
  const errors = [];
  for (const name of ['输入', '输出格式', '不得修改范围']) {
    const value = control[name];
    if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
      errors.push(`${file}：子任务缺少或未填写“${name}”`);
    }
  }
  return errors;
}

export function parseTaskMarkdown(file, body) {
  const fields = parseFields(body);
  const parseErrors = [];
  const sectionNames = [
    '目标', '约束', '写入范围', '验收标准', '验证计划', '下一步动作', '评测映射',
    '完整流程控制', '阻塞原因', '恢复提示', '剩余风险', '验收证据',
  ];
  const sections = Object.fromEntries(sectionNames.map((name) => [name, section(body, name)]));
  const title = body.match(/^#\s+(\S+)\s+(.+)$/mu);
  const control = fields['工作流档位'] === '完整' ? parseControl(body, file, parseErrors) : null;
  return {
    body,
    control,
    criteria: rowObjects(parseTable(sections['验收标准'])),
    evalMappings: rowObjects(parseTable(sections['评测映射'])),
    evidence: rowObjects(parseTable(sections['验收证据'])),
    fields,
    file,
    parseErrors,
    sections,
    title,
  };
}

function normalizedList(value) {
  if (!value) return [];
  return value.split(/\r?\n/u)
    .map((line) => line.replace(/^\s*[-*]\s*/u, '').trim())
    .filter(substantive);
}

export function normalizeTaskDocument(parsed) {
  return {
    acceptanceCriteria: parsed.criteria.map((row) => ({ id: row['AC-ID'], standard: row['标准'] })),
    constraints: normalizedList(parsed.sections['约束']),
    control: parsed.control,
    evidence: parsed.evidence,
    goal: parsed.sections['目标'],
    id: parsed.title?.[1] ?? null,
    nextAction: parsed.sections['下一步动作'],
    phase: FIELD_ENUMS['当前阶段'][parsed.fields['当前阶段']] ?? null,
    result: FIELD_ENUMS['处理结果'][parsed.fields['处理结果']] ?? null,
    schemaVersion: 1,
    scope: { write: parsed.sections['写入范围'] },
    source: { body: parsed.body, format: 'markdown', path: parsed.file },
    status: FIELD_ENUMS['当前状态'][parsed.fields['当前状态']] ?? null,
    title: parsed.title?.[2] ?? null,
    verification: parsed.sections['验证计划'],
    workflowTier: FIELD_ENUMS['工作流档位'][parsed.fields['工作流档位']] ?? null,
    _parsed: parsed,
  };
}

export function renderTaskDocumentMarkdown(document, { language = 'zh-CN' } = {}) {
  if (!['zh-CN', 'en-US'].includes(language)) throw new Error('language must be zh-CN or en-US');
  const english = language === 'en-US';
  const labels = english
    ? {
        acceptance: 'Acceptance criteria', constraints: 'Constraints', goal: 'Goal', next: 'Next action',
        phase: 'Current phase', result: 'Result', scope: 'Write scope', status: 'Current status',
        tier: 'Workflow tier', verification: 'Verification plan', standard: 'Standard',
      }
    : {
        acceptance: '验收标准', constraints: '约束', goal: '目标', next: '下一步动作', phase: '当前阶段',
        result: '处理结果', scope: '写入范围', status: '当前状态', tier: '工作流档位', verification: '验证计划', standard: '标准',
      };
  const enumValue = (field, value) => {
    if (english) return value;
    return Object.entries(FIELD_ENUMS[field]).find(([, normalized]) => normalized === value)?.[0] ?? value;
  };
  const lines = [
    `# ${document.id} ${document.title}`,
    '',
    `- ${labels.tier}：${enumValue('工作流档位', document.workflowTier)}`,
    `- ${labels.phase}：${enumValue('当前阶段', document.phase)}`,
    `- ${labels.status}：${enumValue('当前状态', document.status)}`,
    `- ${labels.result}：${enumValue('处理结果', document.result)}`,
    '',
    `## ${labels.goal}`,
    '',
    document.goal ?? '',
  ];
  if (document.constraints.length > 0) {
    lines.push('', `## ${labels.constraints}`, '', ...document.constraints.map((item) => `- ${item}`));
  }
  if (document.scope.write) lines.push('', `## ${labels.scope}`, '', document.scope.write);
  lines.push(
    '',
    `## ${labels.acceptance}`,
    '',
    `| AC-ID | ${labels.standard} |`,
    '| --- | --- |',
    ...document.acceptanceCriteria.map((item) => `| ${item.id} | ${item.standard} |`),
    '',
    `## ${labels.verification}`,
    '',
    document.verification ?? '',
    '',
    `## ${labels.next}`,
    '',
    document.nextAction ?? '',
    '',
  );
  return lines.join('\n');
}

export function validateTaskSemantics({ document, schema }) {
  const { _parsed: parsed } = document;
  const { control, criteria, evalMappings, fields, file, parseErrors, sections, title } = parsed;
  const errors = [...parseErrors];
  if (!title) errors.push(`${file}：缺少“# <任务编号> <标题>”`);
  for (const [name, allowed] of Object.entries(FIELD_VALUES)) {
    if (!fields[name]) errors.push(`${file}：缺少字段“${name}”`);
    else if (!allowed.has(fields[name])) errors.push(`${file}：字段“${name}”的值无效：${fields[name]}`);
  }
  for (const name of ['目标', '验收标准', '验证计划', '下一步动作']) {
    if (!substantive(sections[name])) errors.push(`${file}：缺少或未填写“${name}”区块`);
  }

  const criterionIds = criteria.map((row) => row['AC-ID']).filter(substantive);
  if (criteria.length === 0 || criterionIds.length !== criteria.length || criteria.some((row) => !substantive(row['标准']))) {
    errors.push(`${file}：“验收标准”必须使用 AC-ID 和标准两列表格`);
  }
  if (new Set(criterionIds).size !== criterionIds.length) errors.push(`${file}：验收标准 AC-ID 不得重复`);

  for (const row of evalMappings) {
    if (!criterionIds.includes(row['AC-ID'])) errors.push(`${file}：评测映射引用未知 AC-ID：${row['AC-ID']}`);
    if (!substantive(row['Eval-ID'])) errors.push(`${file}：${row['AC-ID']} 缺少 Eval-ID`);
  }
  const mappingKeys = evalMappings.map((row) => `${row['AC-ID']}:${row['Eval-ID']}`);
  if (new Set(mappingKeys).size !== mappingKeys.length) errors.push(`${file}：评测映射不得重复`);

  if (fields['当前状态'] === '阻塞') {
    for (const name of ['阻塞原因', '恢复提示']) if (!substantive(sections[name])) errors.push(`${file}：阻塞任务缺少“${name}”`);
  } else if (['等待人工', '等待依赖'].includes(fields['当前状态']) && !substantive(sections['恢复提示'])) {
    errors.push(`${file}：等待任务缺少“恢复提示”`);
  }
  if (fields['工作流档位'] === '轻量' && !substantive(sections['写入范围'])) errors.push(`${file}：轻量任务缺少“写入范围”`);

  if (fields['工作流档位'] === '完整' && control) {
    for (const error of validateJsonAgainstSchema(control, schema, '完整流程控制')) errors.push(`${file}：${error}`);
    if (['父任务', '子任务'].includes(control['任务类型'])) {
      if (!substantive(control['父任务编号']) && control['任务类型'] === '子任务') errors.push(`${file}：子任务缺少“父任务编号”`);
      if (!Number.isInteger(control['时间盒分钟']) || control['时间盒分钟'] < 1) errors.push(`${file}：父子任务缺少有效“时间盒分钟”`);
      if (!Array.isArray(control['冲突任务'])) errors.push(`${file}：父子任务缺少“冲突任务”数组`);
    }
    if (control['任务类型'] === '子任务') errors.push(...validateChildHandoff(control, file));
  }
  return errors;
}

export function validateTaskEvidence({ document, root }) {
  const { _parsed: parsed } = document;
  const { control, criteria, evalMappings, evidence, fields, file, sections, title } = parsed;
  const errors = [];
  const criterionIds = criteria.map((row) => row['AC-ID']).filter(substantive);
  if (fields['处理结果'] === '完成') {
    if (!sections['剩余风险']?.trim()) errors.push(`${file}：完成任务缺少“剩余风险”`);
    if (evidence.length === 0) errors.push(`${file}：完成任务缺少“验收证据”`);
    for (const row of evidence) {
      const criterionId = row['AC-ID'];
      if (!criterionIds.includes(criterionId)) errors.push(`${file}：验收证据引用未知 AC-ID：${criterionId}`);
      if (!['命令', '产物', '人工', '审查', '评测'].includes(row['证据类型'])) errors.push(`${file}：${criterionId} 的证据类型必须是命令、产物、人工、审查或评测`);
      if (!substantive(row['命令或产物'])) errors.push(`${file}：${criterionId} 缺少“命令或产物”`);
      if (!substantive(row['核验时间']) || Number.isNaN(Date.parse(row['核验时间']))) errors.push(`${file}：${criterionId} 缺少有效核验时间`);
      if (!substantive(row['核验者']) || !substantive(row['实际结果'])) errors.push(`${file}：${criterionId} 缺少核验者或实际结果`);
      if (row['证据类型'] === '命令' && row['退出码'] !== '0') errors.push(`${file}：${criterionId} 命令证据退出码必须为 0`);
      if (row['证据类型'] === '产物') {
        const artifactError = validateArtifact(root, row['命令或产物']);
        if (artifactError) errors.push(`${file}：${criterionId} ${artifactError}`);
      }
    }
    for (const mapping of evalMappings) {
      const evidenceRow = evidence.find((row) => row['AC-ID'] === mapping['AC-ID'] && row['证据类型'] === '评测');
      if (!evidenceRow) {
        errors.push(`${file}：${mapping['AC-ID']} 缺少 Eval-ID ${mapping['Eval-ID']} 的评测证据`);
        continue;
      }
      for (const evaluationError of validateEvaluationArtifact(root, evidenceRow['命令或产物'], mapping['Eval-ID'])) {
        errors.push(`${file}：${mapping['AC-ID']} ${evaluationError}`);
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

export function validateTaskDocument({ document, root, schema }) {
  return [
    ...validateTaskSemantics({ document, schema }),
    ...validateTaskEvidence({ document, root }),
  ];
}

function validateTask(root, file, body, schema) {
  return validateTaskDocument({
    document: normalizeTaskDocument(parseTaskMarkdown(file, body)),
    root,
    schema,
  });
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
