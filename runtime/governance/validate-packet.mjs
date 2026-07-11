#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function names(value) {
  return Array.isArray(value) ? value : [value];
}

function section(body, candidates) {
  const wanted = new Set(names(candidates).map((name) => name.toLowerCase()));
  const lines = body.split(/\r?\n/u);
  const start = lines.findIndex((line) => {
    const heading = line.trim().match(/^(#{2,6})\s+(.+)$/u);
    return heading && wanted.has(heading[2].trim().toLowerCase());
  });
  if (start < 0) return null;
  const startLevel = lines[start].trim().match(/^(#{2,6})\s+/u)[1].length;
  const end = lines.findIndex((line, index) => {
    if (index <= start) return false;
    const heading = line.trim().match(/^(#{2,6})\s+/u);
    return heading && heading[1].length <= startLevel;
  });
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

function field(sectionBody, candidates) {
  if (sectionBody === null) return null;
  const candidateNames = names(candidates);
  for (const name of candidateNames) {
    const prefix = `- ${name}:`;
    const line = sectionBody.split(/\r?\n/u).find((entry) => entry.trim().toLowerCase().startsWith(prefix.toLowerCase()));
    if (line !== undefined) return line.trim().slice(prefix.length).trim();
  }
  return null;
}

function substantive(value) {
  return typeof value === 'string'
    && value.trim().length > 0
    && !/^(?:TODO|TBD|N\/A|NA|none|later|pending)$/iu.test(value.trim());
}

const file = argument('--file');
if (!file) {
  console.error('Usage: validate-packet.mjs --file <packet.md>');
  process.exitCode = 1;
} else {
  const body = readFileSync(resolve(file), 'utf8');
  const errors = [];
  const reviewVerdict = section(body, ['Review Verdict', '审查结论']);
  if (reviewVerdict !== null) {
    for (const [name, aliases] of [
      ['Specification', ['Specification', '规格符合度']],
      ['Code Quality', ['Code Quality', '代码质量']],
    ]) {
      const value = field(reviewVerdict, aliases);
      if (value === null) errors.push(`Missing field: Review Verdict > ${name}`);
      else if (!substantive(value)) errors.push(`Empty field: Review Verdict > ${name}`);
    }
    for (const [name, aliases] of [
      ['Findings', ['Findings', '问题列表']],
      ['Verification Checked', ['Verification Checked', '已核验证']],
      ['Residual Risk', ['Residual Risk', '剩余风险']],
    ]) {
      if (!substantive(section(body, aliases))) errors.push(`Missing or empty section: ${name}`);
    }
  } else {
    const workflow = section(body, ['Dynamic Workflow', '动态工作流']);
    const primary = field(workflow, ['Primary Workflow', '主工作流']) ?? '';
    const modifiers = field(workflow, ['Required modifiers', '必要修饰器']) ?? '';

    for (const [sectionName, sectionAliases, fieldName, fieldAliases] of [
      ['Summary', ['Summary', '摘要'], 'Validation', ['Validation', '验证']],
      ['Summary', ['Summary', '摘要'], 'Risks', ['Risks', '风险']],
      ['Dynamic Workflow', ['Dynamic Workflow', '动态工作流'], 'Primary Workflow', ['Primary Workflow', '主工作流']],
    ]) {
      const value = field(section(body, sectionAliases), fieldAliases);
      if (value === null) errors.push(`Missing field: ${sectionName} > ${fieldName}`);
      else if (!substantive(value)) errors.push(`Empty field: ${sectionName} > ${fieldName}`);
    }

    const normalizedPrimary = primary.replace(/\s*\([^)]*\)\s*$/u, '').trim();
    const full = /^(security|db|production debug|workflow-infra|release)$/iu.test(normalizedPrimary) || /Security|DB|Red Team|Backend Cross-check|Browser Verification/iu.test(modifiers);
    if (full) {
      const evidence = section(body, ['Full Evidence', '完整流程证据']);
      if (evidence === null) errors.push('Missing section: Full Evidence');
      for (const [name, aliases] of [['Exit codes', ['Exit codes', '退出码']]]) {
        const value = field(evidence, aliases);
        if (value === null) errors.push(`Missing field: Full Evidence > ${name}`);
        else if (!substantive(value)) errors.push(`Empty field: Full Evidence > ${name}`);
      }
    }

    if (/^(security|db|production debug|workflow-infra|release)$/iu.test(normalizedPrimary) || /Security|DB|Red Team/iu.test(modifiers)) {
      const redTeam = section(body, ['Red Team', '红队证据']);
      if (redTeam === null) errors.push('Missing section: Red Team');
      for (const [name, aliases] of [
        ['Attack path', ['Attack path', '攻击路径']],
        ['Expected failure point', ['Expected failure point', '预期失效点']],
        ['Attack result', ['Attack result', '攻击结果']],
        ['Residual risk', ['Residual risk', '剩余风险']],
      ]) {
        if (!substantive(field(redTeam, aliases))) errors.push(`Red Team evidence missing: ${name}`);
      }
    }
  }

  if (errors.length > 0) {
    console.error('Governance packet validation failed:');
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log('Governance packet validation passed.');
  }
}
