import './helpers/offline-tools.js';

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve('.');
const cliPath = path.join(rootDir, 'scripts/cognis.js');

async function run(args, cwd = rootDir) {
  try {
    const result = await execFileAsync(process.execPath, args, { cwd, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, stderr: result.stderr, stdout: result.stdout };
  } catch (error) {
    return { code: error.code, stderr: error.stderr, stdout: error.stdout };
  }
}

async function installProject(profile = 'core') {
  const target = await mkdtemp(path.join(tmpdir(), `cognis-runtime-${profile}-`));
  assert.equal((await run([cliPath, 'init', '--project', target])).code, 0);
  if (profile === 'full') {
    const configPath = path.join(target, 'cognis.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.profile = 'full';
    config.governance.mode = 'full';
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }
  const installArgs = [cliPath, 'install', '--project', target, '--target', 'codex', '--profile', profile, '--write'];
  if (profile === 'full') {
    installArgs.push('--confirm-red-zone', '--allow-degraded');
  }
  assert.equal((await run(installArgs)).code, 0);
  return target;
}

test('installed core governance validates the simplified surface', async () => {
  const target = await installProject();
  try {
    const result = await run(['.agents/cognis/governance/validate.mjs'], target);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /治理校验通过/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('installed governance requires the canonical kernel', async () => {
  const target = await installProject();
  try {
    await unlink(path.join(target, 'docs/rules/governance-core.md'));
    const result = await run(['.agents/cognis/governance/validate.mjs'], target);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /docs\/rules\/governance-core\.md/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('installed governance rejects invalid Chinese task Markdown', async () => {
  const target = await installProject();
  try {
    await mkdir(path.join(target, 'docs/tasks'), { recursive: true });
    await writeFile(path.join(target, 'docs/tasks/T-INVALID.md'), '# T-INVALID 缺少合同字段\n', 'utf8');
    const result = await run(['.agents/cognis/governance/validate.mjs'], target);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /缺少字段“工作流档位”/u);
    assert.match(result.stderr, /docs\/tasks\/T-INVALID\.md/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('installed full governance still enforces Pencil paired previews', async () => {
  const target = await installProject('full');
  try {
    await mkdir(path.join(target, 'design'), { recursive: true });
    await writeFile(path.join(target, 'design/example.pen'), 'design', 'utf8');
    const result = await run(['.agents/cognis/governance/validate.mjs'], target);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Missing design preview pair/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
