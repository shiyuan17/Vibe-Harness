import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { readJson } from '../../scripts/lib/manifest.js';
import { removeTemporaryDirectory } from '../../scripts/lib/temp-cleanup.js';
import { OBSERVED_CASES_DIRECTORY } from '../../scripts/lib/test-case-reporter.mjs';
import { TEST_LAYERS } from '../../scripts/lib/test-enumeration.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '../..');
const PREPARE_SCRIPT = './scripts/prepare-observed-tests.mjs';

// A nested `node` started from a test process inherits NODE_TEST_CONTEXT, which
// makes the test runner inside the child skip work it would do in a clean shell.
function detachedTestEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  return env;
}

// `node --test` opens every --test-reporter-destination file before it loads
// the reporter module, so a clean checkout without the gitignored artifact
// directory crashed with ENOENT on Node 22 before the reporter could create it.
// The directory is now guaranteed by an explicit pre-step in the layer scripts.
test('每个测试层脚本先建立产物目录再运行 node --test', async () => {
  const { scripts } = await readJson(path.join(rootDir, 'package.json'));
  for (const { layer, script } of TEST_LAYERS) {
    const command = scripts[script];
    assert.equal(typeof command, 'string', `package.json 必须定义 ${script}`);
    assert.ok(
      command.startsWith(`node ${PREPARE_SCRIPT} && node --test `),
      `${script} 必须先执行 ${PREPARE_SCRIPT}`,
    );
    assert.ok(
      command.includes(`--test-reporter-destination=${OBSERVED_CASES_DIRECTORY}/${layer}.json`),
      `${script} 必须把顶层用例清单写入 ${OBSERVED_CASES_DIRECTORY}/${layer}.json`,
    );
  }
});

test('产物目录前置步骤可在全新工作区创建清单目录', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-observed-dir-'));
  try {
    await execFileAsync(process.execPath, [path.join(rootDir, 'scripts/prepare-observed-tests.mjs')], {
      cwd: target,
      env: detachedTestEnv(),
      windowsHide: true,
    });
    await assert.doesNotReject(
      access(path.join(target, ...OBSERVED_CASES_DIRECTORY.split('/'))),
      `${PREPARE_SCRIPT} 必须在工作区内创建 ${OBSERVED_CASES_DIRECTORY}`,
    );
  } finally {
    await removeTemporaryDirectory(target);
  }
});
