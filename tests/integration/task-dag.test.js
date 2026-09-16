import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { removeTemporaryDirectory } from '../../scripts/lib/temp-cleanup.js';
import {
  computeDagStructureHash,
  normalizeScopeEntry,
  summarizeTaskDag,
  TASK_DAG_SCHEMA,
  validateTaskDag,
  writeConflict,
} from '../../scripts/lib/task-dag.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const TASK_DAG_CLI = path.join(repositoryRoot, 'scripts', 'task-dag.js');

function codes(analysis) {
  return analysis.problems.map((problem) => problem.code);
}

function node(overrides) {
  return { kind: 'read', output: 'note', result: 'pending', verification: ['manual'], ...overrides };
}

// A two-leaf DAG that reads in parallel and fans in on an aggregate node.
function parallelDag() {
  return {
    nodes: [
      node({ id: 'survey-a', result: 'succeeded', verification: ['manual'] }),
      node({ id: 'survey-b', result: 'succeeded', verification: ['manual'] }),
      node({
        id: 'report',
        kind: 'aggregate',
        dependsOn: ['survey-a', 'survey-b'],
        output: 'report',
        result: 'pending',
        verification: ['human review'],
      }),
    ],
    schema: TASK_DAG_SCHEMA,
  };
}

test('a valid DAG reports counts, order, ready set and a stable structure hash', () => {
  const analysis = validateTaskDag(parallelDag());
  assert.equal(analysis.ok, true);
  assert.deepEqual(analysis.counts, { aggregate: 1, read: 2, write: 0 });
  assert.equal(analysis.nodeCount, 3);
  assert.deepEqual(analysis.ready, ['report']);
  assert.deepEqual(analysis.order, ['survey-a', 'survey-b', 'report']);
  assert.equal(analysis.structureHash.length, 64);
  assert.match(summarizeTaskDag(analysis), /status: passed/u);
});

test('the structure hash is order independent and ignores node result', () => {
  const dag = parallelDag();
  const reordered = { nodes: [...dag.nodes].reverse(), schema: TASK_DAG_SCHEMA };
  const shifted = { nodes: dag.nodes.map((entry) => ({ ...entry, result: 'running' })), schema: TASK_DAG_SCHEMA };
  assert.equal(computeDagStructureHash(validateTaskDag(dag).nodes), computeDagStructureHash(validateTaskDag(reordered).nodes));
  assert.equal(validateTaskDag(dag).structureHash, validateTaskDag(shifted).structureHash);
});

test('writeScope accepts project-relative paths and /** ranges only', () => {
  assert.deepEqual(normalizeScopeEntry('src/app.js'), { kind: 'file', path: 'src/app.js', raw: 'src/app.js' });
  assert.deepEqual(normalizeScopeEntry('src\\lib/**'), { kind: 'dir', path: 'src/lib', raw: 'src\\lib/**' });
  for (const invalid of ['', '  ', '/etc/passwd', 'C:/repo/file.js', '\\\\server\\share', '../escape.js', 'src/*.js', 'src/[ab].js']) {
    assert.equal(normalizeScopeEntry(invalid), null, `${invalid} must be rejected`);
  }
});

test('two write nodes on overlapping scopes are not ready without a dependency path', () => {
  const analysis = validateTaskDag({
    nodes: [
      node({ id: 'impl-api', kind: 'write', writeScope: ['src/api/**'], output: 'api' }),
      node({ id: 'impl-ui', kind: 'write', writeScope: ['src/api/handler.js'], output: 'ui' }),
    ],
    schema: TASK_DAG_SCHEMA,
  });
  assert.equal(analysis.ok, false);
  assert.equal(analysis.conflictCount, 1);
  assert.deepEqual(analysis.ready, []);
  assert.deepEqual(codes(analysis).filter((code) => code === 'TASK_DAG_SCOPE_CONFLICT').length, 1);
  assert.deepEqual(
    writeConflict(validateTaskDag({ nodes: [{ id: 'a', kind: 'write', output: 'a', result: 'pending', writeScope: ['src/api/**'] }] }).nodes[0],
      validateTaskDag({ nodes: [{ id: 'b', kind: 'write', output: 'b', result: 'pending', writeScope: ['src/api/**'] }] }).nodes[0]),
    { locks: [], scopes: ['src/api/** <-> src/api/**'] },
  );
});

test('an explicit dependency serializes a scope conflict into a warning', () => {
  const analysis = validateTaskDag({
    nodes: [
      node({ id: 'impl-api', kind: 'write', writeScope: ['src/api/**'], output: 'api', result: 'succeeded' }),
      node({ id: 'impl-ui', kind: 'write', writeScope: ['src/api/handler.js'], output: 'ui', dependsOn: ['impl-api'] }),
    ],
    schema: TASK_DAG_SCHEMA,
  });
  assert.equal(analysis.ok, true);
  assert.equal(analysis.conflictCount, 0);
  assert.deepEqual(analysis.ready, ['impl-ui']);
  assert.deepEqual(codes(analysis), ['TASK_DAG_SERIALIZED_CONFLICT']);
});

test('a shared resource lock is a conflict unless a dependency orders the nodes', () => {
  const lockAgreement = (dependsOn) => validateTaskDag({
    nodes: [
      node({ id: 'migrate', kind: 'write', output: 'migration', resourceLocks: ['db:staging'], result: 'succeeded', writeScope: ['db/migrations/**'] }),
      node({ id: 'seed', kind: 'write', output: 'seed', resourceLocks: ['db:staging'], writeScope: ['db/seed/**'], ...(dependsOn ? { dependsOn } : {}) }),
    ],
    schema: TASK_DAG_SCHEMA,
  });
  assert.equal(lockAgreement(undefined).ok, false);
  assert.deepEqual(codes(lockAgreement(undefined)).filter((code) => code === 'TASK_DAG_RESOURCE_LOCK_CONFLICT').length, 1);
  assert.deepEqual(lockAgreement(undefined).ready, []);
  assert.equal(lockAgreement(['migrate']).ok, true);
  assert.deepEqual(lockAgreement(['migrate']).ready, ['seed']);
});

test('node contract violations fail closed', () => {
  const analysis = validateTaskDag({
    nodes: [
      node({ id: 'read-with-scope', writeScope: ['src/**'] }),
      node({ id: 'write-without-scope', kind: 'write' }),
      node({ id: 'bad-trigger', kind: 'read', trigger: 'all_done' }),
      node({ id: 'bad-result', result: 'done' }),
      node({ id: 'bad-scope', kind: 'write', writeScope: ['../outside.js'], output: 'x' }),
      node({ id: 'no-output', output: '' }),
      node({ id: 'self', kind: 'read', dependsOn: ['self'] }),
    ],
    schema: 'vibe-harness.task-dag/v9',
  });
  assert.equal(analysis.ok, false);
  for (const expected of [
    'TASK_DAG_READ_SCOPE',
    'TASK_DAG_WRITE_SCOPE_REQUIRED',
    'TASK_DAG_ALL_DONE_KIND',
    'TASK_DAG_RESULT_INVALID',
    'TASK_DAG_SCOPE_INVALID',
    'TASK_DAG_OUTPUT_MISSING',
    'TASK_DAG_SELF_DEPENDENCY',
    'TASK_DAG_SCHEMA_UNSUPPORTED',
  ]) {
    assert.ok(codes(analysis).includes(expected), `${expected} must be reported`);
  }
  assert.equal(analysis.readyComputed, false);
});

test('an unknown predecessor and a dependency cycle are reported', () => {
  const unknown = validateTaskDag({ nodes: [node({ id: 'a', dependsOn: ['ghost'] })], schema: TASK_DAG_SCHEMA });
  assert.deepEqual(codes(unknown).filter((code) => code === 'TASK_DAG_UNKNOWN_PREDECESSOR').length, 1);
  assert.equal(unknown.readyComputed, false);

  const cyclic = validateTaskDag({
    nodes: [node({ id: 'a', dependsOn: ['b'] }), node({ id: 'b', dependsOn: ['a'] })],
    schema: TASK_DAG_SCHEMA,
  });
  assert.deepEqual(codes(cyclic).filter((code) => code === 'TASK_DAG_CYCLE').length, 1);
  assert.equal(cyclic.order, null);

  const duplicated = validateTaskDag({ nodes: [node({ id: 'a' }), node({ id: 'a' })], schema: TASK_DAG_SCHEMA });
  assert.deepEqual(codes(duplicated).filter((code) => code === 'TASK_DAG_DUPLICATE_ID').length, 1);
});

test('ready computation honors all_success, all_done and non-terminal blocked', () => {
  const allSuccess = validateTaskDag({
    nodes: [node({ id: 'build', result: 'failed' }), node({ id: 'after', dependsOn: ['build'] })],
    schema: TASK_DAG_SCHEMA,
  });
  assert.deepEqual(allSuccess.ready, []);
  assert.deepEqual(allSuccess.blocked.map((entry) => entry.code), ['TASK_DAG_PREDECESSOR_FAILED']);

  const allDone = validateTaskDag({
    nodes: [
      node({ id: 'build', result: 'failed' }),
      node({ id: 'cleanup', kind: 'aggregate', dependsOn: ['build'], trigger: 'all_done', output: 'cleanup', verification: ['human'] }),
    ],
    schema: TASK_DAG_SCHEMA,
  });
  assert.equal(allDone.ok, true);
  assert.deepEqual(allDone.ready, ['cleanup']);

  const blockedPredecessor = validateTaskDag({
    nodes: [
      node({ id: 'build', result: 'blocked' }),
      node({ id: 'cleanup', kind: 'aggregate', dependsOn: ['build'], trigger: 'all_done', output: 'cleanup', verification: ['human'] }),
    ],
    schema: TASK_DAG_SCHEMA,
  });
  assert.deepEqual(blockedPredecessor.ready, []);
  assert.deepEqual(blockedPredecessor.blocked.map((entry) => entry.code), ['TASK_DAG_WAIT']);
});

test('an unverified node stays non-terminal and never satisfies a successor', () => {
  const allSuccess = validateTaskDag({
    nodes: [node({ id: 'build', result: 'unverified' }), node({ id: 'after', dependsOn: ['build'] })],
    schema: TASK_DAG_SCHEMA,
  });
  assert.equal(allSuccess.ok, true);
  assert.deepEqual(allSuccess.ready, []);
  assert.deepEqual(allSuccess.blocked.map((entry) => entry.code), ['TASK_DAG_WAIT']);
  assert.deepEqual(allSuccess.blocked.map((entry) => entry.reason), ['build=unverified']);

  const allDone = validateTaskDag({
    nodes: [
      node({ id: 'build', result: 'unverified' }),
      node({ id: 'cleanup', kind: 'aggregate', dependsOn: ['build'], trigger: 'all_done', output: 'cleanup', verification: ['human'] }),
    ],
    schema: TASK_DAG_SCHEMA,
  });
  assert.equal(allDone.ok, true);
  assert.deepEqual(allDone.ready, []);
  assert.deepEqual(allDone.blocked.map((entry) => entry.code), ['TASK_DAG_WAIT']);
});

test('a non-list DAG fails closed', () => {
  const analysis = validateTaskDag({ nodes: 'nope' });
  assert.equal(analysis.ok, false);
  assert.deepEqual(codes(analysis), ['TASK_DAG_NOT_A_LIST']);
  assert.equal(analysis.readyComputed, false);
});

test('a node without verification warns instead of failing', () => {
  const analysis = validateTaskDag({ nodes: [node({ id: 'a', verification: [] })], schema: TASK_DAG_SCHEMA });
  assert.equal(analysis.ok, true);
  assert.deepEqual(codes(analysis), ['TASK_DAG_VERIFICATION_MISSING']);
  assert.equal(analysis.warningCount, 1);
  assert.deepEqual(analysis.ready, ['a']);
});

async function runCli(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [TASK_DAG_CLI, ...args], { windowsHide: true });
    return { code: 0, stderr, stdout };
  } catch (error) {
    return { code: error.code, stderr: error.stderr ?? '', stdout: error.stdout ?? '' };
  }
}

test('the CLI checks a file, hashes it and fails closed on a broken DAG', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vibe-task-dag-'));
  try {
    const good = path.join(root, 'dag.json');
    await writeFile(good, JSON.stringify(parallelDag()), 'utf8');
    const checked = await runCli(['check', '--file', good]);
    assert.equal(checked.code, 0, checked.stderr);
    assert.match(checked.stdout, /status: passed/u);
    assert.match(checked.stdout, /ready: report/u);

    const hashed = await runCli(['hash', '--file', good, '--json']);
    assert.equal(hashed.code, 0, hashed.stderr);
    assert.match(JSON.parse(hashed.stdout).structureHash, /^[0-9a-f]{64}$/u);

    const blocked = path.join(root, 'blocked.json');
    await writeFile(blocked, JSON.stringify({ nodes: [node({ id: 'only', result: 'running' })], schema: TASK_DAG_SCHEMA }), 'utf8');
    const notReady = await runCli(['check', '--file', blocked, '--require-ready']);
    assert.equal(notReady.code, 1);
    assert.match(notReady.stderr, /no node is ready to dispatch/u);

    const broken = path.join(root, 'broken.json');
    await writeFile(broken, JSON.stringify({ nodes: [node({ id: 'a', dependsOn: ['ghost'] })], schema: TASK_DAG_SCHEMA }), 'utf8');
    const failed = await runCli(['check', '--file', broken]);
    assert.equal(failed.code, 1);
    assert.match(failed.stdout, /TASK_DAG_UNKNOWN_PREDECESSOR/u);

    const missing = await runCli(['check', '--file', path.join(root, 'absent.json')]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /not readable JSON/u);
    assert.equal((await runCli(['check'])).code, 1);
  } finally {
    await removeTemporaryDirectory(root);
  }
});
