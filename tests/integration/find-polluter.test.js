import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const rootDir = path.resolve(import.meta.dirname, '../..');
const scriptPath = path.join(rootDir, 'skills/core/systematic-debugging/find-polluter.sh');
// Bash on Windows receives the script as a command-line word, so the Windows path
// separator would be read as an escape character; posix form is understood by Git Bash.
const scriptPathForBash = scriptPath.replaceAll('\\', '/');

// The script is bash-only, so the suite resolves an interpreter instead of assuming
// one. No machine-specific absolute path is baked in: the environment override, the
// platform-specific install roots and PATH are tried in that order, and every
// candidate has to answer a probe before it is trusted.
function resolveBash() {
  const candidates = [];
  if (process.env.VIBE_HARNESS_BASH) candidates.push(process.env.VIBE_HARNESS_BASH);
  if (process.platform === 'win32') {
    // Git for Windows ships bash next to the git-core it reports, and git itself is on
    // PATH, so the install root can be derived instead of hard-coded per machine.
    const gitExecPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true });
    if (gitExecPath.status === 0 && gitExecPath.stdout.trim()) {
      const gitRoot = path.resolve(gitExecPath.stdout.trim(), '..', '..', '..');
      candidates.push(path.join(gitRoot, 'bin', 'bash.exe'));
    }
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      if (base) candidates.push(path.join(base, 'Git', 'bin', 'bash.exe'));
    }
    const located = spawnSync('where.exe', ['bash.exe'], { encoding: 'utf8', windowsHide: true });
    if (located.status === 0) {
      for (const line of located.stdout.split(/\r?\n/u).filter(Boolean)) {
        // System32 and WindowsApps hold the WSL launcher, not a POSIX bash for this filesystem.
        if (!/\\System32\\|\\WindowsApps\\/iu.test(line)) candidates.push(line.trim());
      }
    }
    candidates.push('bash.exe', 'bash');
  } else {
    candidates.push('/bin/bash', '/usr/bin/bash');
  }
  for (const candidate of candidates) {
    // The interpreter has to see this checkout as well as support globstar; a WSL bash
    // answers the version probe but cannot read the Windows path handed to it.
    const probe = spawnSync(candidate, ['-c', `shopt -s globstar && [ -f ${JSON.stringify(scriptPathForBash)} ] && echo probe-ok`], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (probe.status === 0 && probe.stdout.includes('probe-ok')) return candidate;
  }
  return null;
}

const bash = resolveBash();
const skipBash = bash ? false : 'bash with globstar is unavailable on this host';

async function createWorkspace() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'vh-find-polluter-'));
  await mkdir(path.join(workspace, 'tests/nested'), { recursive: true });
  await mkdir(path.join(workspace, 'dir with space'), { recursive: true });
  await mkdir(path.join(workspace, 'tools'), { recursive: true });
  await mkdir(path.join(workspace, 'bin'), { recursive: true });
  await writeFile(path.join(workspace, 'tests/a.test.js'), 'test\n');
  await writeFile(path.join(workspace, 'tests/nested/c.test.js'), 'test\n');
  await writeFile(path.join(workspace, 'dir with space/t.test.js'), 'test\n');
  await writeFile(
    path.join(workspace, 'tools/pollute.sh'),
    '#!/usr/bin/env bash\ntouch pollution.txt\nprintf "%s\\n" "$@" >> calls.txt\n',
  );
  await writeFile(path.join(workspace, 'tools/fail.sh'), '#!/usr/bin/env bash\nexit 3\n');
  await writeFile(path.join(workspace, 'bin/npm'), '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> npm-calls.txt\n');
  for (const name of ['tools/pollute.sh', 'tools/fail.sh', 'bin/npm']) {
    await chmod(path.join(workspace, name), 0o755);
  }
  return workspace;
}

function runPolluter(workspace, args, { withNpmStub = false } = {}) {
  const env = { ...process.env };
  if (withNpmStub) {
    env.PATH = [path.join(workspace, 'bin'), env.PATH ?? ''].filter(Boolean).join(path.delimiter);
  }
  // Arguments travel through a generated launcher because the MSYS runtime expands
  // wildcards in the argv of bash.exe when its parent is a native Windows process; the
  // documented invocation quotes the pattern, and quoting it inside a script file keeps
  // the pattern literal the way an interactive bash prompt would.
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const launcher = `#!/usr/bin/env bash\nexec bash ${[scriptPathForBash, ...args].map(quote).join(' ')}\n`;
  const launcherPath = path.join(workspace, 'vh-find-polluter-launcher.sh');
  writeFileSync(launcherPath, launcher);
  const result = spawnSync(bash, [launcherPath.replaceAll('\\', '/')], { cwd: workspace, env, encoding: 'utf8', windowsHide: true });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

async function withWorkspace(body) {
  const workspace = await createWorkspace();
  try {
    return await body(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
  }
}

test('find-polluter 定位到污染者时退出码 1，且自定义命令不追加多余花括号', { skip: skipBash }, async () => {
  await withWorkspace(async (workspace) => {
    const result = runPolluter(workspace, ['pollution.txt', 'tests/**/*.test.js', 'bash tools/pollute.sh {file}']);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /FOUND POLLUTER/u);
    const created = await readdir(workspace);
    assert.equal(created.includes('pollution.txt'), true, 'candidate command must create the exact requested path');
    assert.equal(created.includes('pollution.txt}'), false, 'the default-value brace bug must not leak into custom commands');
    const calls = await readFile(path.join(workspace, 'calls.txt'), 'utf8');
    // Glob order follows the directory read order, so membership is asserted, not position.
    assert.equal(calls.split(/\r?\n/u).includes('./tests/a.test.js'), true, '{file} is passed as one whole argument');
  });
});

test('find-polluter 默认命令模板完整，且 ** 支持零级与多级目录', { skip: skipBash }, async () => {
  await withWorkspace(async (workspace) => {
    const result = runPolluter(workspace, ['pollution.txt', 'tests/**/*.test.js'], { withNpmStub: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Test command: npm test \{file\}/u);
    const calls = await readFile(path.join(workspace, 'npm-calls.txt'), 'utf8');
    const lines = calls.split(/\r?\n/u).filter(Boolean).sort();
    assert.deepEqual(lines, ['test ./tests/a.test.js', 'test ./tests/nested/c.test.js']);
  });
});

test('find-polluter 支持带空格路径与字面量引号分组', { skip: skipBash }, async () => {
  await withWorkspace(async (workspace) => {
    const result = runPolluter(workspace, ['pollution.txt', 'dir with space/**/*.test.js', 'bash tools/pollute.sh "two words" {file}']);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const calls = await readFile(path.join(workspace, 'calls.txt'), 'utf8');
    assert.deepEqual(calls.split(/\r?\n/u).filter(Boolean).sort(), ['./dir with space/t.test.js', 'two words']);
  });
});

test('find-polluter 零候选、已存在污染与失败命令都返回退出码 2，不报告 clean', { skip: skipBash }, async () => {
  await withWorkspace(async (workspace) => {
    const empty = runPolluter(workspace, ['pollution.txt', 'nope/**/*.test.js', 'true']);
    assert.equal(empty.status, 2, empty.stdout + empty.stderr);
    assert.match(empty.stdout, /No test files matched/u);
    assert.doesNotMatch(empty.stdout, /No polluter found/u);

    await writeFile(path.join(workspace, 'pollution.txt'), 'pre-existing\n');
    const preexisting = runPolluter(workspace, ['pollution.txt', 'tests/**/*.test.js', 'true']);
    assert.equal(preexisting.status, 2, preexisting.stdout + preexisting.stderr);
    assert.match(preexisting.stdout, /already exists/u);
    await rm(path.join(workspace, 'pollution.txt'));

    const failing = runPolluter(workspace, ['pollution.txt', 'tests/**/*.test.js', 'bash tools/fail.sh {file}']);
    assert.equal(failing.status, 2, failing.stdout + failing.stderr);
    assert.match(failing.stdout, /exited 3/u);
    assert.doesNotMatch(failing.stdout, /No polluter found/u);
  });
});

test('find-polluter 拒绝管道、重定向、串联、展开、{file} 嵌入与未闭合引号', { skip: skipBash }, async () => {
  await withWorkspace(async (workspace) => {
    const rejected = [
      'bash tools/pollute.sh {file} | cat',
      'bash tools/pollute.sh {file} > out.txt',
      'bash tools/pollute.sh {file} && true',
      'bash tools/pollute.sh $(true)',
      'bash tools/pollute.sh --file={file}',
      "bash tools/pollute.sh 'x",
    ];
    for (const template of rejected) {
      const result = runPolluter(workspace, ['pollution.txt', 'tests/**/*.test.js', template]);
      assert.equal(result.status, 2, `${template} must be rejected: ${result.stdout}`);
      assert.doesNotMatch(result.stdout, /No polluter found/u);
    }
  });
});

test('find-polluter 保留三参数入口并支持不含 {file} 的简单命令', { skip: skipBash }, async () => {
  await withWorkspace(async (workspace) => {
    const tooFew = runPolluter(workspace, ['pollution.txt']);
    assert.equal(tooFew.status, 2);
    assert.match(tooFew.stdout, /Usage:/u);
    const tooMany = runPolluter(workspace, ['pollution.txt', 'tests/**/*.test.js', 'true', 'extra']);
    assert.equal(tooMany.status, 2);
    const simple = runPolluter(workspace, ['pollution.txt', 'tests/**/*.test.js', 'true']);
    assert.equal(simple.status, 0, simple.stdout + simple.stderr);
    assert.match(simple.stdout, /No polluter found/u);
  });
});
