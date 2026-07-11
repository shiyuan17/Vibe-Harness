import path from 'node:path';
import { readFile } from 'node:fs/promises';

const rootDir = path.resolve('.');
const manifest = JSON.parse(await readFile(path.join(rootDir, 'manifests/skills.json'), 'utf8'));
const counts = new Map();
const lengths = [];

for (const item of manifest.items) {
  counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  const content = await readFile(path.join(rootDir, item.source), 'utf8');
  lengths.push({ id: item.id, lines: content.split(/\r?\n/u).length });
}

lengths.sort((left, right) => right.lines - left.lines || left.id.localeCompare(right.id));

console.log('# Skills 实时审计');
console.log('');
console.log(`- 总数：${manifest.items.length}`);
for (const kind of ['native', 'integration', 'router', 'compatibility']) {
  console.log(`- ${kind}：${counts.get(kind) ?? 0}`);
}
console.log(`- 最长入口：\`${lengths[0].id}\`（${lengths[0].lines} 行）`);
console.log('');
console.log('| Skill | Kind | Lines | Required | Optional | Tools |');
console.log('| --- | --- | ---: | --- | --- | --- |');
for (const item of manifest.items) {
  const length = lengths.find((entry) => entry.id === item.id).lines;
  console.log(`| \`${item.id}\` | ${item.kind} | ${length} | ${item.requiresSkills.join(', ') || '-'} | ${item.optionalSkills.join(', ') || '-'} | ${item.requiresTools.join(', ') || '-'} |`);
}
