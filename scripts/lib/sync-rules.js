import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// rules/*.md is the packaging source; docs/rules/*.md is the governed mirror
// that catalog consumers read. This module regenerates the mirror from the
// source so edits made under rules/ do not have to be hand-copied. The contract
// mirrors validateRulesParity in docs-validation.js:
// - project-specific-rules.md is excluded: its {{placeholders}} are rendered per
//   target project at install time, so docs/rules/ carries its own copy.
// - A fixed filename map renders certain sources under a different docs name
//   (rules/agent-skill-routing.md -> docs/rules/AGENT_SKILL_ROUTING.md).
// - Files compare equal modulo line endings; a copy is written only when the
//   normalized content actually drifted.

const RENDER_NAME_MAP = new Map([
  ['agent-skill-routing.md', 'AGENT_SKILL_ROUTING.md'],
]);

const SYNC_EXCLUDED = new Set(['project-specific-rules.md']);

function normalizeLineEndings(value) {
  return value.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
}

async function listMarkdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name);
}

export async function syncRules(rootDir) {
  const rulesDir = path.join(rootDir, 'rules');
  const docsRulesDir = path.join(rootDir, 'docs', 'rules');
  const updated = [];
  const inSync = [];
  const skipped = [];
  const unpaired = [];

  let rulesFiles;
  try {
    rulesFiles = await listMarkdownFiles(rulesDir);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { updated, inSync, skipped, unpaired };
  }
  await mkdir(docsRulesDir, { recursive: true });

  const managedDocsNames = new Set(SYNC_EXCLUDED);
  for (const name of rulesFiles) {
    if (SYNC_EXCLUDED.has(name)) {
      skipped.push({ name, reason: 'render template; docs copy is rendered per target project' });
      continue;
    }
    const targetName = RENDER_NAME_MAP.get(name) ?? name;
    managedDocsNames.add(targetName);
    const sourcePath = path.join(rulesDir, name);
    const targetPath = path.join(docsRulesDir, targetName);
    const source = await readFile(sourcePath, 'utf8');
    let target = null;
    try {
      target = await readFile(targetPath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (target !== null && normalizeLineEndings(target) === normalizeLineEndings(source)) {
      inSync.push(targetName);
      continue;
    }
    await copyFile(sourcePath, targetPath);
    updated.push(targetName);
  }

  for (const name of await listMarkdownFiles(docsRulesDir)) {
    if (!managedDocsNames.has(name)) unpaired.push(name);
  }
  return { updated, inSync, skipped, unpaired };
}
