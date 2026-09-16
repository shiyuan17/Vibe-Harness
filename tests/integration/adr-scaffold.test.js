import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { parseAdrArgs } from '../../scripts/adr-new.js';
import { buildAdrPlan, nextAdrId, renderAdrDocument, slugifyAdrTitle, writeAdrDocument } from '../../scripts/lib/adr-scaffold.js';
import { parseAdrDocument } from '../../scripts/lib/adr-validation.js';
import { ADR_PATH, createDocsFixture, removeDocsFixture, repositoryRoot } from '../helpers/docs-fixture.js';

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = path.join(repositoryRoot, 'scripts', 'adr-new.js');

test('nextAdrId continues the highest existing identifier', async () => {
  const root = await createDocsFixture();
  try {
    assert.equal(await nextAdrId(root), 'ADR-0002');
  } finally {
    await removeDocsFixture(root);
  }
});

test('slugifyAdrTitle derives a filename slug and refuses to invent one for non-ASCII titles', () => {
  assert.equal(slugifyAdrTitle('Route the release gate through the writer!'), 'route-the-release-gate-through-the-writer');
  assert.equal(slugifyAdrTitle('发布门禁经写入者合并'), '');
});

test('a rendered ADR satisfies the ADR parser', async () => {
  const template = await readFile(path.join(repositoryRoot, 'templates/adr/adr-template.md'), 'utf8');
  const content = renderAdrDocument({
    date: '2026-09-13',
    id: 'ADR-0007',
    owner: 'platform-team',
    status: 'accepted',
    template,
    title: 'Example decision',
  });
  assert.deepEqual(parseAdrDocument(content, 'docs/adr/ADR-0007-example-decision.md').errors, []);
});

test('adr:new validates its inputs before it writes anything', async () => {
  const root = await createDocsFixture();
  try {
    const missingOwner = await buildAdrPlan({ rootDir: root, title: 'Example decision' });
    assert.deepEqual(missingOwner.errors, ['--owner is required']);
    const nonAscii = await buildAdrPlan({ owner: 'platform-team', rootDir: root, title: '发布门禁经写入者合并' });
    assert.equal(nonAscii.errors.some((error) => error.includes('--slug is required')), true);
    assert.equal(nonAscii.relativePath, 'docs/adr/ADR-0002-.md');
  } finally {
    await removeDocsFixture(root);
  }
});

test('adr:new --write creates the ADR and its catalog, decisions and index entries', async () => {
  const root = await createDocsFixture();
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      SCRIPT_PATH, '--title', 'Example decision', '--owner', 'platform-team', '--write', '--json',
    ], { cwd: root, windowsHide: true });
    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.path, 'docs/adr/ADR-0002-example-decision.md');

    const created = await readFile(path.join(root, report.path), 'utf8');
    assert.deepEqual(parseAdrDocument(created, report.path).errors, []);
    assert.equal((await readFile(path.join(root, 'docs/adr/catalog.json'), 'utf8')).includes(report.path), true);
    assert.match(await readFile(path.join(root, 'docs/memory/DECISIONS.md'), 'utf8'), /- \*\*ADR-0002\*\* Example decision - proposed - Example decision/u);
    assert.match(await readFile(path.join(root, 'docs/catalog.json'), 'utf8'), /"kind": "architecture"/u);
    assert.match(await readFile(path.join(root, 'docs/README.md'), 'utf8'), /- \[Example decision\]\(adr\/ADR-0002-example-decision\.md\)/u);
  } finally {
    await removeDocsFixture(root);
  }
});

test('adr:new never overwrites an existing document', async () => {
  const root = await createDocsFixture();
  try {
    await assert.rejects(writeAdrDocument(root, ADR_PATH, '# replacement\n'), { code: 'EEXIST' });
    assert.equal((await readFile(path.join(root, ADR_PATH), 'utf8')).startsWith('---'), true);
  } finally {
    await removeDocsFixture(root);
  }
});

test('adr:new argument parsing keeps list options and rejects unknown flags', () => {
  const parsed = parseAdrArgs(['--title', 'Example decision', '--owner', 'team', '--decision-makers', 'a, b', '--write', '--json']);
  assert.deepEqual(parsed, {
    json: true,
    options: { decisionMakers: ['a', 'b'], owner: 'team', title: 'Example decision' },
    write: true,
  });
});
