import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { writeDefaultProjectConfig } from '../../scripts/lib/project-config.js';

const execFileAsync = promisify(execFile);
const entry = path.resolve(import.meta.dirname, '../../scripts/vibe-harness.js');

test('已退役和未知命令在读取项目或写入前拒绝', async (t) => {
  const project = await mkdtemp(path.join(tmpdir(), 'vibe-retired-cli-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  for (const command of ['verify', 'baseline', 'eval', 'audit', 'find', 'provision', 'task', 'worktree', 'unknown-command']) {
    await assert.rejects(execFileAsync(process.execPath, [entry, command, '--project', project, '--write']), (error) => {
      assert.equal(error.code, 1, command);
      const report = JSON.parse(error.stderr);
      assert.equal(report.ok, false);
      assert.equal(report.error.code, 'VIBE_HARNESS_COMMAND_UNSUPPORTED');
      return true;
    });
  }
  assert.deepEqual(await readdir(project), []);
});

test('生命周期命令拒绝通过旧参数静默启用已退役功能', async (t) => {
  const project = await mkdtemp(path.join(tmpdir(), 'vibe-retired-options-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  for (const option of ['profile', 'preset', 'modules', 'plugin', 'provision', 'skip-provision', 'verify', 'full', 'tier', 'scope', 'async', 'plan', 'no-reuse', 'delivery']) {
    await assert.rejects(execFileAsync(process.execPath, [entry, 'install', '--project', project, `--${option}`, '--write']), (error) => {
      assert.equal(error.code, 1, option);
      assert.match(JSON.parse(error.stderr).error.message, /Unknown or retired option/u);
      return true;
    });
  }
  assert.deepEqual(await readdir(project), []);
});

test('帮助仅列安装生命周期命令且未知输出格式不掩盖错误', async () => {
  const { stdout } = await execFileAsync(process.execPath, [entry, 'help']);
  assert.match(stdout, /init\|install\|validate\|doctor\|diff\|rollback\|uninstall\|recover\|help/u);
  assert.doesNotMatch(stdout, /--profile|--preset|--modules|--plugin|--tier/u);
  await assert.rejects(execFileAsync(process.execPath, [entry, 'verify', '--output', 'markdown']), (error) => {
    assert.equal(JSON.parse(error.stderr).error.code, 'VIBE_HARNESS_COMMAND_UNSUPPORTED');
    return true;
  });
});

test('初始化默认预演且写入需要红区确认并保护已有配置', async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), 'vibe-init-boundary-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const project = path.join(parent, 'new-project');
  const args = [entry, 'init', '--project', project];
  const preview = JSON.parse((await execFileAsync(process.execPath, args)).stdout);
  assert.equal(preview.dryRun, true);
  assert.deepEqual(preview.written, []);
  assert.deepEqual(await readdir(parent), []);
  await assert.rejects(execFileAsync(process.execPath, [...args, '--write']), /confirm-red-zone/u);
  assert.deepEqual(await readdir(parent), []);
  const result = JSON.parse((await execFileAsync(process.execPath, [...args, '--write', '--confirm-red-zone'])).stdout);
  assert.equal(result.dryRun, false);
  const configPath = path.join(project, 'vibe-harness.config.json');
  const before = await readFile(configPath, 'utf8');
  await assert.rejects(execFileAsync(process.execPath, [...args, '--write', '--confirm-red-zone']), /Refusing to overwrite/u);
  assert.equal(await readFile(configPath, 'utf8'), before);
});

test('旧预设配置不能在安装时触发隐式工具托管', async (t) => {
  const project = await mkdtemp(path.join(tmpdir(), 'vibe-no-provision-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  await writeDefaultProjectConfig({ preset: 'everything', profile: 'full', projectDir: project });
  const { stdout } = await execFileAsync(process.execPath, [
    entry, 'install', '--project', project, '--write', '--confirm-red-zone',
  ], {
    timeout: 30000,
    env: { ...process.env, npm_config_offline: 'true', VIBE_HARNESS_TEST_OFFLINE: '1' },
  });
  const report = JSON.parse(stdout);
  assert.equal(report.ok, true);
  assert.equal(Object.hasOwn(report, 'provisioning'), false);
  assert.equal(report.warnings.some((warning) => warning.code === 'PROVISIONING_NOT_RUN'), false);
  for (const target of [
    '.vibe-harness/tool-state/tools.json', '.vibe-harness/tool-state/provisioning.json',
    '.agents/runtime/tools/playwright-cli/node_modules', '.agents/runtime/tools/chrome-devtools-mcp/node_modules',
  ]) {
    await assert.rejects(readdir(path.join(project, target)), { code: 'ENOENT' });
  }
});
