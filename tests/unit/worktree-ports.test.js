import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  allocatePortBlock,
  inferPortPlan,
  isIgnoredPath,
  isPortVariable,
  parseEnvAssignments,
  portsForBlock,
  renderWorktreeEnv,
  validatePortRegistry,
} from '../../scripts/lib/worktree-ports.js';
import { removeTemporaryDirectory } from '../../scripts/lib/temp-cleanup.js';

function registry(overrides = {}) {
  return {
    base: 3000,
    blockSize: 10,
    entries: [],
    schemaVersion: 1,
    variables: ['PORT'],
    ...overrides,
  };
}

test('端口变量是结尾为 PORT 的名称', () => {
  for (const name of ['PORT', 'WEB_PORT', 'API_PORT_2', 'PORT_1']) {
    assert.equal(isPortVariable(name), true, name);
  }
  for (const name of ['PORTER', 'port', 'SUPPORT', 'PROXY']) {
    assert.equal(isPortVariable(name), false, name);
  }
});

test('env 解析保留赋值并忽略注释、空行与引号', () => {
  const values = parseEnvAssignments([
    '# a comment',
    '',
    'PORT=3000',
    'export WEB_PORT="3010"',
    "API_PORT='3020'",
    'not an assignment',
  ].join('\n'));
  assert.deepEqual([...values.entries()], [['PORT', '3000'], ['WEB_PORT', '3010'], ['API_PORT', '3020']]);
});

test('块内的变量从块起点开始编号', () => {
  assert.deepEqual(portsForBlock(3000, 10, 1, ['PORT', 'WEB_PORT']), { PORT: 3010, WEB_PORT: 3011 });
  assert.deepEqual(portsForBlock(4100, 5, 2, ['API_PORT']), { API_PORT: 4110 });
});

test('块分配复用本 task 的块且不会交出已占用的块', () => {
  const allocated = registry({ entries: [{ block: 1, id: 'ENG-1', ports: { PORT: 3010 } }] });
  assert.equal(allocatePortBlock(allocated, { id: 'ENG-1' }), 1);
  assert.equal(allocatePortBlock(allocated, { id: 'ENG-2' }), 2);
  const sparse = registry({ entries: [{ block: 2, id: 'ENG-9', ports: { PORT: 3020 } }] });
  assert.equal(allocatePortBlock(sparse, { id: 'ENG-1' }), 1);
});

test('worktree env 文件携带端口变量与身份字段', () => {
  const text = renderWorktreeEnv({ block: 1, id: 'ENG-1', ports: { PORT: 3010, WEB_PORT: 3011 } });
  assert.deepEqual(text.split('\n').filter(Boolean), [
    'PORT=3010',
    'WEB_PORT=3011',
    'VIBE_HARNESS_WORKTREE_ID=ENG-1',
    'VIBE_HARNESS_WORKTREE_BLOCK=1',
  ]);
});

test('登记表校验在块或端口被共享时 fail-closed', () => {
  assert.equal(validatePortRegistry(registry()).ok, true);
  assert.equal(validatePortRegistry(registry({ schemaVersion: 2 })).error.includes('schemaVersion 1'), true);
  assert.equal(validatePortRegistry(registry({ variables: ['TOKEN'] })).error.includes('port variable'), true);
  assert.equal(validatePortRegistry(registry({ entries: [{ block: 0, id: 'ENG-1', ports: { PORT: 3010 } }] })).ok, false);

  const sharedBlock = validatePortRegistry(registry({
    entries: [
      { block: 1, id: 'ENG-1', ports: { PORT: 3010 } },
      { block: 1, id: 'ENG-2', ports: { PORT: 3020 } },
    ],
  }));
  assert.equal(sharedBlock.ok, false);
  assert.equal(sharedBlock.code, 'WORKTREE_PORT_CONFLICT');

  const sharedPort = validatePortRegistry(registry({
    entries: [
      { block: 1, id: 'ENG-1', ports: { PORT: 3010 } },
      { block: 2, id: 'ENG-2', ports: { PORT: 3010 } },
    ],
  }));
  assert.equal(sharedPort.ok, false);
  assert.equal(sharedPort.code, 'WORKTREE_PORT_CONFLICT');
});

test('端口推断按声明顺序取值并兜底 PORT/3000', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vibe-harness-ports-'));
  try {
    await writeFile(path.join(root, '.env'), 'WEB_PORT=5000\n', 'utf8');
    await writeFile(path.join(root, '.env.dev'), 'PORT=6100\n', 'utf8');
    await writeFile(path.join(root, '.gitignore'), 'node_modules\n.vibe-harness/\n', 'utf8');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      scripts: { dev: 'vite --port 4200', serve: 'MOCK_PORT=1 node mock.mjs' },
    }), 'utf8');

    // Declared variables first, then the declared env files, then the main
    // checkout's `.env*` files, then package.json scripts.
    assert.deepEqual(inferPortPlan(root, { declaredVariables: ['API_PORT'], provisionEnvFiles: ['.env.dev'] }), {
      base: 5000,
      files: ['.env', '.env.dev'],
      variables: ['API_PORT', 'PORT', 'WEB_PORT', 'MOCK_PORT'],
    });
    // A configured base wins over every inferred one.
    assert.equal(inferPortPlan(root, { configuredBase: 4100 }).base, 4100);

    assert.equal(isIgnoredPath(root, '.vibe-harness/worktree.env'), true);
    assert.equal(isIgnoredPath(root, 'node_modules/dep/index.js'), true);
    assert.equal(isIgnoredPath(root, '.env'), false);

    // Without any declaration the contract falls back to PORT at 3000.
    const bare = path.join(root, 'bare');
    await mkdir(bare, { recursive: true });
    await writeFile(path.join(bare, 'package.json'), '{"name":"bare"}\n', 'utf8');
    assert.deepEqual(inferPortPlan(bare), { base: 3000, files: [], variables: ['PORT'] });
  } finally {
    await removeTemporaryDirectory(root);
  }
});
