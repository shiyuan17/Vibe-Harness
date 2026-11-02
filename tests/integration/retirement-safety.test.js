import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applyInstallPlan, createInstallPlan } from '../../scripts/lib/install-planner.js';
import {
  applyRollbackPlan, applyUninstallPlan, createRollbackPlan, createUninstallPlan, writeInstallState,
} from '../../scripts/lib/install-state.js';
import { managedJsonPayload } from '../../scripts/lib/managed-json-config.js';
import { hashManagedBlock } from '../../scripts/lib/managed-block.js';

const rootDir = path.resolve(import.meta.dirname, '../..');
const digest = (content) => createHash('sha256').update(content).digest('hex');

async function fixture(t) {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-retirement-safety-'));
  t.after(() => rm(targetDir, { force: true, recursive: true }));
  return targetDir;
}

async function seed(targetDir, target, content) {
  await mkdir(path.dirname(path.join(targetDir, target)), { recursive: true });
  await writeFile(path.join(targetDir, target), content);
  return {
    contentStrategy: 'replace', created: true, group: 'removed-group',
    owners: ['adapter:codex'], redZone: false, source: 'retired/source',
    sourceHash: digest(content), target, targetHash: digest(content),
  };
}

const planFor = (targetDir) => createInstallPlan({
  dryRun: false, managedAgentsBlock: true, profile: 'minimal', rootDir, targetDir, upgrade: true,
});

test('升级只退役未修改的归属文件并保留运行态与生成目录内的用户内容', async (t) => {
  const targetDir = await fixture(t);
  const owner = await seed(targetDir, '.agents/runtime/tools/retired-tool/package.json', '{}\n');
  const changed = await seed(targetDir, 'old-user-rule.md', 'installed\n');
  await writeFile(path.join(targetDir, changed.target), 'user changes\n');
  const data = '.vibe-harness/session-task-bindings.json';
  await seed(targetDir, data, '{"keep":true}\n');
  const receipt = '.vibe-harness/subagents/receipts/user.json';
  await seed(targetDir, receipt, '{"keep":true}\n');
  const generated = '.agents/runtime/tools/retired-tool/node_modules/user.txt';
  await seed(targetDir, generated, 'user content\n');
  await writeInstallState(targetDir, {
    files: [owner, changed], profile: 'minimal', version: '0.3.0',
    generatedDirectories: [{
      ownerTarget: owner.target, target: '.agents/runtime/tools/retired-tool/node_modules',
    }],
  });
  const plan = await planFor(targetDir);
  assert.ok(plan.actions.some((item) => item.relativeTarget === owner.target && item.kind === 'retire'));
  assert.ok(plan.actions.some((item) => item.relativeTarget === changed.target && item.kind === 'retire-modified'));
  assert.equal(plan.actions.some((item) => ['retire-runtime-state', 'retire-generated-directory'].includes(item.kind)), false);
  plan.redZoneConfirmed = true;
  const result = await applyInstallPlan(plan);
  assert.ok(result.retired.includes(owner.target));
  assert.ok(result.skipped.some((item) => item.target === changed.target));
  await assert.rejects(readFile(path.join(targetDir, owner.target)), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(targetDir, changed.target), 'utf8'), 'user changes\n');
  assert.equal(await readFile(path.join(targetDir, generated), 'utf8'), 'user content\n');
  assert.equal(await readFile(path.join(targetDir, data), 'utf8'), '{"keep":true}\n');
  assert.equal(await readFile(path.join(targetDir, receipt), 'utf8'), '{"keep":true}\n');
  const state = JSON.parse(await readFile(path.join(targetDir, '.vibe-harness/install-state.json'), 'utf8'));
  assert.ok(state.generatedDirectories.some((item) => item.ownerTarget === owner.target));
});

async function seedExecutableConfig(targetDir) {
  const content = JSON.stringify({ mcpServers: { 'vibe-harness-retired': { command: 'retired-runner' }, user: { command: 'user-runner' } } });
  const managedJson = { hookMarker: 'Vibe-Harness safety policy', hooksPath: null, mcpPath: ['mcpServers'], serverPrefix: 'vibe-harness-' };
  const file = await seed(targetDir, 'legacy-tool-config.json', content);
  file.contentStrategy = 'managed-json-object';
  file.managedJson = managedJson;
  file.managedBlockHash = hashManagedBlock(managedJsonPayload(content, managedJson));
  await writeInstallState(targetDir, { files: [file], profile: 'minimal', version: '0.3.0' });
  return { content, file };
}

test('修改过的可执行配置在任何写入前阻止退役事务', async (t) => {
  const targetDir = await fixture(t);
  const { content, file } = await seedExecutableConfig(targetDir);
  const modified = content.replace('retired-runner', 'user-modified-runner');
  await writeFile(path.join(targetDir, file.target), modified);
  const beforeState = await readFile(path.join(targetDir, '.vibe-harness/install-state.json'), 'utf8');
  const plan = await planFor(targetDir);
  plan.redZoneConfirmed = true;
  await assert.rejects(applyInstallPlan(plan), /Cannot safely detach modified executable configuration/);
  await assert.rejects(readFile(path.join(targetDir, 'AGENTS.md')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(targetDir, file.target), 'utf8'), modified);
  assert.equal(await readFile(path.join(targetDir, '.vibe-harness/install-state.json'), 'utf8'), beforeState);
});

test('计划后漂移的可执行配置在事务写入前被拒绝', async (t) => {
  const targetDir = await fixture(t);
  const { content, file } = await seedExecutableConfig(targetDir);
  const plan = await planFor(targetDir);
  plan.redZoneConfirmed = true;
  const modified = content.replace('retired-runner', 'late-edit');
  await writeFile(path.join(targetDir, file.target), modified);
  await assert.rejects(applyInstallPlan(plan), /Executable configuration changed after planning/);
  await assert.rejects(readFile(path.join(targetDir, 'AGENTS.md')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(targetDir, file.target), 'utf8'), modified);
});

test('未修改的受管可执行配置仅解除归属部分并保留用户条目', async (t) => {
  const targetDir = await fixture(t);
  await seedExecutableConfig(targetDir);
  const plan = await planFor(targetDir);
  plan.redZoneConfirmed = true;
  await applyInstallPlan(plan);
  assert.deepEqual(JSON.parse(await readFile(path.join(targetDir, 'legacy-tool-config.json'), 'utf8')), {
    mcpServers: { user: { command: 'user-runner' } },
  });
});

test('卸载与回滚不规划递归目录删除或未登记运行态清理', async (t) => {
  const targetDir = await fixture(t);
  const owner = await seed(targetDir, '.agents/runtime/tools/retired-tool/package.json', '{}\n');
  const generated = '.agents/runtime/tools/retired-tool/node_modules/user.txt';
  await seed(targetDir, generated, 'user content\n');
  await seed(targetDir, '.vibe-harness/tool-state/tools.json', '{"user":"data"}\n');
  await writeInstallState(targetDir, {
    files: [owner], profile: 'minimal', version: '0.3.0',
    generatedDirectories: [{ ownerTarget: owner.target, target: '.agents/runtime/tools/retired-tool/node_modules' }],
  });
  for (const plan of [
    await createRollbackPlan({ targetDir }),
    await createUninstallPlan({ targetDir, allTargets: true }),
  ]) {
    assert.equal(plan.actions.some((item) => ['delete-generated-directory', 'delete-tool-state'].includes(item.kind)), false);
    assert.equal(plan.actions.some((item) => item.target === generated), false);
  }
  assert.equal(await readFile(path.join(targetDir, generated), 'utf8'), 'user content\n');
});

test('卸载与回滚实际执行后仍保留生成目录用户内容与工具状态', async (t) => {
  for (const operation of ['uninstall', 'rollback']) {
    const targetDir = await fixture(t);
    const owner = await seed(targetDir, '.agents/runtime/tools/retired-tool/package.json', '{}\n');
    const generated = '.agents/runtime/tools/retired-tool/node_modules/user.txt';
    await seed(targetDir, generated, 'user content\n');
    const mutableState = '.vibe-harness/tool-state/tools.json';
    await seed(targetDir, mutableState, '{"user":"data"}\n');
    await writeInstallState(targetDir, {
      files: [owner], profile: 'minimal', version: '0.3.0',
      generatedDirectories: [{ ownerTarget: owner.target, target: '.agents/runtime/tools/retired-tool/node_modules' }],
    });
    const plan = operation === 'uninstall'
      ? await createUninstallPlan({ targetDir, allTargets: true, dryRun: false })
      : await createRollbackPlan({ targetDir, dryRun: false });
    const result = operation === 'uninstall' ? await applyUninstallPlan(plan) : await applyRollbackPlan(plan);
    assert.deepEqual(result.skipped, []);
    await assert.rejects(readFile(path.join(targetDir, owner.target)), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(targetDir, generated), 'utf8'), 'user content\n');
    assert.equal(await readFile(path.join(targetDir, mutableState), 'utf8'), '{"user":"data"}\n');
  }
});

test('卸载与回滚在写入前拒绝注入的旧目录与状态清理动作', async (t) => {
  const targetDir = await fixture(t);
  const owner = await seed(targetDir, 'owned-file.md', 'owned\n');
  const generated = 'generated/user.txt';
  await seed(targetDir, generated, 'user content\n');
  await writeInstallState(targetDir, { files: [owner], profile: 'minimal', version: '0.3.0' });
  const beforeState = await readFile(path.join(targetDir, '.vibe-harness/install-state.json'), 'utf8');
  for (const kind of ['delete-generated-directory', 'delete-tool-state']) {
    for (const operation of ['uninstall', 'rollback']) {
      const plan = operation === 'uninstall'
        ? await createUninstallPlan({ targetDir, allTargets: true, dryRun: false })
        : await createRollbackPlan({ targetDir, dryRun: false });
      plan.actions.push({ kind, target: 'generated' });
      await assert.rejects(
        operation === 'uninstall' ? applyUninstallPlan(plan) : applyRollbackPlan(plan),
        /Unsupported .* action/u,
      );
    }
  }
  assert.equal(await readFile(path.join(targetDir, owner.target), 'utf8'), 'owned\n');
  assert.equal(await readFile(path.join(targetDir, generated), 'utf8'), 'user content\n');
  assert.equal(await readFile(path.join(targetDir, '.vibe-harness/install-state.json'), 'utf8'), beforeState);
});
