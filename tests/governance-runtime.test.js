import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve('.');
const cliPath = path.join(rootDir, 'scripts/loopengine.js');

async function run(args, options = {}) {
  try {
    const result = await execFileAsync(process.execPath, args, {
      cwd: options.cwd ?? rootDir,
      maxBuffer: 1024 * 1024 * 8,
    });
    return { code: 0, stderr: result.stderr, stdout: result.stdout };
  } catch (error) {
    return { code: error.code, stderr: error.stderr, stdout: error.stdout };
  }
}

async function installProject(profile = 'core') {
  const target = await mkdtemp(path.join(tmpdir(), `loopengine-runtime-${profile}-`));
  const init = await run([cliPath, 'init', '--project', target]);
  assert.equal(init.code, 0, init.stderr);
  const configPath = path.join(target, 'loopengine.config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.profile = profile;
  config.governance.mode = profile === 'full' ? 'full' : 'basic';
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  const install = await run([cliPath, 'install', '--project', target, '--target', 'codex', '--profile', profile, '--write']);
  assert.equal(install.code, 0, install.stderr);
  return target;
}

test('installed core governance validator passes a valid installation', async () => {
  const target = await installProject('core');
  try {
    const result = await run(['.agents/loopengine/governance/validate.mjs'], { cwd: target });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Governance validation passed/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('basic governance validator rejects a missing required review rule', async () => {
  const target = await installProject('core');
  try {
    await unlink(path.join(target, 'docs/rules/review-rules.md'));
    const result = await run(['.agents/loopengine/governance/validate.mjs'], { cwd: target });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Missing required governance file: docs\/rules\/review-rules\.md/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('packet validator rejects empty evidence and missing red-team fields', async () => {
  const target = await installProject('core');
  try {
    const packet = path.join(target, 'packet.md');
    await writeFile(packet, `# Packet

## Summary
- Validation:
- Risks: high

## Dynamic Workflow
- Primary Workflow: Security
- Required modifiers: Security / Red Team

## Full Evidence
- Exit codes:

## Red Team
- Attack path: direct access
- Expected failure point: permission gate
- Attack result:
- Residual risk:
`, 'utf8');
    const result = await run(['.agents/loopengine/governance/validate-packet.mjs', '--file', packet], { cwd: target });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Empty field: Summary > Validation/);
    assert.match(result.stderr, /Red Team evidence missing: Attack result/);
    assert.match(result.stderr, /Red Team evidence missing: Residual risk/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('packet validator rejects placeholders and normalized full workflow names', async () => {
  const target = await installProject('core');
  try {
    const packet = path.join(target, 'placeholder-packet.md');
    await writeFile(packet, `# Packet

## Summary
- Validation: TODO
- Risks: TBD

## Dynamic Workflow
- Primary Workflow: Workflow-Infra (Full)
- Required modifiers: none
`, 'utf8');
    const result = await run(['.agents/loopengine/governance/validate-packet.mjs', '--file', packet], { cwd: target });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Empty field: Summary > Validation/);
    assert.match(result.stderr, /Missing section: Full Evidence/);
    assert.match(result.stderr, /Missing section: Red Team/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('packet validator treats Release as Full with Red Team evidence', async () => {
  const target = await installProject('core');
  try {
    const packet = path.join(target, 'release-packet.md');
    await writeFile(packet, `# Packet
## Summary
- Validation: release smoke passed
- Risks: rollout risk
## Dynamic Workflow
- Primary Workflow: Release
- Required modifiers: none
`, 'utf8');
    const result = await run(['.agents/loopengine/governance/validate-packet.mjs', '--file', packet], { cwd: target });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Missing section: Full Evidence/);
    assert.match(result.stderr, /Missing section: Red Team/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('packet validator accepts completed workflow and review packets from installed templates', async () => {
  const target = await installProject('core');
  try {
    const workflow = path.join(target, 'workflow.md');
    await writeFile(workflow, `# Workflow Packet
## Summary
- Validation: node test.mjs, exit 0
- Risks: low, docs only
## Dynamic Workflow
- Primary Workflow: UI
- Required modifiers: none
## Evidence
### Lightweight Evidence
- Exit codes: 0
`, 'utf8');
    const review = path.join(target, 'review.md');
    await writeFile(review, `# Review Packet
## Review Verdict
- Specification: Pass
- Code Quality: Approved
## Findings
No blocking findings.
## Verification Checked
node test.mjs, exit 0.
## Residual Risk
No browser verification; docs only.
`, 'utf8');
    const workflowResult = await run(['.agents/loopengine/governance/validate-packet.mjs', '--file', workflow], { cwd: target });
    const reviewResult = await run(['.agents/loopengine/governance/validate-packet.mjs', '--file', review], { cwd: target });
    assert.equal(workflowResult.code, 0, workflowResult.stderr);
    assert.equal(reviewResult.code, 0, reviewResult.stderr);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('full governance validator enforces task recovery and tier escalation semantics', async () => {
  const target = await installProject('full');
  try {
    await mkdir(path.join(target, 'docs/tasks'), { recursive: true });
    await writeFile(path.join(target, 'backlog.json'), JSON.stringify({
      tasks: [{
        id: 'T-200',
        phase: 'execute',
        status: 'blocked',
        resolution: 'open',
        risk: 'high',
        packetTier: 'Lightweight',
        nextAction: 'Resume implementation.',
      }],
    }, null, 2), 'utf8');
    const result = await run(['.agents/loopengine/governance/validate.mjs'], { cwd: target });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /T-200 blocked status requires blockedReason/);
    assert.match(result.stderr, /T-200 resumable status requires resumeHint/);
    assert.match(result.stderr, /T-200 high-risk Lightweight task requires implementTier=Full/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('full governance validator requires Pencil previews to be paired', async () => {
  const target = await installProject('full');
  try {
    await mkdir(path.join(target, 'design'), { recursive: true });
    await writeFile(path.join(target, 'design/workbench.pen'), 'design', 'utf8');
    const result = await run(['.agents/loopengine/governance/validate.mjs'], { cwd: target });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Missing design preview pair: design\/workbench\.png/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('full governance validator checks task manifests and duplicate memory ledger ids', async () => {
  const target = await installProject('full');
  try {
    const taskDir = path.join(target, 'docs/tasks/T-300');
    await mkdir(taskDir, { recursive: true });
    await writeFile(path.join(taskDir, 'task.json'), JSON.stringify({
      id: 'T-300',
      phase: 'done',
      status: 'idle',
      resolution: 'done',
      children: [{ id: 'T-300.001', resolution: 'open' }],
    }, null, 2), 'utf8');
    await writeFile(path.join(target, 'docs/memory/DECISIONS.md'), `# Decisions

- ID: DEC-20260711-001
- ID: DEC-20260711-001
`, 'utf8');
    await unlink(path.join(target, 'docs/memory/PROJECT_STATE.md'));
    const result = await run(['.agents/loopengine/governance/validate.mjs'], { cwd: target });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /T-300 cannot complete while child tasks remain open/);
    assert.match(result.stderr, /Duplicate decision ID: DEC-20260711-001/);
    assert.match(result.stderr, /Missing required full governance file: docs\/memory\/PROJECT_STATE\.md/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('full governance validator blocks incomplete merge-back, review, and cross-repo evidence', async () => {
  const target = await installProject('full');
  try {
    await writeFile(path.join(target, 'backlog.json'), JSON.stringify({ tasks: [{
      id: 'T-400',
      phase: 'done',
      status: 'idle',
      resolution: 'done',
      risk: 'high',
      mergeBackStatus: 'pending',
      crossRepoEvidence: {
        backendRef: '../service',
        endpoint: 'GET /health',
      },
    }] }, null, 2), 'utf8');
    const result = await run(['.agents/loopengine/governance/validate.mjs'], { cwd: target });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /T-400 done task requires mergeBackStatus=complete or not_required/);
    assert.match(result.stderr, /T-400 high-risk done task requires an independent verifier/);
    assert.match(result.stderr, /T-400 done cross-repo task requires crossRepoEvidence.resultSummary/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('full governance validator requires cross-repo evidence when project config enables it', async () => {
  const target = await installProject('full');
  try {
    const configPath = path.join(target, 'loopengine.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.crossRepo = { enabled: true, backendRepo: '../service' };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await writeFile(path.join(target, 'backlog.json'), JSON.stringify({ tasks: [{
      id: 'T-450',
      phase: 'done',
      status: 'idle',
      resolution: 'done',
      risk: 'low',
      mergeBackStatus: 'complete',
    }] }, null, 2), 'utf8');
    const result = await run(['.agents/loopengine/governance/validate.mjs'], { cwd: target });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /T-450 cross-repo project task requires crossRepoEvidence/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('full governance validator applies the installed task schema to task manifests', async () => {
  const target = await installProject('full');
  try {
    const taskDir = path.join(target, 'docs/tasks/T-500');
    await mkdir(taskDir, { recursive: true });
    await writeFile(path.join(taskDir, 'task.json'), JSON.stringify({
      id: 'T-500',
      unexpected: true,
    }, null, 2), 'utf8');
    const result = await run(['.agents/loopengine/governance/validate.mjs'], { cwd: target });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /task T-500\.title is required/);
    assert.match(result.stderr, /task T-500\.unexpected is not allowed/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('legacy internal install runs bundled full governance without project config', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-runtime-legacy-'));
  try {
    const install = await run([cliPath, 'install', '--target', target, '--profile', 'codex-internal', '--apply', '--confirm-red-zone']);
    assert.equal(install.code, 0, install.stderr);
    const result = await run(['.agents/loopengine/governance/validate.mjs'], { cwd: target });
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
