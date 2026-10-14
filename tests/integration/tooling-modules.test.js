import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { projectDirFromInvocation } from '../../runtime/tools/playwright-cli/run.mjs';

test('playwright-cli 从词法调用路径推导所属项目', () => {
  // A worktree reaches the tool through its `.agents` junction, so
  // `import.meta.url` resolves into the shared primary checkout. The lexical
  // invocation path is the only one that names the project that ran it.
  const projectDir = path.resolve('fixture-project');
  const invocation = path.join(projectDir, '.agents', 'runtime', 'tools', 'playwright-cli', 'run.mjs');
  assert.equal(projectDirFromInvocation(invocation), projectDir);
  // A path that is not the declared tool entry names no project.
  assert.equal(projectDirFromInvocation(path.join(projectDir, 'scripts', 'run.mjs')), null);
  assert.equal(projectDirFromInvocation(path.join(projectDir, '.agents', 'runtime', 'tools', 'playwright-cli')), null);
  // The suffix has to start at a path-component boundary: a sibling directory
  // whose name merely ends with `.agents` is not this project's tool entry.
  assert.equal(projectDirFromInvocation(`${projectDir}.agents/runtime/tools/playwright-cli/run.mjs`.split('/').join(path.sep)), null);
});
