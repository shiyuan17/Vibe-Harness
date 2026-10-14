import '../helpers/offline-tools.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { applyInstallPlan, createInstallPlan, previewInstallPlan } from '../../scripts/lib/install-planner.js';
import { parsePluginsOption } from '../../scripts/lib/module-selection.js';
import { migrateRetiredTools } from '../../scripts/lib/retired-tools.js';
import { extractManagedMcpBlock, mergeManagedMcpBlock } from '../../scripts/lib/tool-provisioning.js';
import { managedJsonPayload } from '../../scripts/lib/managed-json-config.js';
import { classifyMcpToolName, mcpToolPolicy } from '../../runtime/hooks/lib/read-only-commands.mjs';

const rootDir = path.resolve(import.meta.dirname, '../..');
const execute = promisify(execFile);
const digest = content => createHash('sha256').update(content).digest('hex');

async function runCli(targetDir, args) {
  const { stdout } = await execute(process.execPath, [path.join(rootDir, 'scripts/vibe-harness.js'), ...args, '--project', targetDir], {
    cwd: rootDir, env: { ...process.env, VIBE_HARNESS_TEST_OFFLINE: '1' }, maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function exists(filename) {
  try { await access(filename); return true; } catch { return false; }
}

async function legacyFixture({ modified = false, shared = false, target = 'codex' } = {}) {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-tool-retirement-'));
  await runCli(targetDir, ['init', '--target', target, '--profile', 'core']);
  await runCli(targetDir, ['install', '--write', '--confirm-red-zone']);
  const statePath = path.join(targetDir, '.vibe-harness/install-state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const configPath = path.join(targetDir, 'vibe-harness.config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.plugins = ['rtk', 'ast-grep', 'codegraph', 'serena', 'probe', 'codebase-memory'];
  if (shared) config.plugins.push('chrome-devtools');
  config.hooks = { ...config.hooks, rtk: { enabled: true } };
  config.worktree = { ...config.worktree, mirrors: ['.agents', '.custom-external-index'] };
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
  state.requestedPlugins = [...config.plugins];
  state.resolvedModules.push(...config.plugins);
  state.rtkHooksEnabled = true;
  const artifacts = [
    ['docs/rules/rtk.md', 'rules-rtk', '# old rule\n'],
    ['docs/rules/codegraph.md', 'rules-codegraph', '# old graph rule\n'],
    ['.agents/runtime/tools/codebase-memory-mcp/run.mjs', 'tools-codebase-memory', 'old wrapper\n'],
    ['.agents/runtime/tools/codebase-memory-mcp/package.json', 'tools-codebase-memory', '{"private":true}\n'],
  ];
  for (const [relativeTarget, group, content] of artifacts) {
    const filename = path.join(targetDir, relativeTarget);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, content);
    state.files.push({ target: relativeTarget, source: relativeTarget, sourceHash: digest(content), targetHash: digest(content), group, created: true, redZone: false, owner: 'vibe-harness', owners: ['shared'] });
  }
  const mcpPath = target === 'codex' ? '.codex/config.toml' : target === 'cursor' ? '.cursor/mcp.json' : '.mcp.json';
  const server = { args: ['old-wrapper.mjs'], command: 'node', env: {} };
  const active = shared ? { 'chrome-devtools': { args: ['chrome.mjs'], command: 'node', env: {} } } : {};
  const mcpContent = target === 'codex'
    ? mergeManagedMcpBlock('model = "local"\n[mcp_servers.external]\ncommand = "external"\n', { ...active, 'codebase-memory-mcp': server }).content
    : JSON.stringify({ mcpServers: { external: { command: 'external' }, ...Object.fromEntries(Object.entries(active).map(([name, value]) => ['vibe-harness-' + name, value])), 'vibe-harness-codebase-memory-mcp': server } }, null, 2) + '\n';
  await mkdir(path.dirname(path.join(targetDir, mcpPath)), { recursive: true });
  await writeFile(path.join(targetDir, mcpPath), mcpContent);
  const descriptor = { hookMarker: 'Vibe-Harness', mcpPath: ['mcpServers'], serverPrefix: 'vibe-harness-' };
  state.files.push({
    target: mcpPath, source: mcpPath, targetHash: digest(mcpContent), sourceHash: digest(mcpContent),
    group: 'mcp-config', created: false, redZone: true, owner: 'vibe-harness', owners: ['adapter:' + target],
    contentStrategy: target === 'codex' ? 'managed-toml-block' : 'managed-json-object',
    ...(target === 'codex' ? {} : { managedJson: descriptor }),
    managedBlockHash: digest(target === 'codex' ? extractManagedMcpBlock(mcpContent) : managedJsonPayload(mcpContent, descriptor)),
  });
  const ignoreContent = 'user-rule\n# VIBE_HARNESS:CBM:START\n/.agents/\n# VIBE_HARNESS:CBM:END\n';
  await writeFile(path.join(targetDir, '.cbmignore'), ignoreContent);
  state.files.push({
    target: '.cbmignore', source: 'legacy-ignore', sourceHash: digest(ignoreContent), targetHash: digest(ignoreContent),
    managedBlockHash: digest('# VIBE_HARNESS:CBM:START\n/.agents/\n# VIBE_HARNESS:CBM:END'),
    group: 'tools-codebase-memory', created: false, redZone: false, contentStrategy: 'managed-ignore-block',
  });
  state.generatedDirectories ??= [];
  state.generatedDirectories.push({
    ownerTarget: '.agents/runtime/tools/codebase-memory-mcp/package.json',
    target: '.vibe-harness/tool-state/codebase-memory-mcp', projectScoped: true,
  });
  await mkdir(path.join(targetDir, '.vibe-harness/tool-state/codebase-memory-mcp'), { recursive: true });
  await writeFile(path.join(targetDir, '.vibe-harness/tool-state/codebase-memory-mcp/index.db'), 'external-index');
  await writeFile(path.join(targetDir, 'unmanaged-tool.txt'), 'user-owned');
  if (modified) {
    await writeFile(path.join(targetDir, 'docs/rules/rtk.md'), '# user-edited\n');
    await writeFile(path.join(targetDir, mcpPath), mcpContent.replace('old-wrapper.mjs', 'user-wrapper.mjs'));
  }
  await writeFile(statePath, JSON.stringify(state, null, 2) + '\n');
  return { targetDir, statePath, configPath, mcpPath };
}

for (const profile of ['minimal', 'core', 'full', 'docs-only']) {
  test(`新安装 ${profile} 只分发适用的外部图规范`, async () => {
    const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-external-graph-'));
    try {
      const plan = await createInstallPlan({ rootDir, targetDir, profile });
      const targets = plan.actions.map(action => action.relativeTarget);
      assert.equal(targets.includes('docs/rules/codebase-memory-mcp.md'), profile !== 'minimal');
      assert.equal(targets.some(value => /tools\/(rtk|ast-grep|codebase-memory-mcp)\//u.test(value)), false);
      assert.equal(targets.includes('.cbmignore'), false);
      const preview = await previewInstallPlan(plan);
      assert.doesNotMatch(JSON.stringify(preview), /codebase-memory (?:status|refresh)|CBM_CACHE_DIR|rtk-hooks/u);
    } finally { await rm(targetDir, { force: true, recursive: true }); }
  });
}

test('退役插件拒绝新请求且 all 只包含三个受管工具', () => {
  assert.deepEqual(parsePluginsOption('all'), ['chrome-devtools', 'playwright', 'open-code-review']);
  for (const name of ['rtk', 'ast-grep', 'codegraph', 'serena', 'probe', 'codebase-memory-mcp']) {
    assert.throws(() => parsePluginsOption(name), /retired/u);
  }
  const result = migrateRetiredTools({ modules: ['rules', 'rtk'], plugins: ['codebase-memory', 'playwright'], hooks: { rtk: { enabled: true }, enforcement: 'strict' } });
  assert.deepEqual(result.config, { modules: ['rules'], plugins: ['playwright'], hooks: { enforcement: 'strict' } });
  const preset = { preset: 'everything', profile: 'full' };
  assert.deepEqual(migrateRetiredTools(preset, { requestedPlugins: ['rtk', 'codebase-memory'] }).config, preset);
});

for (const target of ['codex', 'cursor']) {
  test(`共享 ${target} MCP 配置只退役旧服务`, async () => {
    const fixture = await legacyFixture({ target, shared: true });
    try {
      await runCli(fixture.targetDir, ['install', '--upgrade', '--write', '--confirm-red-zone']);
      const content = await readFile(path.join(fixture.targetDir, fixture.mcpPath), 'utf8');
      assert.match(content, /external/u);
      assert.match(content, /chrome-devtools/u);
      assert.doesNotMatch(content, /codebase-memory/u);
    } finally { await rm(fixture.targetDir, { force: true, recursive: true }); }
  });
  test(`共享 ${target} MCP 配置有用户修改时整体保留`, async () => {
    const fixture = await legacyFixture({ target, shared: true, modified: true });
    try {
      const before = await readFile(path.join(fixture.targetDir, fixture.mcpPath), 'utf8');
      const report = await runCli(fixture.targetDir, ['install', '--upgrade', '--write', '--confirm-red-zone']);
      assert.equal(await readFile(path.join(fixture.targetDir, fixture.mcpPath), 'utf8'), before);
      assert.ok(report.skipped.some(item => item.target === fixture.mcpPath));
    } finally { await rm(fixture.targetDir, { force: true, recursive: true }); }
  });
}

for (const operation of ['rollback', 'uninstall']) {
  test(`${operation} 旧安装不清理索引目录`, async () => {
    const fixture = await legacyFixture();
    try {
      await runCli(fixture.targetDir, [operation, '--write', '--confirm-red-zone', ...(operation === 'uninstall' ? ['--all-targets'] : [])]);
      assert.equal(await readFile(path.join(fixture.targetDir, '.vibe-harness/tool-state/codebase-memory-mcp/index.db'), 'utf8'), 'external-index');
    } finally { await rm(fixture.targetDir, { force: true, recursive: true }); }
  });
}

test('退役拒绝通过目录链接删除工作区外文件', async () => {
  const fixture = await legacyFixture();
  const outside = await mkdtemp(path.join(tmpdir(), 'vibe-harness-external-runtime-'));
  const link = path.join(fixture.targetDir, '.agents/runtime/tools/codebase-memory-mcp');
  try {
    await writeFile(path.join(outside, 'run.mjs'), 'outside-owned');
    await rm(link, { recursive: true });
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(runCli(fixture.targetDir, ['install', '--upgrade', '--write', '--confirm-red-zone']), /outside|symlink|symbolic|escape/iu);
    assert.equal(await readFile(path.join(outside, 'run.mjs'), 'utf8'), 'outside-owned');
  } finally {
    await rm(link, { force: true });
    await rm(fixture.targetDir, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  }
});

test('外部图规范覆盖注册标识、缺口、分页和无安装假设', async () => {
  const rule = await readFile(path.join(rootDir, 'docs/rules/codebase-memory-mcp.md'), 'utf8');
  for (const token of ['list_projects', 'index_status', 'check_index_coverage', '分页', '未知工具', '不锁定版本', '不假设共享主检出索引', 'search_code', 'get_graph_schema', 'get_file_outline', 'compare_graphs', 'trace_call_path', '.cbmignore']) assert.ok(rule.includes(token), token);
  assert.doesNotMatch(rule, /0\.11\.0|CBM_CACHE_DIR|codebase-memory refresh|codegraph\.md/u);
  assert.equal(mcpToolPolicy('mcp__codebase_memory_mcp__search_graph'), 'read-only');
  assert.equal(mcpToolPolicy('mcp__codebase_memory_mcp__index_repository'), 'workspace-write');
  assert.equal(mcpToolPolicy('mcp__codebase_memory_mcp__delete_project'), 'high-risk');
  assert.equal(mcpToolPolicy('mcp__codebase_memory_mcp__unknown_operation'), null);
  assert.equal(classifyMcpToolName('mcp__codebase_memory_mcp__get_and_rewrite_index'), false);
});

for (const target of ['codex', 'claude']) {
  test(`升级 ${target} 安全退役受管资产并保留外部数据`, async () => {
    const fixture = await legacyFixture({ target });
    try {
      const before = await readFile(fixture.configPath, 'utf8');
      const preview = await runCli(fixture.targetDir, ['install', '--upgrade']);
      assert.ok(preview.retiredToolConfiguration.includes('hooks.rtk'));
      assert.equal(await readFile(fixture.configPath, 'utf8'), before);
      await assert.rejects(runCli(fixture.targetDir, ['install', '--upgrade', '--write']), /confirm-red-zone/u);
      const applied = await runCli(fixture.targetDir, ['install', '--upgrade', '--write', '--confirm-red-zone']);
      assert.ok(applied.retired.includes('docs/rules/rtk.md'));
      assert.equal(await exists(path.join(fixture.targetDir, '.agents/runtime/tools/codebase-memory-mcp/run.mjs')), false);
      const mcp = await readFile(path.join(fixture.targetDir, fixture.mcpPath), 'utf8');
      assert.ok(mcp.includes('external'));
      assert.ok(!mcp.includes('codebase-memory'));
      assert.equal(await readFile(path.join(fixture.targetDir, '.cbmignore'), 'utf8'), 'user-rule\n');
      assert.equal(await readFile(path.join(fixture.targetDir, '.vibe-harness/tool-state/codebase-memory-mcp/index.db'), 'utf8'), 'external-index');
      assert.equal(await readFile(path.join(fixture.targetDir, 'unmanaged-tool.txt'), 'utf8'), 'user-owned');
      const config = JSON.parse(await readFile(fixture.configPath, 'utf8'));
      assert.deepEqual(config.plugins, []);
      assert.equal(config.hooks.rtk, undefined);
      assert.deepEqual(config.worktree.mirrors, ['.agents', '.custom-external-index']);
      const repeated = await runCli(fixture.targetDir, ['install', '--upgrade', '--write', '--confirm-red-zone']);
      assert.deepEqual(repeated.retiredToolConfiguration, []);
      assert.equal(JSON.parse(await readFile(fixture.statePath, 'utf8')).rtkHooksEnabled, undefined);
    } finally { await rm(fixture.targetDir, { force: true, recursive: true }); }
  });
}

test('升级保留修改过的旧规则与 MCP 块', async () => {
  const fixture = await legacyFixture({ modified: true });
  try {
    const report = await runCli(fixture.targetDir, ['install', '--upgrade', '--write', '--confirm-red-zone']);
    assert.ok(report.skipped.some(item => item.target === 'docs/rules/rtk.md'));
    assert.equal(await readFile(path.join(fixture.targetDir, 'docs/rules/rtk.md'), 'utf8'), '# user-edited\n');
    assert.match(await readFile(path.join(fixture.targetDir, fixture.mcpPath), 'utf8'), /user-wrapper/u);
  } finally { await rm(fixture.targetDir, { force: true, recursive: true }); }
});

test('preserve-retired 保留旧资产且升级失败恢复原文件', async () => {
  const fixture = await legacyFixture();
  try {
    const report = await runCli(fixture.targetDir, ['install', '--upgrade', '--write', '--confirm-red-zone', '--preserve-retired']);
    assert.ok(report.retained.includes('docs/rules/rtk.md'));
    const plan = await createInstallPlan({ rootDir, targetDir: fixture.targetDir, profile: 'core', upgrade: true, dryRun: false });
    plan.redZoneConfirmed = true;
    const before = await readFile(path.join(fixture.targetDir, 'AGENTS.md'), 'utf8');
    await assert.rejects(applyInstallPlan(plan, { afterFileWrite() { throw new Error('injected failure'); } }), /injected failure/u);
    assert.equal(await readFile(path.join(fixture.targetDir, 'AGENTS.md'), 'utf8'), before);
    assert.equal(await exists(path.join(fixture.targetDir, 'docs/rules/rtk.md')), true);
  } finally { await rm(fixture.targetDir, { force: true, recursive: true }); }
});
