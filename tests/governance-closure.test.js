import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const rootDir = path.resolve('.');
const read = (relativePath) => readFile(path.join(rootDir, relativePath), 'utf8');

test('contributor contract defines one project write lifecycle', async () => {
  const agents = await read('AGENTS.md');
  assert.match(agents, /--project[^\n]*--write/u);
  assert.doesNotMatch(agents, /pnpm cognis[^\n]*(?:codex-internal|codex-minimal|--apply)/u);
});

test('governance kernel defines adaptive and strict stages with adversarial evidence', async () => {
  const kernel = await read('rules/governance-core.md');
  assert.match(kernel, /获取事实 → 直接执行 → 聚焦验证 → 简洁交付/u);
  for (const stage of ['获取事实', '做出决策', '执行', '验证', '交付']) assert.match(kernel, new RegExp(stage, 'u'));
  assert.match(kernel, /主张 → 证据 → 反例 → 剩余风险/u);
  assert.match(kernel, /问题编号、理由、责任人、关闭条件和批准者/u);
});

test('governance and coding rules absorb Karpathy discipline without a new skill', async () => {
  const kernel = await read('rules/governance-core.md');
  const coding = await read('rules/coding-rules.md');
  const skills = JSON.parse(await read('manifests/skills.json'));
  const rules = JSON.parse(await read('manifests/rules.json'));
  const installMap = JSON.parse(await read('adapters/codex/install-map.json'));

  assert.match(kernel, /关键假设.*取舍/u);
  assert.match(kernel, /多种解释.*不得静默选择/u);
  assert.match(kernel, /最简单方案/u);
  assert.match(kernel, /成功标准.*验证方式/u);

  assert.match(coding, /未要求的功能、配置项、扩展点或兼容层/u);
  assert.match(coding, /不处理理论上不可能出现的分支/u);
  assert.match(coding, /追溯到任务目标或验收标准/u);
  assert.match(coding, /本次改动直接产生的无用/u);
  assert.match(coding, /既有无关死代码.*仅报告.*不.*删除/u);

  assert.equal(skills.items.some((item) => item.id === 'karpathy-guidelines'), false);
  assert.equal(rules.items.some((item) => item.id === 'karpathy-guidelines'), false);
  assert.equal(installMap.entries.some((item) => item.source.includes('karpathy-guidelines')), false);
});

test('repository declares CI and cross-platform lifecycle smoke', async () => {
  await access(path.join(rootDir, '.github/workflows/ci.yml'));
  await access(path.join(rootDir, 'scripts/smoke-lifecycles.js'));
  const pkg = JSON.parse(await read('package.json'));
  const ci = await read('.github/workflows/ci.yml');
  assert.equal(pkg.scripts['smoke:lifecycle'], 'node ./scripts/smoke-lifecycles.js');
  assert.match(ci, /pnpm check/u);
  assert.match(ci, /pnpm smoke:lifecycle/u);
  assert.match(ci, /git diff --check/u);
});
