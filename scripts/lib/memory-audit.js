import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { pathExists } from './manifest.js';

function ageDays(date, now) {
  return (now.getTime() - date.getTime()) / 86400000;
}

function calendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const parsed = new Date(value + 'T00:00:00.000Z');
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : parsed;
}

function placeholderDate(value) {
  return String(value).includes('YYYY-MM-DD');
}

function item(code, severity, message, relativePath) {
  const pointer = relativePath ? { path: relativePath.replaceAll('\\', '/') } : {};
  return { code, severity, message, ...pointer };
}

function reportStatus(items) {
  if (items.some((entry) => entry.severity === 'error')) return 'degraded';
  if (items.some((entry) => entry.severity === 'warning')) return 'warning';
  return 'healthy';
}

function dateFields(content) {
  const pattern = /(?:lastVerified|lastValidated|lastUpdated|reviewBy|最后验证|最后更新|复核日期)[^\S\r\n]*[:：][^\S\r\n]*([^\s)]+)/giu;
  return [...String(content).matchAll(pattern)].map((match) => ({
    label: match[0].slice(0, match[0].indexOf(match[1])).trim(),
    value: match[1],
  }));
}

function referencedPaths(content) {
  const pattern = /((?:docs|rules|templates|skills|runtime|adapters|manifests|schemas|scripts|tests)\/[A-Za-z0-9._/\\-]+)/gu;
  return [...String(content).matchAll(pattern)].map((match) => match[1].replaceAll('\\', '/'));
}

function hasMeaningfulContent(content) {
  return String(content).split(/\r?\n/u).map((line) => line.trim()).some((line) => {
    if (!line || line.startsWith('#')) return false;
    if (/^(?:记录|仅在|这里只|索引而非仓库|明确排除的项|本文件是)/u.test(line)) return false;
    if (/^[-*]\s*(?:[^:：]+[:：])?\s*(?:\([^)]*\)|<[^>]*>|YYYY-MM-DD)?\s*$/u.test(line)) return false;
    if (/^[-*]\s+\*\*\[ID\]\*\*/u.test(line)) return false;
    return true;
  });
}

function activeTarget(content) {
  const match = String(content).match(/(?:^|\n)[^\S\r\n]*[-*]?[^\S\r\n]*(?:目标|goal)[^\S\r\n]*[:：][^\S\r\n]*([^\r\n]*)/iu);
  if (!match) return false;
  const value = match[1].trim();
  return Boolean(value && !/^\([^)]*\)$/u.test(value) && !/^<[^>]*>$/u.test(value));
}

async function listMemoryFiles(targetDir) {
  const files = [];
  for (const relativeRoot of ['docs/memory', '.agents/memory']) {
    const absoluteRoot = path.join(targetDir, relativeRoot);
    if (!await pathExists(absoluteRoot)) continue;
    for (const entry of await readdir(absoluteRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:md|json)$/iu.test(entry.name)) continue;
      files.push({
        absolute: path.join(absoluteRoot, entry.name),
        relative: path.join(relativeRoot, entry.name).replaceAll('\\', '/'),
      });
    }
  }
  return files.sort((left, right) => left.relative.localeCompare(right.relative));
}

export async function auditMemory({ now = new Date(), targetDir }) {
  const evidence = [];
  const files = await listMemoryFiles(targetDir);
  if (files.length === 0) evidence.push(item('MEMORY_NOT_INSTALLED', 'warning', 'No project memory files were found.'));
  for (const file of files) {
    const content = await readFile(file.absolute, 'utf8');
    const meaningful = hasMeaningfulContent(content);
    if (!meaningful) evidence.push(item('MEMORY_EMPTY_TEMPLATE', 'warning', 'Memory file still contains only template placeholders.', file.relative));
    const fields = dateFields(content);
    for (const field of fields) {
      if (!placeholderDate(field.value) && !calendarDate(field.value)) {
        evidence.push(item('MEMORY_INVALID_DATE', 'error', 'Memory contains an invalid date.', file.relative));
      }
    }
    const verified = fields.find((entry) => /verified|validated|验证/iu.test(entry.label));
    if (/CURRENT\.md$/iu.test(file.relative) && activeTarget(content)) {
      const verifiedDate = verified ? calendarDate(verified.value) : null;
      if (!verifiedDate) evidence.push(item('MEMORY_ACTIVE_UNVERIFIED', 'warning', 'Active memory has no valid last verification date.', file.relative));
      else if (ageDays(verifiedDate, now) > 1) {
        evidence.push(item('MEMORY_ACTIVE_STALE', 'warning', 'Active memory was not verified within one day.', file.relative));
      }
    }
    const reviewBy = fields.find((entry) => /reviewBy|复核/iu.test(entry.label));
    const durableDate = reviewBy ?? verified ?? fields.find((entry) => /updated|更新/iu.test(entry.label));
    const due = durableDate ? calendarDate(durableDate.value) : null;
    if (file.relative.startsWith('docs/memory/') && due) {
      if ((reviewBy && due < now) || (!reviewBy && ageDays(due, now) > 90)) {
        evidence.push(item('MEMORY_DURABLE_REVIEW_DUE', 'warning', 'Durable memory is due for owner review.', file.relative));
      }
    }
    const verifiedDate = verified ? calendarDate(verified.value) : null;
    if (!verifiedDate) continue;
    const verifiedAt = new Date(verified.value + 'T23:59:59.999Z');
    for (const reference of new Set(referencedPaths(content))) {
      try {
        const metadata = await lstat(path.join(targetDir, reference));
        if (metadata.mtime > verifiedAt) evidence.push(item('MEMORY_REFERENCE_CHANGED', 'warning', 'Referenced file changed after memory verification.', reference));
      } catch (error) {
        if (error.code === 'ENOENT') evidence.push(item('MEMORY_REFERENCE_MISSING', 'error', 'Memory references a missing file.', reference));
        else throw error;
      }
    }
  }
  return { status: reportStatus(evidence), evidence, details: { filesChecked: files.length } };
}
