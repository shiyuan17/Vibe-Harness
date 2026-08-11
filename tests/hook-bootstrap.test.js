import assert from 'node:assert/strict';
import { exec, execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { renderTemplate } from '../scripts/lib/template-renderer.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '..');

async function bootstrapCommand() {
  const template = await readFile(path.join(rootDir, 'adapters/codex/hooks.template.json'), 'utf8');
  const rendered = JSON.parse(renderTemplate(template));
  return rendered.hooks.PreToolUse[0].hooks[0].command;
}

async function seedHook(root) {
  const hook = path.join(root, '.agents/runtime/hooks/codex-hook.mjs');
  await mkdir(path.dirname(hook), { recursive: true });
  await writeFile(hook, "import { fileURLToPath } from 'node:url'; process.stdout.write(fileURLToPath(import.meta.url));\n", 'utf8');
  return hook;
}

test('Hook bootstrap resolves the active Git root from root, nested directories, and worktrees', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'vibe-harness-hook-bootstrap-'));
  const main = path.join(base, 'main');
  const linked = path.join(base, 'linked');
  try {
    await mkdir(main);
    await execFileAsync('git', ['init'], { cwd: main });
    await execFileAsync('git', ['config', 'user.email', 'hook-test@example.invalid'], { cwd: main });
    await execFileAsync('git', ['config', 'user.name', 'Hook Test'], { cwd: main });
    const mainHook = await seedHook(main);
    const nested = path.join(main, 'one/two');
    await mkdir(nested, { recursive: true });
    await execFileAsync('git', ['add', '.'], { cwd: main });
    await execFileAsync('git', ['commit', '-m', 'test: seed hook fixture'], { cwd: main });
    await execFileAsync('git', ['worktree', 'add', linked, '-b', 'test/hook-bootstrap'], { cwd: main });
    const linkedNested = path.join(linked, 'three/four');
    await mkdir(linkedNested, { recursive: true });

    const command = await bootstrapCommand();
    const rootResult = await execAsync(command, { cwd: main, windowsHide: true });
    const nestedResult = await execAsync(command, { cwd: nested, windowsHide: true });
    const linkedResult = await execAsync(command, { cwd: linkedNested, windowsHide: true });
    assert.equal(path.normalize(rootResult.stdout), path.normalize(mainHook));
    assert.equal(nestedResult.stdout, rootResult.stdout);
    assert.match(path.normalize(linkedResult.stdout), /linked.*codex-hook\.mjs$/u);
  } finally {
    await rm(base, { force: true, recursive: true });
  }
});

test('Hook bootstrap fails explicitly when no Git root exists', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-hook-no-git-'));
  try {
    const command = await bootstrapCommand();
    await assert.rejects(
      () => execAsync(command, { cwd: target, windowsHide: true }),
      /Git worktree root/u,
    );
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
