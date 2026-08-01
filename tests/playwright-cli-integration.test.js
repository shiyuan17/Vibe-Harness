import './helpers/offline-tools.js';

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  PLAYWRIGHT_CLI_VERSION,
  inspectPlaywrightTool,
  preparePlaywrightTool,
  runPlaywrightCli,
} from '../runtime/tools/playwright-cli/run.mjs';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '..');
const cliPath = path.join(rootDir, 'scripts/vibe-harness.js');

async function runCli(args) {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], { cwd: rootDir });
  return JSON.parse(stdout);
}

test('Playwright tool preparation is lazy, reproducible, and project-local', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-playwright-tool-'));
  const toolDir = path.join(targetDir, '.agents/runtime/tools/playwright-cli');
  const calls = [];
  try {
    await mkdir(toolDir, { recursive: true });
    await writeFile(path.join(toolDir, 'package-lock.json'), '{"lockfileVersion":3}\n', 'utf8');
    await writeFile(path.join(toolDir, 'package.json'), JSON.stringify({ devDependencies: { '@playwright/cli': PLAYWRIGHT_CLI_VERSION } }), 'utf8');

    const runCommand = async (command, args, options) => {
      calls.push({ args, command, cwd: options.cwd, env: options.env, browserPath: options.env.PLAYWRIGHT_BROWSERS_PATH });
      if (command.includes('npm') || args[0]?.includes('npm-cli')) {
        await mkdir(path.join(toolDir, 'node_modules/@playwright/cli'), { recursive: true });
        await writeFile(path.join(toolDir, 'node_modules/@playwright/cli/playwright-cli.js'), '', 'utf8');
      } else {
        await mkdir(path.join(toolDir, 'node_modules/playwright-core/.local-browsers/chromium-test'), { recursive: true });
      }
    };

    const prepared = await preparePlaywrightTool({
      env: {
        HTTPS_PROXY: 'https://proxy.example.test',
        VIBE_HARNESS_SECRET_SENTINEL: 'must-not-leak',
        PATH: 'playwright-test-path',
      },
      runCommand,
      targetDir,
      toolDir,
    });
    const inspected = await inspectPlaywrightTool({ targetDir });

    assert.equal(prepared.status, 'ready');
    assert.equal(inspected.status, 'ready');
    assert.equal(calls.length, 2);
    if (process.platform === 'win32') {
      assert.equal(calls[0].command, process.execPath);
      assert.match(calls[0].args[0], /npm-cli\.js$/u);
      assert.deepEqual(calls[0].args.slice(1), ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
    } else {
      assert.equal(calls[0].command, 'npm');
      assert.deepEqual(calls[0].args, ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
    }
    assert.deepEqual(calls[1].args.slice(-2), ['install-browser', 'chromium']);
    assert.equal(calls[1].browserPath, '0');
    assert.equal(calls[0].env.PATH, 'playwright-test-path');
    assert.equal(calls[0].env.HTTPS_PROXY, 'https://proxy.example.test');
    assert.equal(calls[0].env.VIBE_HARNESS_SECRET_SENTINEL, undefined);
    assert.equal(calls.every((call) => call.cwd === toolDir), true);

    await preparePlaywrightTool({ runCommand, targetDir, toolDir });
    assert.equal(calls.length, 2, 'matching lock hash must reuse the prepared tool');

    await writeFile(path.join(toolDir, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}\n', 'utf8');
    await preparePlaywrightTool({ runCommand, targetDir, toolDir });
    assert.equal(calls.length, 4, 'changed lock hash must prepare the tool again');

    const config = JSON.parse(await readFile(path.join(targetDir, '.vibe-harness/tool-state/playwright-cli.config.json'), 'utf8'));
    assert.equal(config.browser.isolated, true);
    assert.equal(config.allowUnrestrictedFileAccess, false);
    assert.equal(config.outputDir, path.join(targetDir, '.vibe-harness/artifacts/playwright'));
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('failed Playwright preparation records unavailable without leaking command output and can retry', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-playwright-failure-'));
  const toolDir = path.join(targetDir, '.agents/runtime/tools/playwright-cli');
  try {
    await mkdir(toolDir, { recursive: true });
    await writeFile(path.join(toolDir, 'package-lock.json'), '{}\n', 'utf8');
    await writeFile(path.join(toolDir, 'package.json'), '{}\n', 'utf8');
    await assert.rejects(
      preparePlaywrightTool({
        runCommand: async () => {
          throw Object.assign(new Error('token=super-secret'), {
            code: 'TOOL_COMMAND_FAILED',
            exitCode: 19,
            stderr: 'browser download failed: Bearer super-secret',
            stdout: 'downloading chromium',
          });
        },
        targetDir,
        toolDir,
      }),
      (error) => {
        assert.match(error.message, /prepare Playwright CLI/i);
        assert.equal(error.phase, 'dependency-install');
        assert.equal(error.exitCode, 19);
        assert.equal(error.stderr, 'browser download failed: Bearer super-secret');
        assert.equal(error.stdout, 'downloading chromium');
        return true;
      },
    );

    const stateText = await readFile(path.join(targetDir, '.vibe-harness/tool-state/playwright-cli.json'), 'utf8');
    const state = JSON.parse(stateText);
    assert.equal(stateText.includes('super-secret'), false);
    assert.equal(state.phase, 'dependency-install');
    assert.equal((await inspectPlaywrightTool({ targetDir })).status, 'unavailable');

    const retry = await preparePlaywrightTool({
      runCommand: async (command, args) => {
        if (command.includes('npm') || args[0]?.includes('npm-cli')) {
          await mkdir(path.join(toolDir, 'node_modules/@playwright/cli'), { recursive: true });
          await writeFile(path.join(toolDir, 'node_modules/@playwright/cli/playwright-cli.js'), '', 'utf8');
        } else {
          await mkdir(path.join(toolDir, 'node_modules/playwright-core/.local-browsers/chromium-retry'), { recursive: true });
        }
      },
      targetDir,
      toolDir,
    });
    assert.equal(retry.status, 'ready');
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('Playwright command forwards output while provisioning remains injectable', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-playwright-command-'));
  const toolDir = path.join(targetDir, '.agents/runtime/tools/playwright-cli');
  const invocations = [];
  try {
    await mkdir(toolDir, { recursive: true });
    await writeFile(path.join(toolDir, 'package-lock.json'), '{}\n', 'utf8');
    await writeFile(path.join(toolDir, 'package.json'), '{}\n', 'utf8');
    const runCommand = async (command, args) => {
      if (command.includes('npm') || args[0]?.includes('npm-cli')) {
        await mkdir(path.join(toolDir, 'node_modules/@playwright/cli'), { recursive: true });
        await writeFile(path.join(toolDir, 'node_modules/@playwright/cli/playwright-cli.js'), '', 'utf8');
      } else {
        await mkdir(path.join(toolDir, 'node_modules/playwright-core/.local-browsers/chromium-test'), { recursive: true });
      }
    };
    const runCliCommand = async (command, args, options) => invocations.push({ args, command, options });

    await runPlaywrightCli(['-s=smoke', 'snapshot', '--filename=smoke.yml'], {
      env: { VIBE_HARNESS_SECRET_SENTINEL: 'must-not-leak', PATH: 'playwright-test-path' },
      runCliCommand,
      runCommand,
      targetDir,
      toolDir,
    });

    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].command, process.execPath);
    assert.deepEqual(invocations[0].args.slice(1), [
      '-s=smoke',
      'snapshot',
      `--filename=${path.join(targetDir, '.vibe-harness/artifacts/playwright/smoke.yml')}`,
    ]);
    assert.equal(invocations[0].options.cwd, targetDir);
    assert.equal(
      invocations[0].options.env.PLAYWRIGHT_MCP_CONFIG,
      path.join(targetDir, '.vibe-harness/tool-state/playwright-cli.config.json'),
    );
    assert.equal(invocations[0].options.env.PATH, 'playwright-test-path');
    assert.equal(invocations[0].options.env.VIBE_HARNESS_SECRET_SENTINEL, undefined);
    assert.equal(invocations[0].options.stdio, 'inherit');

    await assert.rejects(
      runPlaywrightCli(['screenshot', '--filename=../escape.png'], { runCliCommand, runCommand, targetDir, toolDir }),
      /artifact filename must stay inside/i,
    );
    await assert.rejects(
      runPlaywrightCli(['open', '--config=untrusted.json'], { runCliCommand, runCommand, targetDir, toolDir }),
      /managed Playwright config/i,
    );
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('the Playwright plugin installs a lazy project-local tool without changing the project package', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-playwright-install-'));
  try {
    const packageText = '{"name":"business-app","private":true}\n';
    await writeFile(path.join(targetDir, 'package.json'), packageText, 'utf8');
    await runCli(['init', '--project', targetDir]);

    const dryRun = await runCli(['install', '--project', targetDir, '--target', 'codex', '--profile', 'core', '--plugin', '-playwright-cli', '--dry-run']);
    assert.equal(dryRun.tools.playwrightCli.status, 'pending');
    assert.ok(dryRun.actions.some((action) => action.relativeTarget === '.agents/runtime/tools/playwright-cli/run.mjs'));
    assert.ok(dryRun.actions.some((action) => action.relativeTarget === '.agents/skills/browser-verification/references/cli.md'));

    const minimal = await runCli(['install', '--project', targetDir, '--target', 'codex', '--profile', 'minimal', '--dry-run']);
    assert.equal(Object.hasOwn(minimal.tools, 'playwrightCli'), false);

    await runCli(['install', '--project', targetDir, '--target', 'codex', '--profile', 'core', '--plugin', '-playwright-cli', '--write']);
    assert.equal(await readFile(path.join(targetDir, 'package.json'), 'utf8'), packageText);
    await assert.rejects(readFile(path.join(targetDir, '.agents/runtime/tools/playwright-cli/node_modules/.package-lock.json'), 'utf8'), /ENOENT/);

    const doctor = await runCli(['doctor', '--project', targetDir, '--profile', 'core']);
    assert.equal(doctor.tools.playwrightCli.status, 'pending');
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('project validation warns for a pending Playwright tool without failing governance', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-playwright-validate-'));
  try {
    await runCli(['init', '--project', targetDir]);
    await runCli(['install', '--project', targetDir, '--target', 'codex', '--profile', 'core', '--plugin', '-playwright-cli', '--write']);
    const report = await runCli(['validate', '--project', targetDir]);
    assert.equal(report.ok, true);
    assert.ok(report.warnings.some((warning) => warning.code === 'PLAYWRIGHT_CLI_PENDING'));
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('rollback removes generated Playwright dependencies but preserves browser evidence', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-playwright-rollback-'));
  try {
    await runCli(['init', '--project', targetDir, '--profile', 'core']);
    await runCli(['install', '--project', targetDir, '--target', 'codex', '--profile', 'core', '--plugin', '-playwright-cli', '--write']);
    const validation = await runCli(['validate', '--project', targetDir, '--profile', 'core']);
    assert.ok(validation.warnings.some((warning) => warning.code === 'PLAYWRIGHT_CLI_PENDING'));
    const generated = path.join(targetDir, '.agents/runtime/tools/playwright-cli/node_modules/fake');
    const evidence = path.join(targetDir, '.vibe-harness/artifacts/playwright/screenshot.png');
    await mkdir(generated, { recursive: true });
    await mkdir(path.dirname(evidence), { recursive: true });
    await writeFile(path.join(generated, 'index.js'), '', 'utf8');
    await writeFile(evidence, 'evidence', 'utf8');

    const result = await runCli(['rollback', '--project', targetDir, '--write']);

    assert.ok(result.applied.includes('.agents/runtime/tools/playwright-cli/node_modules'));
    await assert.rejects(readFile(path.join(generated, 'index.js'), 'utf8'), /ENOENT/);
    assert.equal(await readFile(evidence, 'utf8'), 'evidence');
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});
