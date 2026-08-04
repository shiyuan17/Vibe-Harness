import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { readJson } from './manifest.js';
import { validateSkillGraph } from './pack-validation.js';

export async function runSkillsAudit(rootDir, options = {}) {
  const [manifest, profiles, installMap] = await Promise.all([
    options.manifest ?? readJson(path.join(rootDir, 'manifests/skills.json')),
    options.profiles ?? readJson(path.join(rootDir, 'manifests/profiles.json')),
    options.installEntries
      ? Promise.resolve({ entries: options.installEntries })
      : readJson(path.join(rootDir, 'adapters/install-map.json')),
  ]);
  const counts = new Map();
  const lengths = [];
  for (const item of manifest.items) {
    counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
    const content = await readFile(path.join(rootDir, item.source), 'utf8');
    lengths.push({ id: item.id, lines: content.split(/\r?\n/u).length });
  }
  lengths.sort((left, right) => right.lines - left.lines || left.id.localeCompare(right.id));
  const errors = await validateSkillGraph(rootDir, manifest.items, profiles.items, { installEntries: installMap.entries });
  return { counts, errors, items: manifest.items, lengths };
}

export function renderSkillsAudit(report) {
  const lines = ['# Skills 实时审计', '', `- 总数：${report.items.length}`];
  for (const kind of ['native', 'integration', 'router', 'compatibility']) {
    lines.push(`- ${kind}：${report.counts.get(kind) ?? 0}`);
  }
  if (report.lengths[0]) lines.push(`- 最长入口：\`${report.lengths[0].id}\`（${report.lengths[0].lines} 行）`);
  lines.push('', '| Skill | Kind | Lines | Required | Optional | Tools |', '| --- | --- | ---: | --- | --- | --- |');
  for (const item of report.items) {
    const length = report.lengths.find((entry) => entry.id === item.id).lines;
    lines.push(`| \`${item.id}\` | ${item.kind} | ${length} | ${item.requiresSkills.join(', ') || '-'} | ${item.optionalSkills.join(', ') || '-'} | ${item.requiresTools.join(', ') || '-'} |`);
  }
  return `${lines.join('\n')}\n`;
}
