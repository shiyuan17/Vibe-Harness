import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve('.');
const cliPath = path.join(rootDir, 'scripts/cognis.js');

async function preview(profile) {
  const target = await mkdtemp(path.join(tmpdir(), `cognis-profile-${profile}-`));
  await execFileAsync(process.execPath, [cliPath, 'init', '--project', target]);
  const result = await execFileAsync(process.execPath, [cliPath, 'install', '--project', target, '--target', 'codex', '--profile', profile, '--dry-run'], { maxBuffer: 8 * 1024 * 1024 });
  return { report: JSON.parse(result.stdout), target };
}

test('minimal uses the fallback kernel without skills or runtime', async () => {
  const { report, target } = await preview('minimal');
  try {
    const targets = new Set(report.actions.map((action) => action.relativeTarget));
    assert.equal(targets.has('docs/rules/governance-core.md'), true);
    assert.equal(targets.has('docs/templates/task.md'), true);
    assert.equal([...targets].some((item) => item.startsWith('.agents/skills/')), false);
    assert.equal([...targets].some((item) => item.startsWith('docs/workflows/')), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('core and full install routed skills and full adds memory and hooks without tool MCPs', async () => {
  const core = await preview('core');
  const full = await preview('full');
  try {
    const coreTargets = new Set(core.report.actions.map((action) => action.relativeTarget));
    const fullTargets = new Set(full.report.actions.map((action) => action.relativeTarget));
    for (const targets of [coreTargets, fullTargets]) {
      assert.equal(targets.has('.agents/skills/using-cognis/SKILL.md'), true);
      assert.equal(targets.has('docs/schemas/full-task-control.schema.json'), true);
      assert.equal(targets.has('.agents/cognis/governance/lib/task-validation.mjs'), true);
      assert.equal(targets.has('.agents/cognis/governance/lib/red-team-validation.mjs'), true);
    }
    assert.equal(coreTargets.has('.agents/skills/adversarial-review-packet/SKILL.md'), true);
    assert.equal(coreTargets.has('docs/rules/codebase-memory-mcp.md'), false);
    assert.equal(coreTargets.has('.agents/skills/agentmemory/SKILL.md'), false);
    assert.equal(coreTargets.has('.codex/hooks.json'), false);
    assert.equal(fullTargets.has('.agents/skills/adversarial-review-packet/SKILL.md'), true);
    assert.equal(fullTargets.has('docs/rules/codebase-memory-mcp.md'), false);
    assert.equal(fullTargets.has('.agents/skills/agentmemory/SKILL.md'), true);
    assert.equal(fullTargets.has('.codex/hooks.json'), true);
  } finally {
    await rm(core.target, { force: true, recursive: true });
    await rm(full.target, { force: true, recursive: true });
  }
});
