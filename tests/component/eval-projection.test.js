import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { applyEvalSync, collectEvalSyncPlan, runEvalSync } from '../../scripts/lib/eval-projection.js';
import { removeTemporaryDirectory } from '../../scripts/lib/temp-cleanup.js';

const ENTRIES = [
  { contentStrategy: 'replace', group: 'evals-core', source: 'evals/suites/core.json', target: '.agents/evals/suites/core.json' },
  { contentStrategy: 'replace', group: 'evals-core', source: 'evals/references/core.offline.json', target: '.agents/evals/references/core.offline.json' },
];

async function makeFixture({ entries = ENTRIES } = {}) {
  const root = await mkdtemp(path.join(import.meta.dirname, 'tmp-eval-'));
  await mkdir(path.join(root, 'adapters'), { recursive: true });
  await writeFile(path.join(root, 'adapters/install-map.json'), `${JSON.stringify({ entries }, null, 2)}\n`, 'utf8');
  return root;
}

async function writeFixtureFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, 'utf8');
}

test('eval:sync reports an in-sync mirror and a drifted projection', async () => {
  const root = await makeFixture();
  try {
    await writeFixtureFile(root, 'evals/suites/core.json', '{"a":1}\n');
    await writeFixtureFile(root, 'evals/references/core.offline.json', '{"b":2}\n');
    await writeFixtureFile(root, '.agents/evals/suites/core.json', '{"a":1}\n');
    await writeFixtureFile(root, '.agents/evals/references/core.offline.json', '{"b":3}\n');

    const plan = await collectEvalSyncPlan({ rootDir: root });
    assert.equal(plan.ok, false);
    assert.equal(plan.projectedCount, 2);
    assert.deepEqual(plan.drift, [{ reason: 'content-drift', source: 'evals/references/core.offline.json', target: '.agents/evals/references/core.offline.json' }]);
    assert.deepEqual(plan.manualActions, []);

    const written = await applyEvalSync({ plan, rootDir: root });
    assert.deepEqual(written, ['.agents/evals/references/core.offline.json']);
    assert.equal(
      await readFile(path.join(root, '.agents/evals/references/core.offline.json'), 'utf8'),
      await readFile(path.join(root, 'evals/references/core.offline.json'), 'utf8'),
    );
    assert.equal((await collectEvalSyncPlan({ rootDir: root })).ok, true);
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('eval:sync creates a missing projection target', async () => {
  const root = await makeFixture();
  try {
    await writeFixtureFile(root, 'evals/suites/core.json', '{"a":1}\n');
    await writeFixtureFile(root, 'evals/references/core.offline.json', '{"b":2}\n');
    const plan = await collectEvalSyncPlan({ rootDir: root });
    assert.ok(plan.drift.every((item) => item.reason === 'missing-target'));
    const { written, plan: after } = await runEvalSync({ rootDir: root, write: true });
    assert.deepEqual(written.sort(), ['.agents/evals/references/core.offline.json', '.agents/evals/suites/core.json']);
    assert.equal(after.ok, true);
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('eval:sync reports missing sources and orphaned mirrors instead of guessing', async () => {
  const root = await makeFixture();
  try {
    await writeFixtureFile(root, 'evals/suites/core.json', '{"a":1}\n');
    await writeFixtureFile(root, '.agents/evals/suites/core.json', '{"a":1}\n');
    await writeFixtureFile(root, '.agents/evals/references/leftover.json', '{}\n');

    const plan = await collectEvalSyncPlan({ rootDir: root });
    assert.equal(plan.ok, false);
    assert.deepEqual(plan.manualActions.map((item) => [item.code, item.path]), [
      ['EVAL_SOURCE_MISSING', 'evals/references/core.offline.json'],
      ['EVAL_TARGET_ORPHAN', '.agents/evals/references/leftover.json'],
    ]);
    const { written } = await runEvalSync({ rootDir: root, write: true });
    assert.deepEqual(written, []);
    assert.equal(await readFile(path.join(root, '.agents/evals/references/leftover.json'), 'utf8'), '{}\n');
  } finally {
    await removeTemporaryDirectory(root);
  }
});
