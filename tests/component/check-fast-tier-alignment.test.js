import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { readJson } from '../../scripts/lib/manifest.js';

const rootDir = path.resolve(import.meta.dirname, '../..');
const packageJsonPath = path.join(rootDir, 'package.json');
const configPath = path.join(rootDir, 'vibe-harness.config.json');
const ciPath = path.join(rootDir, '.github/workflows/ci.yml');

// `pnpm check:fast` and the configured quick tier must stay the same command
// set, or the local fast loop and `vibe-harness verify --tier quick` drift
// apart again (audit H-4). Both sides are resolved through package.json
// scripts so the comparison is on the actual executed commands.
function resolveCommand(command, scripts) {
  const match = /^pnpm (\S+)$/u.exec(command);
  if (!match) return command;
  const script = scripts[match[1]];
  assert.equal(typeof script, 'string', `package.json must define the ${match[1]} script referenced by the tier config`);
  return script;
}

test('check:fast 与配置快速层逐命令对齐', async () => {
  const { scripts } = await readJson(packageJsonPath);
  const config = await readJson(configPath);
  const quickCommands = config.validationCommands.tiers.quick;
  const checkFastParts = scripts['check:fast'].split('&&').map((part) => part.trim());
  const resolvedQuick = quickCommands.map((command) => resolveCommand(command, scripts));
  const resolvedFast = checkFastParts.map((command) => resolveCommand(command, scripts));
  assert.deepEqual(resolvedQuick, resolvedFast);
  assert.equal(quickCommands.includes('pnpm test:component'), false, '组件测试不属于快速层');
});

test('check 是 check:full 的别名且保留完整门禁组成', async () => {
  const { scripts } = await readJson(packageJsonPath);
  assert.equal(scripts.check, 'pnpm check:full');
  const full = scripts['check:full'];
  const expected = [
    'node ./scripts/lint.js',
    'pnpm lint:eslint',
    'pnpm typecheck',
    'node ./scripts/validate.js',
    'node ./scripts/tests-catalog.js check',
    'pnpm test:unit',
    'pnpm test:component',
  ];
  let cursor = -1;
  for (const fragment of expected) {
    const index = full.indexOf(fragment, cursor + 1);
    assert.ok(index > cursor, `check:full 必须按序包含 ${fragment}`);
    cursor = index;
  }
});

test('CI fast-gate 以 check:fast 承载快速层并在 docs-only 变更时跳过代码基线', async () => {
  const ci = await readFile(ciPath, 'utf8');
  const lines = ci.split('\n');
  const start = lines.findIndex((line) => line === '  fast-gate:');
  assert.ok(start >= 0, 'ci.yml 必须保留 fast-gate 任务');
  let end = lines.findIndex((line, index) => index > start && /^ {2}[^\s]/u.test(line));
  if (end === -1) end = lines.length;
  const section = lines.slice(start, end).join('\n');
  // docs-only diffs cannot affect eslint/typecheck/unit results, so both steps
  // are gated on the change-plan docsOnly output instead of running blindly.
  assert.match(section, /if: needs\.change-plan\.outputs\.docsOnly != 'true'\s*\n\s*run: pnpm lint:eslint/u, 'ESLint 仅在非 docs-only 变更时执行');
  assert.match(section, /if: needs\.change-plan\.outputs\.docsOnly != 'true'\s*\n\s*run: pnpm check:fast/u, '快速层以单一具名命令执行且非 docs-only 才运行');
  assert.doesNotMatch(section, /run: pnpm typecheck/u, 'typecheck 已并入 check:fast，不得重复执行');
  assert.doesNotMatch(section, /run: pnpm lint\n/u, 'lint.js 已并入 check:fast，不得单独步骤执行');
  assert.doesNotMatch(section, /run: pnpm test:unit/u, '单元测试已并入 check:fast，不得单独步骤执行');
  assert.match(section, /pnpm tests:catalog check --observed \.vibe-harness\/observed-tests\/unit\.json/u);
});

test('组件测试归入中等层且深度层契约不变', async () => {
  const config = await readJson(configPath);
  const tiers = config.validationCommands.tiers;
  assert.deepEqual(tiers.standard, ['pnpm test:component', 'pnpm test:integration']);
  assert.deepEqual(tiers.deep, ['pnpm eval:replay', 'pnpm test:e2e', 'pnpm test:matrix', 'pnpm smoke:lifecycle']);
});
