import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve('.');
const cliPath = path.join(rootDir, 'scripts/loopengine.js');

async function runCli(args) {
  const result = await execFileAsync(process.execPath, [cliPath, ...args], { maxBuffer: 1024 * 1024 * 8 });
  return JSON.parse(result.stdout);
}

async function createProject(validationCommands) {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-verify-'));
  await runCli(['init', '--project', target]);
  const configPath = path.join(target, 'loopengine.config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.validationCommands = validationCommands;
  config.governance.mode = 'off';
  config.profile = 'core';
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await runCli(['install', '--project', target, '--target', 'codex', '--profile', 'core', '--write']);
  return target;
}

test('verify --project executes configured available commands', async () => {
  const target = await createProject({
    lint: 'node verify-lint.mjs',
    typecheck: null,
    governance: null,
  });
  try {
    await writeFile(path.join(target, 'verify-lint.mjs'), "console.log('lint-ok');\n", 'utf8');
    const report = await runCli(['verify', '--project', target]);

    assert.equal(report.ok, true);
    assert.equal(report.results.lint.exitCode, 0);
    assert.match(report.results.lint.stdout, /lint-ok/u);
    assert.equal(report.results.typecheck.status, 'not_configured');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('verify --project blocks missing and manual commands by default', async () => {
  const target = await createProject({
    lint: 'pnpm missing-script',
    typecheck: 'node -e "console.log(42)"',
    governance: null,
  });
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'verify', '--project', target]),
      (error) => {
        const payload = JSON.parse(error.stderr);
        assert.equal(payload.error.code, 'PROJECT_VERIFICATION_FAILED');
        assert.match(payload.error.message, /lint is missing/u);
        return true;
      },
    );

    const manualOnlyConfigPath = path.join(target, 'loopengine.config.json');
    const manualOnlyConfig = JSON.parse(await readFile(manualOnlyConfigPath, 'utf8'));
    manualOnlyConfig.validationCommands.lint = null;
    await writeFile(manualOnlyConfigPath, `${JSON.stringify(manualOnlyConfig, null, 2)}\n`, 'utf8');
    await runCli(['install', '--project', target, '--target', 'codex', '--profile', 'core', '--write', '--force']);

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'verify', '--project', target]),
      /typecheck is manual; pass --allow-manual/u,
    );
    const report = await runCli(['verify', '--project', target, '--allow-manual']);
    assert.equal(report.results.typecheck.exitCode, 0);
    assert.match(report.results.typecheck.stdout, /42/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('verify --project propagates command failures', async () => {
  const target = await createProject({
    lint: 'node verify-fail.mjs',
    typecheck: null,
    governance: null,
  });
  try {
    await writeFile(path.join(target, 'verify-fail.mjs'), "console.error('lint-failed'); process.exitCode = 7;\n", 'utf8');
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'verify', '--project', target]),
      (error) => {
        const payload = JSON.parse(error.stderr);
        assert.equal(payload.error.code, 'PROJECT_VERIFICATION_FAILED');
        assert.match(payload.error.message, /lint failed with exit 7/u);
        return true;
      },
    );
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
