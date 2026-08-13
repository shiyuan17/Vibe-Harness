import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { parseAdrDocument, validateAdrDirectory, validateHistoricalAdr } from '../scripts/lib/adr-validation.js';

async function makeFixture() {
  const root = await mkdtemp(path.join(process.cwd(), 'tests', 'tmp-adr-'));
  await mkdir(path.join(root, 'docs/adr'), { recursive: true });
  await mkdir(path.join(root, 'docs/memory'), { recursive: true });
  await mkdir(path.join(root, 'schemas'), { recursive: true });
  await writeFile(path.join(root, 'schemas/adr.schema.json'), await readFile('schemas/adr.schema.json'), 'utf8');
  return root;
}

function validAdr(id, status = 'proposed') {
  return [
    '---',
    'id: ' + id,
    'title: Example decision',
    'status: ' + status,
    'date: 2026-08-13',
    'owner: platform-team',
    'decision-makers: [platform-team]',
    'consulted: []',
    'informed: []',
    'supersedes: []',
    'superseded-by: null',
    '---',
    '## Context and Problem Statement',
    '## Decision Drivers',
    '## Considered Options',
    '## Decision Outcome',
    '## Consequences',
    '## Confirmation',
    '## More Information',
  ].join('\n');
}

test('ADR parser rejects invalid status and missing sections', () => {
  const content = [
    '---',
    'id: ADR-0001',
    'title: Example decision',
    'status: unknown',
    'date: 2026-08-13',
    'owner: platform-team',
    'decision-makers: [platform-team]',
    'consulted: []',
    'informed: []',
    'supersedes: []',
    'superseded-by: null',
    '---',
    '## Context and Problem Statement',
  ].join('\n');
  const result = parseAdrDocument(content, 'docs/adr/ADR-0001-example.md');
  assert.ok(result.errors.some((error) => error.includes('status is invalid')));
  assert.ok(result.errors.some((error) => error.includes('Consequences')));
});

test('accepted ADR requires decision evidence content', () => {
  const content = [
    '---', 'id: ADR-0002', 'title: Accepted decision', 'status: accepted', 'date: 2026-08-13',
    'owner: platform-team', 'decision-makers: [platform-team]', 'consulted: []', 'informed: []',
    'supersedes: []', 'superseded-by: null', '---',
    '## Context and Problem Statement', 'Context', '## Decision Drivers', 'Drivers',
    '## Considered Options', 'Options', '## Decision Outcome', '## Consequences',
    '## Confirmation', '## Review Trigger', 'Review later', '## More Information', 'Info',
  ].join('\n');
  const result = parseAdrDocument(content, 'docs/adr/ADR-0002-accepted.md');
  assert.ok(result.errors.some((error) => error.includes('accepted ADR must contain content in Decision Outcome')));
});

test('accepted ADR core content cannot be rewritten', () => {
  const previous = parseAdrDocument(validAdr('ADR-0003', 'accepted').replace('## Decision Outcome', '## Decision Outcome\nChosen'));
  const changed = parseAdrDocument(validAdr('ADR-0003', 'accepted').replace('## Decision Outcome', '## Decision Outcome\nDifferent'));
  assert.equal(validateHistoricalAdr(previous, changed, 'docs/adr/ADR-0003-history.md').length, 1);
});

test('accepted ADR cannot return to proposed', () => {
  const previous = parseAdrDocument(validAdr('ADR-0007', 'accepted'));
  const current = parseAdrDocument(validAdr('ADR-0007', 'proposed'));
  assert.equal(validateHistoricalAdr(previous, current, 'docs/adr/ADR-0007-state.md').length, 1);
});

test('ADR parser rejects impossible dates and empty rejection reasons', () => {
  const content = validAdr('ADR-0004', 'rejected').replace('date: 2026-08-13', 'date: 2026-02-30') + '\n## Rejection Reason\n';
  const result = parseAdrDocument(content, 'docs/adr/ADR-0004-rejected.md');
  assert.ok(result.errors.some((error) => error.includes('valid YYYY-MM-DD date')));
  assert.ok(result.errors.some((error) => error.includes('non-empty Rejection Reason')));
});

test('ADR directory reports broken replacement and index links', async () => {
  const root = await makeFixture();
  try {
    await writeFile(path.join(root, 'docs/adr/ADR-0001-old.md'), validAdr('ADR-0001', 'superseded'), 'utf8');
    await writeFile(path.join(root, 'docs/adr/catalog.json'), '{"schemaVersion":1,"items":[{"id":"ADR-0001","path":"docs/adr/ADR-0001-old.md"}]}', 'utf8');
    await writeFile(path.join(root, 'docs/memory/DECISIONS.md'), '# Decisions\n', 'utf8');
    const errors = await validateAdrDirectory(root);
    assert.ok(errors.some((error) => error.includes('requires superseded-by')));
    assert.ok(errors.some((error) => error.includes('DECISIONS.md is missing ADR-0001')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ADR directory reports duplicate catalog paths', async () => {
  const root = await makeFixture();
  try {
    await writeFile(path.join(root, 'docs/adr/ADR-0005-one.md'), validAdr('ADR-0005'), 'utf8');
    const catalog = { schemaVersion: 1, items: [
      { id: 'ADR-0005', path: 'docs/adr/ADR-0005-one.md' },
      { id: 'ADR-0006', path: 'docs/adr/ADR-0005-one.md' },
    ] };
    await writeFile(path.join(root, 'docs/adr/catalog.json'), JSON.stringify(catalog), 'utf8');
    await writeFile(path.join(root, 'docs/memory/DECISIONS.md'), 'ADR-0005\n', 'utf8');
    const errors = await validateAdrDirectory(root);
    assert.ok(errors.some((error) => error.includes('duplicate ADR path')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
