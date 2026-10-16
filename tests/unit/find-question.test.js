import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFindQuestionPacket, DEFAULT_FOCUS, renderFindQuestionMarkdown, validateFindQuestionPacket, writeFindQuestionPacket } from '../../scripts/lib/find-question.js';

const rootDir = path.resolve(import.meta.dirname, '../..');
const now = new Date('2026-10-16T00:00:00.000Z');

async function withProject(action) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'vh-find-question-'));
  const project = await realpath(temporary);
  try {
    return await action(project);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

test('审查包默认深查八类风险且不写文件或伪造发现', async () => {
  await withProject(async (projectDir) => {
    const before = await readdir(projectDir);
    const packet = await createFindQuestionPacket({ projectDir, now });
    await validateFindQuestionPacket(packet, rootDir);
    assert.equal(packet.status, 'planned');
    assert.equal(packet.depth, 'deep');
    assert.equal(packet.readOnly, true);
    assert.equal(packet.report.written, false);
    assert.deepEqual(packet.scope, ['.']);
    assert.deepEqual(packet.findings, []);
    assert.deepEqual(packet.checks.map((item) => item.id), DEFAULT_FOCUS);
    assert.deepEqual(packet.baseline, { headSha: null, worktreeStatus: 'unknown' });
    assert.deepEqual(await readdir(projectDir), before);
    const rendered = renderFindQuestionMarkdown(packet);
    for (const item of packet.checks) {
      assert.ok(rendered.includes(item.title));
      for (const question of item.questions) assert.ok(rendered.includes(question));
    }
    for (const label of packet.evidence.labels) assert.ok(rendered.includes(label));
    assert.ok(rendered.includes('不是已完成审查'));
  });
});

test('档位降低只缩小深度而不默默省略授权和生命周期', async () => {
  await withProject(async (projectDir) => {
    for (const depth of ['quick', 'standard', 'deep']) {
      const packet = await createFindQuestionPacket({ projectDir, depth });
      assert.equal(packet.checks.length, 8);
      const focused = await createFindQuestionPacket({ projectDir, depth, focus: 'lifecycle,authorization,lifecycle' });
      assert.deepEqual(focused.checks.map((item) => item.id), ['authorization', 'lifecycle']);
      assert.equal(focused.focus.length, 2);
      assert.ok(focused.limitations.some((item) => item.includes('未选择')));
    }
  });
});

test('范围拒绝不存在和越界及生成镜像而允许现存文件目录', async () => {
  await withProject(async (projectDir) => {
    await mkdir(path.join(projectDir, 'src'));
    await writeFile(path.join(projectDir, 'src/service.js'), 'export const value = 1;\n');
    const packet = await createFindQuestionPacket({ projectDir, scope: 'src,src/service.js' });
    assert.deepEqual(packet.scope, ['src', 'src/service.js']);
    for (const scope of ['../outside', 'missing', 'node_modules', '.agents', 'docs/templates', 'src/node_modules']) {
      await assert.rejects(createFindQuestionPacket({ projectDir, scope }));
    }
    await assert.rejects(createFindQuestionPacket({ projectDir, depth: 'full' }), /depth/u);
    await assert.rejects(createFindQuestionPacket({ projectDir, focus: 'made-up' }), /focus/u);
  });
});

test('草稿写入限于新报告并保留已有报告与源码', async () => {
  await withProject(async (projectDir) => {
    await writeFile(path.join(projectDir, 'source.js'), 'unchanged');
    for (const report of ['source.js', '.env', '../outside.md', 'audit-reports/sub/report.md', 'audit-reports/report.json', 'audit-reports/report.md:stream']) {
      await assert.rejects(createFindQuestionPacket({ projectDir, report }));
    }
    const packet = await createFindQuestionPacket({ projectDir, now });
    const target = await writeFindQuestionPacket(packet, projectDir);
    assert.equal(packet.report.written, true);
    assert.equal(await readFile(target, 'utf8'), renderFindQuestionMarkdown(packet));
    const next = await createFindQuestionPacket({ projectDir });
    await assert.rejects(writeFindQuestionPacket(next, projectDir), { code: 'EEXIST' });
    assert.equal(next.report.written, false);
    assert.equal(await readFile(path.join(projectDir, 'source.js'), 'utf8'), 'unchanged');
  });
});

test('红区和只读交付配置阻止报告写入但不阻止预览', async () => {
  await withProject(async (projectDir) => {
    for (const config of [
      { hooks: { redZonePaths: ['audit-reports/'] } },
      { riskZones: { red: ['audit-reports'] } },
      { delivery: { default: 'inspect-only' } },
      { delivery: { default: 'custom', profiles: { custom: { write: false } } } },
    ]) {
      await writeFile(path.join(projectDir, 'vibe-harness.config.json'), JSON.stringify(config));
      const packet = await createFindQuestionPacket({ projectDir });
      await assert.rejects(writeFindQuestionPacket(packet, projectDir));
      assert.equal(packet.report.written, false);
      assert.deepEqual(await readdir(projectDir), ['vibe-harness.config.json']);
    }
  });
});

test('链接和目录联接不能用于跨出项目读取或写入', async () => {
  await withProject(async (container) => {
    const projectDir = path.join(container, 'project');
    const outside = path.join(container, 'outside');
    await mkdir(projectDir);
    await mkdir(outside);
    await symlink(outside, path.join(projectDir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(createFindQuestionPacket({ projectDir, scope: 'linked' }), /symbolic link|junction|reparse/u);
    await symlink(outside, path.join(projectDir, 'audit-reports'), process.platform === 'win32' ? 'junction' : 'dir');
    const packet = await createFindQuestionPacket({ projectDir });
    await assert.rejects(writeFindQuestionPacket(packet, projectDir), /symbolic link|junction|reparse/u);
    assert.deepEqual(await readdir(outside), []);
  });
});

test('schema 拒绝把准备包变成已完成报告或填入伪造 finding', async () => {
  await withProject(async (projectDir) => {
    const packet = await createFindQuestionPacket({ projectDir });
    await assert.rejects(validateFindQuestionPacket({ ...packet, status: 'passed' }, rootDir));
    await assert.rejects(validateFindQuestionPacket({ ...packet, findings: [{ id: 'FAKE-F01' }] }, rootDir));
    await assert.rejects(validateFindQuestionPacket({ ...packet, readOnly: false }, rootDir));
    await assert.rejects(validateFindQuestionPacket({ ...packet, focus: ['unknown'] }, rootDir));
    await assert.rejects(validateFindQuestionPacket({ ...packet, evidence: { ...packet.evidence, labels: ['通过', '通过', '通过', '通过'] } }, rootDir));
  });
});
