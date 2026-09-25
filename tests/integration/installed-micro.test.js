import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');

async function installedProject() {
  const project = await mkdtemp(path.join(tmpdir(), 'vibe-micro-installed-'));
  await exec(process.execPath, [path.join(root, 'scripts/vibe-harness.js'), 'init', '--project', project], { cwd: root });
  await exec(process.execPath, [path.join(root, 'scripts/vibe-harness.js'), 'install', '--project', project, '--target', 'codex', '--profile', 'core', '--write'], { cwd: root });
  await exec('git', ['init', '--quiet'], { cwd: project });
  await exec('git', ['config', 'user.email', 'fixture@example.com'], { cwd: project });
  await exec('git', ['config', 'user.name', 'Fixture'], { cwd: project });
  await mkdir(path.join(project, 'scripts/probes'), { recursive: true });
  return project;
}

async function configure(project, entrySource, extra = {}) {
  const entry = 'scripts/probes/local.mjs';
  await writeFile(path.join(project, entry), entrySource);
  const file = path.join(project, 'vibe-harness.config.json');
  const config = JSON.parse(await readFile(file, 'utf8'));
  config.validationCommands.micro = [{
    id: 'local', kind: 'pure', entry, args: { number: 2 }, network: 'deny',
    workspaceWrite: 'deny', maxDurationMs: 3000, maxOutputBytes: 2048,
    ...extra,
  }];
  await writeFile(file, JSON.stringify(config));
}

async function verify(project, ...args) {
  const runner = path.join(project, '.agents/runtime/commands/run.mjs');
  try {
    const { stdout } = await exec(process.execPath, [runner, 'verify', '--project', project, '--micro', 'local', '--json', ...args], { cwd: project });
    return JSON.parse(stdout);
  } catch (error) {
    if (!error.stdout) throw error;
    return JSON.parse(error.stdout);
  }
}

test('installed runtime executes only explicitly declared Micro and keeps evidence local', async () => {
  const project = await installedProject();
  try {
    await configure(project, 'export default (args) => ({ doubled: args.number * 2 });\n');
    const planned = await verify(project, '--plan');
    assert.equal(planned.status, 'planned');
    const result = await verify(project);
    assert.equal(result.status, 'passed');
    assert.equal(result.checks.local.snapshotComparison, 'match');
    assert.equal(result.checks.local.outputSummary.bytes > 0, true);
    assert.deepEqual(result.selectedChecks, []);
    assert.deepEqual(result.selectedMicroChecks, ['local']);
    assert.equal(result.minimumTier, 'unit');
    assert.equal(result.nextTier, 'standard');
    const missing = await verify(project, '--tier', 'standard');
    assert.equal(missing.code, 'MICRO_EXCLUSIVE');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('installed Micro blocks undeclared, legacy, network, mutation and output overflow', async () => {
  const project = await installedProject();
  try {
    await configure(project, 'export default () => 1;\n');
    const configPath = path.join(project, 'vibe-harness.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    delete config.validationCommands.micro;
    await writeFile(configPath, JSON.stringify(config));
    assert.equal((await verify(project)).checks.local.code, 'MICRO_NOT_DECLARED');
    await configure(project, 'export default () => 1;\n', { command: 'node -e "1"' });
    assert.equal((await verify(project)).checks.local.code, 'MICRO_INVALID_DECLARATION');
    await configure(project, 'import net from "node:net"; export default () => net.connect(80);\n');
    assert.equal((await verify(project)).checks.local.code, 'MICRO_UNSAFE_ENTRY');
    await configure(project, 'import { writeFileSync } from "node:fs"; export default () => writeFileSync("bad.txt", "bad");\n');
    assert.notEqual((await verify(project)).status, 'passed');
    await configure(project, 'export default () => process.stdout.write("x".repeat(4096));\n');
    assert.equal((await verify(project)).checks.local.code, 'MICRO_OUTPUT_LIMIT');
    await configure(project, 'export default () => new Promise((resolve) => setTimeout(resolve, 10000));\n', { maxDurationMs: 200 });
    assert.equal((await verify(project)).checks.local.code, 'MICRO_TIMEOUT');
    await configure(project, 'export default () => 1;\n', { allowedEnv: ['NODE_OPTIONS'] });
    assert.equal((await verify(project)).checks.local.code, 'MICRO_INVALID_DECLARATION');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
