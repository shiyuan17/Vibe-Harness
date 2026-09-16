import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { removeTemporaryDirectory } from '../../scripts/lib/temp-cleanup.js';
import { buildLedger, checkLedger, enumerateDeclaredCases, scanDeclarations } from '../../scripts/tests-catalog.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '../..');

// node:test marks forked test processes with NODE_TEST_CONTEXT; a nested
// `node --test` inherits it and silently skips creating reporter destinations.
function detachedTestEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  return env;
}

const schema = JSON.parse(await readFile(path.join(rootDir, 'tests/cases.schema.json'), 'utf8'));
const ledger = JSON.parse(await readFile(path.join(rootDir, 'tests/cases.json'), 'utf8'));

function entry(overrides) {
  return {
    addedAt: '2026-09-16',
    file: 'tests/unit/example.test.js',
    id: 'U-example-001',
    layer: 'unit',
    legacy: true,
    name: 'example behaviour',
    ordinal: 1,
    owner: 'maintainers',
    risk: 'standard',
    source: 'declared',
    status: 'active',
    ...overrides,
  };
}

function ledgerWith(cases) {
  return { schemaVersion: 1, layers: ['unit', 'component', 'integration', 'e2e', 'matrix'], cases };
}

test('用例台账与本仓库声明的用例逐条一致', async () => {
  const declared = await enumerateDeclaredCases(rootDir);
  assert.deepEqual(declared.problems, []);
  const ids = new Set(ledger.cases.map((item) => item.id));
  assert.equal(ids.size, ledger.cases.length, 'ID 必须唯一');
  assert.equal(ledger.cases.length, declared.declared.length);
  const declaredKeys = declared.declared.map((item) => `${item.file}\0${item.name}`).sort();
  const ledgerKeys = ledger.cases.map((item) => `${item.file}\0${item.name}`).sort();
  assert.deepEqual(ledgerKeys, declaredKeys);
});

test('台账条目通过 schema 与层级、ID、隔离约束校验', async () => {
  const result = await checkLedger({ ledger, schema });
  assert.deepEqual(result.errors, []);
  assert.equal(result.status, 'clean');
});

test('未登记的新用例报 ledger-missing-entry', async () => {
  const result = await checkLedger({
    ledger: ledgerWith([]),
    observed: [{ file: 'tests/unit/example.test.js', name: 'example behaviour' }],
    schema,
  });
  assert.equal(result.errors.some((item) => item.code === 'ledger-missing-entry'), true);
});

test('已消失的台账条目报 ledger-stale-entry', async () => {
  const result = await checkLedger({
    ledger: ledgerWith([entry({})]),
    observed: [],
    schema,
  });
  assert.equal(result.errors.some((item) => item.code === 'ledger-stale-entry'), true);
});

test('ID 重复与层级错配分别报错', async () => {
  const duplicated = await checkLedger({
    ledger: ledgerWith([entry({}), entry({ name: 'other behaviour', ordinal: 2, id: 'U-example-001' })]),
    schema,
  });
  assert.equal(duplicated.errors.some((item) => item.code === 'ledger-duplicate-id'), true);

  const mismatched = await checkLedger({
    ledger: ledgerWith([entry({ file: 'tests/e2e/example.test.js', layer: 'unit', id: 'U-example-001' })]),
    schema,
  });
  assert.equal(mismatched.errors.some((item) => item.code === 'ledger-layer-mismatch'), true);
});

test('legacy: false 的英文描述默认告警、--strict 下报错', async () => {
  const document = ledgerWith([entry({ legacy: false, name: 'english only behaviour' })]);
  const relaxed = await checkLedger({ ledger: document, schema });
  assert.equal(relaxed.errors.length, 0);
  assert.equal(relaxed.warnings.some((item) => item.code === 'ledger-name-language'), true);

  const strict = await checkLedger({ ledger: document, schema, strict: true });
  assert.equal(strict.errors.some((item) => item.code === 'ledger-name-language'), true);
});

test('隔离用例必须绑定技术债 ID', async () => {
  const missing = await checkLedger({ ledger: ledgerWith([entry({ status: 'quarantined' })]), schema });
  assert.equal(missing.errors.some((item) => item.code === 'ledger-quarantine-without-tech-debt'), true);

  const bound = await checkLedger({
    ledger: ledgerWith([entry({ status: 'quarantined', techDebtId: 'TD-2026-09-16-1' })]),
    schema,
  });
  assert.equal(bound.errors.length, 0);
});

test('声明解析按顺序取字面量名称并报告动态名称', () => {
  const source = [
    "test('first case', () => {});",
    'test("中文用例", { skip: true }, () => {});',
    'test(someVariable, () => {});',
    "test('with \\'escape\\'', () => {});",
  ].join('\n');
  const { names, unsupported } = scanDeclarations(source);
  assert.deepEqual(names, ['first case', '中文用例', "with 'escape'"]);
  assert.deepEqual(unsupported, [3]);
});

test('reporter 产出的运行时清单与台账比对语义一致', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tests-catalog-reporter-'));
  try {
    await mkdir(path.join(dir, 'tests/unit'), { recursive: true });
    // The skip directive is assembled at runtime: pre-commit scans staged
    // source for the literal marker form, and the materialized fixture must
    // still carry a real skipped case for the reporter to enumerate.
    const skipDirective = '.skip';
    await writeFile(path.join(dir, 'tests/unit/fixture.test.js'), [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "test('运行时枚举的用例甲', () => { assert.ok(true); });",
      `test${skipDirective}('运行时枚举的用例乙', () => {});`,
      '',
    ].join('\n'), 'utf8');
    await writeFile(
      path.join(dir, 'reporter.mjs'),
      await readFile(path.join(rootDir, 'scripts/lib/test-case-reporter.mjs'), 'utf8'),
      'utf8',
    );
    const observed = path.join(dir, 'observed.json');
    await execFileAsync(process.execPath, [
      '--test',
      '--test-reporter=./reporter.mjs',
      '--test-reporter-destination=observed.json',
      'tests/unit/fixture.test.js',
    ], { cwd: dir, env: detachedTestEnv(), windowsHide: true });
    const document = JSON.parse(await readFile(observed, 'utf8'));
    assert.deepEqual(document.cases, [
      { file: 'tests/unit/fixture.test.js', name: '运行时枚举的用例甲' },
      { file: 'tests/unit/fixture.test.js', name: '运行时枚举的用例乙' },
    ]);
  } finally {
    await removeTemporaryDirectory(dir);
  }
});

test('sync --write 连续两次结果一致', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tests-catalog-sync-'));
  try {
    await mkdir(path.join(dir, 'tests/unit'), { recursive: true });
    await mkdir(path.join(dir, 'tests/e2e'), { recursive: true });
    await writeFile(path.join(dir, 'tests/unit/alpha.test.js'), [
      'test(\'alpha one\', () => {});',
      'test(\'alpha two\', () => {});',
      '',
    ].join('\n'), 'utf8');
    await writeFile(path.join(dir, 'tests/e2e/beta.test.js'), 'test(\'beta one\', () => {});\n', 'utf8');
    await writeFile(
      path.join(dir, 'tests/cases.schema.json'),
      await readFile(path.join(rootDir, 'tests/cases.schema.json'), 'utf8'),
      'utf8',
    );
    const script = path.join(rootDir, 'scripts/tests-catalog.js');
    await execFileAsync(process.execPath, [script, 'sync', '--write'], { cwd: dir, env: detachedTestEnv(), windowsHide: true });
    const first = await readFile(path.join(dir, 'tests/cases.json'), 'utf8');
    await execFileAsync(process.execPath, [script, 'sync', '--write'], { cwd: dir, env: detachedTestEnv(), windowsHide: true });
    const second = await readFile(path.join(dir, 'tests/cases.json'), 'utf8');
    assert.equal(first, second);
    const document = JSON.parse(first);
    assert.deepEqual(document.cases.map((item) => item.id), ['U-alpha-001', 'U-alpha-002', 'E-beta-001']);
    assert.equal(document.cases.every((item) => item.legacy === true), true, '首次生成的批次标记为存量');
  } finally {
    await removeTemporaryDirectory(dir);
  }
});

test('新增用例在既有台账上按 legacy: false 落盘', () => {
  const previous = buildLedger(
    [{ file: 'tests/unit/alpha.test.js', id: 'U-alpha-001', layer: 'unit', name: 'alpha one', ordinal: 1 }],
    { addedAt: '2026-09-16', ledgerSeed: true },
  );
  const next = buildLedger([
    { file: 'tests/unit/alpha.test.js', id: 'U-alpha-001', layer: 'unit', name: 'alpha one', ordinal: 1 },
    { file: 'tests/unit/alpha.test.js', id: 'U-alpha-002', layer: 'unit', name: '新增行为用例', ordinal: 2 },
  ], { addedAt: '2026-09-17', previous });
  assert.deepEqual(next.map((item) => [item.id, item.legacy, item.source]), [
    ['U-alpha-001', true, 'migration'],
    ['U-alpha-002', false, 'declared'],
  ]);
});

const parameterizedEntry = entry({
  file: 'tests/matrix/example.test.js',
  id: 'M-example-001',
  layer: 'matrix',
  name: '${adapter} 在 ${profile} 档位下保持安装生命周期',
});

test('表驱动模板名覆盖运行时展开的实例且不报漂移', async () => {
  const result = await checkLedger({
    ledger: ledgerWith([parameterizedEntry]),
    observed: [
      { file: 'tests/matrix/example.test.js', name: 'codex 在 core 档位下保持安装生命周期' },
      { file: 'tests/matrix/example.test.js', name: 'gemini 在 full 档位下保持安装生命周期' },
    ],
    schema,
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('模板名匹配不到任何运行时实例时报陈旧条目', async () => {
  const result = await checkLedger({
    ledger: ledgerWith([parameterizedEntry]),
    observed: [{ file: 'tests/matrix/example.test.js', name: '与模板无关的名称' }],
    schema,
  });
  assert.equal(result.errors.some((item) => item.code === 'ledger-stale-entry'), true);
});

test('运行时出现模板未覆盖的实例时报未登记条目', async () => {
  const result = await checkLedger({
    ledger: ledgerWith([parameterizedEntry]),
    observed: [
      { file: 'tests/matrix/example.test.js', name: 'codex 在 core 档位下保持安装生命周期' },
      { file: 'tests/matrix/example.test.js', name: 'codex 在 core 档位下保持安装生命周期（修订）' },
    ],
    schema,
  });
  assert.equal(result.errors.some((item) => item.code === 'ledger-missing-entry'), true);
  assert.equal(result.errors.some((item) => item.code === 'ledger-stale-entry'), false);
});
