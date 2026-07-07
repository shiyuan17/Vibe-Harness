import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve('.');
const cliPath = path.join(rootDir, 'scripts/loopengine.js');

async function runCli(args, options = {}) {
  const result = await execFileAsync(process.execPath, [cliPath, ...args], {
    ...options,
    maxBuffer: 1024 * 1024 * 8,
  });
  return result.stdout ? JSON.parse(result.stdout) : null;
}

test('codegraph install-cli dry-run prints the global npm install command without executing it', async () => {
  const report = await runCli(['codegraph', 'install-cli', '--dry-run']);

  assert.equal(report.dryRun, true);
  assert.deepEqual(report.command, ['npm', 'install', '-g', '@colbymchenry/codegraph@latest']);
  assert.equal(report.installed, false);
});

test('codegraph install-cli executes install and verifies codegraph version', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-codegraph-install-'));
  const logPath = path.join(target, 'commands.jsonl');
  try {
    const report = await runCli(['codegraph', 'install-cli', '--version', '1.2.0'], {
      env: {
        ...process.env,
        LOOPENGINE_MOCK_COMMAND_LOG: logPath,
        LOOPENGINE_MOCK_CODEGRAPH_VERSION: '1.2.0',
      },
    });
    const lines = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

    assert.equal(report.installed, true);
    assert.equal(report.version, '1.2.0');
    assert.deepEqual(lines.map((line) => [line.command, ...line.args]), [
      ['npm', 'install', '-g', '@colbymchenry/codegraph@1.2.0'],
      ['codegraph', '--version'],
    ]);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('codegraph install-cli returns structured errors when install fails', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-codegraph-fail-'));
  const logPath = path.join(target, 'commands.jsonl');
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'codegraph', 'install-cli'], {
        env: {
          ...process.env,
          LOOPENGINE_MOCK_COMMAND_LOG: logPath,
          LOOPENGINE_MOCK_FAIL_COMMAND: 'npm',
        },
      }),
      (error) => {
        const payload = JSON.parse(String(error.stderr));
        assert.equal(error.code, 1);
        assert.equal(payload.ok, false);
        assert.match(payload.error.message, /CodeGraph CLI install failed/);
        return true;
      },
    );
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('codegraph status reports cli and project index state', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-codegraph-status-'));
  const logPath = path.join(target, 'commands.jsonl');
  try {
    let report = await runCli(['codegraph', 'status', '--target', target], {
      env: {
        ...process.env,
        LOOPENGINE_MOCK_COMMAND_LOG: logPath,
        LOOPENGINE_MOCK_CODEGRAPH_VERSION: '1.2.0',
      },
    });
    assert.equal(report.cli.installed, true);
    assert.equal(report.cli.version, '1.2.0');
    assert.equal(report.project.initialized, false);

    await mkdir(path.join(target, '.codegraph'));
    report = await runCli(['codegraph', 'status', '--target', target], {
      env: {
        ...process.env,
        LOOPENGINE_MOCK_COMMAND_LOG: logPath,
        LOOPENGINE_MOCK_CODEGRAPH_VERSION: '1.2.0',
      },
    });
    assert.equal(report.project.initialized, true);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('codegraph status reports missing cli without failing', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-codegraph-missing-'));
  const logPath = path.join(target, 'commands.jsonl');
  try {
    const report = await runCli(['codegraph', 'status', '--target', target], {
      env: {
        ...process.env,
        LOOPENGINE_MOCK_COMMAND_LOG: logPath,
        LOOPENGINE_MOCK_MISSING_COMMAND: 'codegraph',
      },
    });

    assert.equal(report.cli.installed, false);
    assert.equal(report.cli.version, null);
    assert.match(report.cli.error, /missing/);
    assert.equal(report.project.initialized, false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
