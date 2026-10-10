import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const projectRoot = path.resolve('.');
// Windows needs no elevation for a junction; every other platform uses a
// directory symlink. A Worktree projects `.agents` exactly this way, so this is
// the same access path an installed entry sees there.
const linkType = process.platform === 'win32' ? 'junction' : 'dir';

// Each entry decides whether it was invoked as the main module before it does
// any work. Comparing the invoked path string alone made every one of them a
// silent no-op when reached through the Worktree's `.agents` junction: the Hook
// returned no decision at all and the RTK entry exited 0 without output.
const ENTRIES = [
  {
    args: ['--expected-event', 'PreToolUse'],
    entry: 'runtime/hooks/codex-hook.mjs',
    label: 'codex-hook',
    stdin: JSON.stringify({
      cwd: projectRoot,
      hook_event_name: 'PreToolUse',
      session_id: 'symlinked-entry',
      tool_input: { command: 'git reset --hard' },
      tool_name: 'Bash',
    }),
  },
  {
    args: ['unsupported-hook'],
    entry: 'runtime/hooks/git-hook.mjs',
    label: 'git-hook',
  },
  {
    args: ['git', 'log', '--oneline', '-1'],
    entry: 'runtime/tools/rtk/run.mjs',
    label: 'rtk',
  },
];

// The Hook reason carries its measured duration, so the two runs are compared
// with the timing suffix normalized away.
function normalization(text) {
  return text.replace(/:\d+\]/gu, ':<duration>]');
}

async function runEntry(entryPath, args, stdin = '') {
  const child = spawn(process.execPath, [entryPath, ...args], {
    cwd: projectRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdin.end(stdin);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return {
    code,
    stderr: Buffer.concat(stderr).toString('utf8'),
    stdout: Buffer.concat(stdout).toString('utf8'),
  };
}

test('符号链接目录下的入口仍然执行,而不是静默退出', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vibe-harness-symlinked-entry-'));
  // The link resolves to the same tree, so both runs must behave identically.
  await symlink(projectRoot, path.join(root, 'agents'), linkType);
  try {
    for (const { args, entry, label, stdin } of ENTRIES) {
      const direct = await runEntry(path.join(projectRoot, entry), args, stdin);
      const linked = await runEntry(path.join(root, 'agents', entry), args, stdin);
      assert.notEqual(
        `${linked.stdout}${linked.stderr}`,
        '',
        `${label} must not exit silently through a symlinked directory`,
      );
      assert.deepEqual(
        { ...linked, stderr: normalization(linked.stderr), stdout: normalization(linked.stdout) },
        { ...direct, stderr: normalization(direct.stderr), stdout: normalization(direct.stdout) },
        `${label} differs between the direct and the symlinked invocation`,
      );
    }
    const hook = await runEntry(
      path.join(root, 'agents', ENTRIES[0].entry),
      ENTRIES[0].args,
      ENTRIES[0].stdin,
    );
    assert.equal(
      JSON.parse(hook.stdout).hookSpecificOutput.permissionDecision,
      'deny',
      'the Hook must still answer with a decision through a symlinked directory',
    );
  } finally {
    // The link is removed before the directory so a recursive delete can never
    // descend into the repository.
    await rm(path.join(root, 'agents'), { force: true });
    await rm(root, { force: true, recursive: true });
  }
});
