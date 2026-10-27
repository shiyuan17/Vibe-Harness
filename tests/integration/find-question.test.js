import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { createInstallPlan } from '../../scripts/lib/install-planner.js';

const rootDir = path.resolve(import.meta.dirname, '../..');
const execFileAsync = promisify(execFile);
const cli = path.join(rootDir, 'scripts/vibe-harness.js');

async function run(args) {
  try {
    const result = await execFileAsync(process.execPath, [cli, ...args], { cwd: rootDir });
    return { ...result, exitCode: 0 };
  } catch (error) {
    return { stdout: error.stdout, stderr: error.stderr, exitCode: error.code };
  }
}

test('两个 bin 指向同一实现且默认 Markdown 与 JSON 保持计划语义', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'vh-question-cli-'));
  try {
    const pkg = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'));
    assert.equal(pkg.bin.vb, pkg.bin['vibe-harness']);
    const base = ['find', 'question', '--project', temporary];
    const markdown = await run(base);
    const json = await run([...base, '--output', 'json']);
    const alias = await run([...base, '--json']);
    assert.equal(markdown.exitCode, 0, markdown.stderr);
    assert.equal(json.exitCode, 0, json.stderr);
    assert.match(markdown.stdout, /# Find Question/u);
    assert.equal(JSON.parse(json.stdout).status, 'planned');
    assert.deepEqual(JSON.parse(alias.stdout).checks, JSON.parse(json.stdout).checks);
    assert.deepEqual(await readdir(temporary), []);
    const binary = await execFileAsync(process.execPath, [path.resolve(rootDir, pkg.bin.vb), ...base, '--json']);
    assert.deepEqual(JSON.parse(binary.stdout).checks, JSON.parse(json.stdout).checks);
    const written = await run([...base, '--write', '--report', 'audit-reports/packet.md', '--json']);
    assert.equal(written.exitCode, 0, written.stderr);
    assert.equal(JSON.parse(written.stdout).report.written, true);
    assert.match(await readFile(path.join(temporary, 'audit-reports/packet.md'), 'utf8'), /草稿已写入：true/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('CLI 拒绝缺失值、未知参数、错误子命令与越界且不发生写入', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'vh-question-invalid-'));
  try {
    const base = ['find', 'question', '--project', temporary];
    for (const args of [
      ['find', 'other'], ['find', 'question'], ['find', 'question', '--project'],
      [...base, '--depth'], [...base, '--focus'], [...base, '--scope'], [...base, '--report'],
      [...base, '--scope', '../escape'], [...base, '--report', '../escape.md'],
      [...base, '--depth', 'full'], [...base, '--focus', 'typo'],
      [...base, '--write', 'false'], [...base, 'extra'], [...base, '--force'],
      [...base, '--output', 'yaml'], [...base, '--json', '--output', 'markdown'],
      [...base, '--output', 'markdown', '--scope', 'missing'],
    ]) {
      const result = await run(args);
      assert.equal(result.exitCode, 1, JSON.stringify(args));
      assert.equal(JSON.parse(result.stderr).ok, false);
    }
    assert.deepEqual(await readdir(temporary), []);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('真实 Git 基线包含未提交改动且报告创建不会被当成审查完成', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'vh-question-git-'));
  try {
    const git = (args) => execFileAsync('git', args, { cwd: temporary });
    await git(['init']);
    await writeFile(path.join(temporary, 'tracked.txt'), 'before');
    await git(['add', '.']);
    await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture']);
    await writeFile(path.join(temporary, 'tracked.txt'), 'after');
    const result = await run(['find', 'question', '--project', temporary, '--json']);
    const packet = JSON.parse(result.stdout);
    assert.equal(packet.baseline.headSha, (await git(['rev-parse', 'HEAD'])).stdout.trim());
    assert.equal(packet.baseline.worktreeStatus, 'dirty');
    assert.deepEqual(packet.findings, []);
    assert.equal(await readFile(path.join(temporary, 'tracked.txt'), 'utf8'), 'after');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('core 和 full 安装 Skill 全部资源而 minimal 和 docs-only 不虚构 Skill', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'vh-question-install-'));
  try {
    for (const profile of ['minimal', 'core', 'full', 'docs-only']) {
      const targetDir = path.join(temporary, profile);
      await mkdir(targetDir);
      const plan = await createInstallPlan({ rootDir, targetDir, profile, dryRun: true });
      const targets = new Set(plan.actions.map((item) => item.relativeTarget));
      for (const resource of ['SKILL.md', 'metadata.json', 'agents/openai.yaml', 'references/check-matrix.md', 'references/industry-practices.md']) {
        assert.equal(targets.has('.agents/skills/find-question/' + resource), ['core', 'full'].includes(profile));
      }
      assert.equal(targets.has('docs/templates/find-question.md'), true);
      assert.deepEqual(await readdir(targetDir), []);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
