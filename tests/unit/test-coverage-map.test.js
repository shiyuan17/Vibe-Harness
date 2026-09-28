import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildTestCoverageMap, extractLocalSpecifiers } from '../../scripts/lib/test-coverage-map.js';

test('静态导入提取覆盖四种语句形态并忽略裸与 node: 说明符', () => {
  const source = [
    "import { shared } from './shared.js';",
    "import './setup.js';",
    "import data from '../fixtures/data.json';",
    "export { reexport } from './helpers/helper.js';",
    "const dynamic = () => import('../lazy/lazy.js');",
    "import fs from 'node:fs/promises';",
    "import lodash from 'lodash';",
  ].join('\n');
  assert.deepEqual(extractLocalSpecifiers(source, 'tests/unit/example.test.js'), [
    'tests/fixtures/data.json',
    'tests/lazy/lazy.js',
    'tests/unit/helpers/helper.js',
    'tests/unit/setup.js',
    'tests/unit/shared.js',
  ]);
});

test('覆盖映射沿相对导入传递并解析省略的扩展名', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-covers-'));
  try {
    await mkdir(path.join(target, 'tests/unit'), { recursive: true });
    await mkdir(path.join(target, 'scripts/lib'), { recursive: true });
    await writeFile(path.join(target, 'tests/unit/alpha.test.js'), "import { helper } from '../../scripts/lib/helper.js';\n");
    await writeFile(path.join(target, 'scripts/lib/helper.js'), "import { deep } from './deep';\n");
    await writeFile(path.join(target, 'scripts/lib/deep.js'), 'export const deep = 1;\n');
    const covers = await buildTestCoverageMap(target, { testFiles: ['tests/unit/alpha.test.js'] });
    assert.deepEqual(covers, {
      'tests/unit/alpha.test.js': ['scripts/lib/deep.js', 'scripts/lib/helper.js'],
    });
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('覆盖映射在导入环上终止且为每个测试文件保留条目', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-covers-'));
  try {
    await mkdir(path.join(target, 'tests/unit'), { recursive: true });
    await mkdir(path.join(target, 'scripts/lib'), { recursive: true });
    await writeFile(path.join(target, 'tests/unit/one.test.js'), "import { a } from '../../scripts/lib/a.js';\n");
    await writeFile(path.join(target, 'tests/unit/two.test.js'), '// no imports\n');
    await writeFile(path.join(target, 'scripts/lib/a.js'), "import { b } from './b.js';\nexport const a = 1;\n");
    await writeFile(path.join(target, 'scripts/lib/b.js'), "import { a } from './a.js';\nexport const b = 2;\n");
    const covers = await buildTestCoverageMap(target, {
      testFiles: ['tests/unit/one.test.js', 'tests/unit/two.test.js'],
    });
    assert.deepEqual(Object.keys(covers), ['tests/unit/one.test.js', 'tests/unit/two.test.js']);
    assert.deepEqual(covers['tests/unit/one.test.js'], ['scripts/lib/a.js', 'scripts/lib/b.js']);
    assert.deepEqual(covers['tests/unit/two.test.js'], []);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
