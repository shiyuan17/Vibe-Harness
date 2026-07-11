#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const root = process.cwd();
const errors = [];
const requiredBasicFiles = [
  'AGENTS.md',
  'docs/rules/quickstart.md',
  'docs/rules/dynamic-workflow.md',
  'docs/rules/review-rules.md',
  'docs/templates/workflow-packet.md',
  'docs/templates/review-packet.md',
];
const requiredFullFiles = [
  'docs/rules/task-management.md',
  'docs/rules/pencil-rules.md',
  'docs/rules/release-rules.md',
  'docs/memory/PROJECT_STATE.md',
  'docs/memory/ARCHITECTURE.md',
  'docs/memory/DECISIONS.md',
  'docs/memory/KNOWN_BUGS.md',
  'docs/memory/TECH_DEBT.md',
  'docs/memory/FAILURE_LEARNINGS.md',
];

function readJson(relativePath) {
  try {
    return JSON.parse(readFileSync(resolve(root, relativePath), 'utf8'));
  } catch (error) {
    errors.push(`Invalid JSON: ${relativePath}: ${error.message}`);
    return null;
  }
}

function collectBrokenRelativeLinks(relativePath) {
  if (!existsSync(resolve(root, relativePath))) return;
  const body = readFileSync(resolve(root, relativePath), 'utf8');
  for (const match of body.matchAll(/\[[^\]]+\]\((?!https?:|#)([^)]+)\)/gu)) {
    const target = match[1].split('#')[0];
    if (target && !existsSync(resolve(root, dirname(relativePath), target))) {
      errors.push(`Broken relative link in ${relativePath}: ${match[1]}`);
    }
  }
}

for (const file of requiredBasicFiles) {
  if (!existsSync(resolve(root, file))) {
    errors.push(`Missing required governance file: ${file}`);
  }
}

for (const file of requiredBasicFiles.filter((file) => file.endsWith('.md'))) {
  collectBrokenRelativeLinks(file);
}

let config = null;
if (existsSync(resolve(root, 'loopengine.config.json'))) {
  config = readJson('loopengine.config.json');
} else if (existsSync(resolve(root, '.loopengine/install-state.json'))) {
  config = readJson('.loopengine/install-state.json');
} else {
  errors.push('Missing governance configuration: loopengine.config.json or .loopengine/install-state.json');
}
const fullProfiles = new Set(['full', 'codex-internal']);
const mode = config?.governance?.mode ?? (fullProfiles.has(config?.profile) ? 'full' : 'basic');
if (!['basic', 'full', 'off'].includes(mode)) {
  errors.push('governance.mode must be basic, full, or off');
}

if (mode === 'full') {
  for (const file of requiredFullFiles) {
    if (!existsSync(resolve(root, file))) errors.push(`Missing required full governance file: ${file}`);
  }
  const { validateTasks } = await import('./lib/task-validation.mjs');
  const { validateDesignAssets } = await import('./lib/design-validation.mjs');
  const { validateMemory } = await import('./lib/memory-validation.mjs');
  errors.push(...validateTasks(root), ...validateDesignAssets(root), ...validateMemory(root));
}

if (errors.length > 0) {
  console.error('Governance validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log('Governance validation passed.');
}
