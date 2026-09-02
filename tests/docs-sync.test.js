import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { syncRules } from '../scripts/lib/sync-rules.js';

async function writeFixture(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content, 'utf8');
  }
}

test('sync mirrors rules into docs/rules with name mapping and template exclusion', async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'docs-sync-'));
  try {
    await writeFixture(sandbox, {
      'rules/coding-rules.md': '# coding\nsource of truth\n',
      'rules/agent-skill-routing.md': '# routing\nsource\n',
      'rules/project-specific-rules.md': '# template\n{{placeholder}}\n',
      'docs/rules/coding-rules.md': '# coding\nstale mirror\n',
      'docs/rules/project-specific-rules.md': '# rendered template\nrendered value\n',
    });
    const report = await syncRules(sandbox);
    assert.deepEqual(report.updated.sort(), ['AGENT_SKILL_ROUTING.md', 'coding-rules.md']);
    assert.equal(await readFile(path.join(sandbox, 'docs/rules/coding-rules.md'), 'utf8'), '# coding\nsource of truth\n');
    assert.equal(await readFile(path.join(sandbox, 'docs/rules/AGENT_SKILL_ROUTING.md'), 'utf8'), '# routing\nsource\n');
    assert.equal(
      await readFile(path.join(sandbox, 'docs/rules/project-specific-rules.md'), 'utf8'),
      '# rendered template\nrendered value\n',
    );
    assert.deepEqual(report.skipped, [
      { name: 'project-specific-rules.md', reason: 'render template; docs copy is rendered per target project' },
    ]);
    assert.deepEqual(report.unpaired, []);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('sync is idempotent and reports unpaired docs files', async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'docs-sync-'));
  try {
    await writeFixture(sandbox, {
      'rules/coding-rules.md': '# coding\nshared\n',
      'docs/rules/coding-rules.md': '# coding\nshared\n',
      'docs/rules/orphan.md': '# orphan\n',
    });
    const first = await syncRules(sandbox);
    assert.deepEqual(first.updated, []);
    assert.deepEqual(first.inSync, ['coding-rules.md']);
    assert.deepEqual(first.unpaired, ['orphan.md']);
    const second = await syncRules(sandbox);
    assert.deepEqual(second, first);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('sync creates docs/rules when missing and tolerates a missing rules tree', async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'docs-sync-'));
  const empty = await mkdtemp(path.join(tmpdir(), 'docs-sync-'));
  try {
    await writeFixture(sandbox, { 'rules/coding-rules.md': '# coding\nnew\n' });
    const report = await syncRules(sandbox);
    assert.deepEqual(report.updated, ['coding-rules.md']);
    assert.equal(await readFile(path.join(sandbox, 'docs/rules/coding-rules.md'), 'utf8'), '# coding\nnew\n');
    assert.deepEqual(await syncRules(empty), { updated: [], inSync: [], skipped: [], unpaired: [] });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
    await rm(empty, { recursive: true, force: true });
  }
});
