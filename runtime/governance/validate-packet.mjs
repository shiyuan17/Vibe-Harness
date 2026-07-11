#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function section(body, name) {
  const lines = body.split(/\r?\n/u);
  const start = lines.findIndex((line) => {
    const heading = line.trim().match(/^(#{2,6})\s+(.+)$/u);
    return heading?.[2]?.trim().toLowerCase() === name.toLowerCase();
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

function field(sectionBody, name) {
  if (sectionBody === null) return null;
  const prefix = `- ${name}:`;
  const line = sectionBody.split(/\r?\n/u).find((entry) => entry.trim().toLowerCase().startsWith(prefix.toLowerCase()));
  return line === undefined ? null : line.trim().slice(prefix.length).trim();
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
  const reviewVerdict = section(body, 'Review Verdict');
  if (reviewVerdict !== null) {
    for (const name of ['Specification', 'Code Quality']) {
      const value = field(reviewVerdict, name);
      if (value === null) errors.push(`Missing field: Review Verdict > ${name}`);
      else if (!substantive(value)) errors.push(`Empty field: Review Verdict > ${name}`);
    }
    for (const name of ['Findings', 'Verification Checked', 'Residual Risk']) {
      if (!substantive(section(body, name))) errors.push(`Missing or empty section: ${name}`);
    }
  } else {
  const summary = section(body, 'Summary');
  const workflow = section(body, 'Dynamic Workflow');
  const primary = field(workflow, 'Primary Workflow') ?? '';
  const modifiers = field(workflow, 'Required modifiers') ?? '';

  for (const [sectionName, fieldName] of [['Summary', 'Validation'], ['Summary', 'Risks'], ['Dynamic Workflow', 'Primary Workflow']]) {
    const value = field(section(body, sectionName), fieldName);
    if (value === null) errors.push(`Missing field: ${sectionName} > ${fieldName}`);
    else if (!substantive(value)) errors.push(`Empty field: ${sectionName} > ${fieldName}`);
  }

  const normalizedPrimary = primary.replace(/\s*\([^)]*\)\s*$/u, '').trim();
  const full = /^(security|db|production debug|workflow-infra|release)$/iu.test(normalizedPrimary) || /Security|DB|Red Team|Backend Cross-check|Browser Verification/iu.test(modifiers);
  if (full) {
    const evidence = section(body, 'Full Evidence');
    if (evidence === null) errors.push('Missing section: Full Evidence');
    for (const name of ['Exit codes']) {
      const value = field(evidence, name);
      if (value === null) errors.push(`Missing field: Full Evidence > ${name}`);
      else if (!substantive(value)) errors.push(`Empty field: Full Evidence > ${name}`);
    }
  }

  if (/^(security|db|production debug|workflow-infra|release)$/iu.test(normalizedPrimary) || /Security|DB|Red Team/iu.test(modifiers)) {
    const redTeam = section(body, 'Red Team');
    if (redTeam === null) errors.push('Missing section: Red Team');
    for (const name of ['Attack path', 'Expected failure point', 'Attack result', 'Residual risk']) {
      if (!substantive(field(redTeam, name))) errors.push(`Red Team evidence missing: ${name}`);
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
