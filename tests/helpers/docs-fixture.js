// Shared governed-documentation fixture for the docs projection and ADR
// scaffold tests. It mirrors the layout collectGovernedPaths expects, so a
// fixture can exercise docs:sync and adr:new against a real directory tree
// without writing to the repository.
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { removeTemporaryDirectory } from '../../scripts/lib/temp-cleanup.js';

export const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

// collectGovernedPaths always lists these schema assets, whether or not they
// exist on disk, so a fixture that omits them would plan catalog entries for
// files it never created.
export const GOVERNED_SCHEMAS = [
  'adr',
  'execution-envelope',
  'execution-envelope-v2',
  'harness-eval-fixture',
  'harness-eval-result',
  'harness-eval-scenario',
  'project-verification',
  'role-pack',
];

export const ADR_PATH = 'docs/adr/ADR-0001-first-decision.md';
export const ADR_OVERRIDE = {
  [ADR_PATH]: { audiences: ['contributor', 'maintainer', 'auditor'], kind: 'architecture', language: 'zh-CN', status: 'current' },
};
export const ADR_SUMMARY = { [ADR_PATH]: 'First decision' };

const EMPTY_CATALOG = '{\n  "schemaVersion": 1,\n  "items": [\n  ]\n}\n';

const ROOT_DOCUMENTS = {
  'AGENTS.md': '# Agent rules\n',
  'CHANGELOG.md': '# Changelog\n',
  'CONTRIBUTING.md': '# Contributing\n',
  'README.en.md': '# Project\n',
  'README.md': '# Project\n',
};

const ADR_DOCUMENT = `---
id: ADR-0001
title: First decision
status: accepted
date: 2026-01-05
owner: platform-team
decision-makers: [platform-team]
consulted: []
informed: []
supersedes: []
superseded-by: null
---

# First decision

## Context and Problem Statement

Fixture context.

## Decision Drivers

- Driver.

## Considered Options

- Option.

## Decision Outcome

Outcome.

## Consequences

- Consequence.

## Confirmation

Test.

## Review Trigger

Review.

## More Information

None.
`;

function primaryIndex() {
  return [
    '# Documentation',
    '',
    '## Architecture',
    '',
    '- [Architecture](architecture.md)',
    '',
    '## Rules',
    '',
    '- [Example rule](rules/example-rule.md)',
    '',
    '## ADRs',
    '',
    '- [ADR index](adr/README.md)',
    '- [ADR catalog](adr/catalog.json)',
    '',
    '## Memory',
    '',
    '- [Decisions](memory/DECISIONS.md)',
    '',
    '## Schemas',
    '',
    ...GOVERNED_SCHEMAS.map((name) => `- [${name}](schemas/${name}.schema.json)`),
    '',
  ].join('\n');
}

/**
 * Create a temporary governed-documentation tree.
 *
 * @param {{adrDocument?: string|null}} [options] `null` omits the fixture ADR.
 * @returns {Promise<string>} the fixture root directory.
 */
export async function createDocsFixture({ adrDocument = ADR_DOCUMENT } = {}) {
  const root = await mkdtemp(path.join(repositoryRoot, 'tests', 'tmp-docs-'));
  for (const directory of ['docs/adr', 'docs/archive', 'docs/memory', 'docs/rules', 'docs/schemas', 'schemas', 'templates/adr']) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  for (const [name, content] of Object.entries(ROOT_DOCUMENTS)) {
    await writeFile(path.join(root, name), content, 'utf8');
  }
  const textFiles = {
    'docs/README.md': primaryIndex(),
    'docs/adr/README.md': '# ADRs\n\n- [ADR-0001](ADR-0001-first-decision.md)\n',
    'docs/architecture.md': '# Architecture\n',
    'docs/archive/README.md': '# Archive\n',
    'docs/catalog.json': EMPTY_CATALOG,
    'docs/memory/DECISIONS.md': '# Decisions\n',
    'docs/rules/example-rule.md': '# Example rule\n',
    'templates/adr/adr-template.md': await readFile(path.join(repositoryRoot, 'templates/adr/adr-template.md'), 'utf8'),
  };
  for (const [name, content] of Object.entries(textFiles)) {
    await writeFile(path.join(root, name), content, { encoding: 'utf8' });
  }
  await writeFile(path.join(root, 'docs/adr/catalog.json'), EMPTY_CATALOG, 'utf8');
  if (adrDocument !== null) await writeFile(path.join(root, ADR_PATH), adrDocument, 'utf8');

  // A schema render copy must start identical to its source. The fixture only
  // needs the two trees to agree, so it seeds both from one small payload
  // instead of copying the repository schemas.
  const schemaBytes = Buffer.from('{\n  "$id": "https://example.invalid/fixture.schema.json"\n}\n');
  for (const name of GOVERNED_SCHEMAS) {
    await writeFile(path.join(root, 'schemas', `${name}.schema.json`), schemaBytes);
    await writeFile(path.join(root, 'docs', 'schemas', `${name}.schema.json`), schemaBytes);
  }
  return root;
}

/** Remove a fixture created by createDocsFixture. */
export async function removeDocsFixture(root) {
  await removeTemporaryDirectory(root);
}

/** The per-ADR sync inputs the projection layer cannot derive on its own. */
export function adrSyncOptions() {
  return { catalogOverrides: ADR_OVERRIDE, decisionsSummaries: ADR_SUMMARY };
}
