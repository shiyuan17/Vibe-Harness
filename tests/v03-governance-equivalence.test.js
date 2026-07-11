import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { detectProjectProfile } from '../scripts/lib/project-profile.js';
import { validateJsonAgainstSchema } from '../scripts/lib/manifest.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve('.');
const cliPath = path.join(rootDir, 'scripts/loopengine.js');

async function runCli(args) {
  const result = await execFileAsync(process.execPath, [cliPath, ...args], {
    maxBuffer: 1024 * 1024 * 8,
  });
  return result.stdout ? JSON.parse(result.stdout) : null;
}

test('capability matrix maps every reusable source capability to assets and tests', async () => {
  const matrix = JSON.parse(await readFile('manifests/capabilities.json', 'utf8'));
  const allowed = new Set(['generalize', 'validator', 'template', 'project-only', 'excluded-with-reason']);

  assert.equal(matrix.schemaVersion, 1);
  assert.equal(matrix.items.length >= 12, true);
  for (const item of matrix.items) {
    assert.equal(allowed.has(item.disposition), true, item.id);
    assert.equal(Array.isArray(item.tests) && item.tests.length > 0, true, `${item.id} tests`);
    if (item.disposition === 'excluded-with-reason' || item.disposition === 'project-only') {
      assert.equal(typeof item.reason === 'string' && item.reason.length > 0, true, `${item.id} reason`);
    } else {
      assert.equal(Array.isArray(item.targets) && item.targets.length > 0, true, `${item.id} targets`);
    }
  }
});

test('core and full profiles install the intended governance runtime surfaces', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-v03-profile-'));
  try {
    await runCli(['init', '--project', target]);
    const core = await runCli(['install', '--project', target, '--target', 'codex', '--profile', 'core', '--dry-run']);
    const full = await runCli(['install', '--project', target, '--target', 'codex', '--profile', 'full', '--dry-run']);
    const coreTargets = new Set(core.actions.map((action) => action.relativeTarget));
    const fullTargets = new Set(full.actions.map((action) => action.relativeTarget));

    assert.equal(coreTargets.has('docs/rules/review-rules.md'), true);
    assert.equal(coreTargets.has('docs/rules/task-intake.md'), true);
    assert.equal(coreTargets.has('docs/templates/review-packet.md'), true);
    assert.equal(coreTargets.has('.agents/loopengine/governance/validate.mjs'), true);
    assert.equal(coreTargets.has('.agents/loopengine/governance/validate-packet.mjs'), true);
    assert.equal(fullTargets.has('docs/memory/PROJECT_STATE.md'), true);
    assert.equal(fullTargets.has('docs/memory/FAILURE_LEARNINGS.md'), true);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('empty projects do not receive invented lint or typecheck commands', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-v03-empty-'));
  try {
    const profile = await detectProjectProfile({ targetDir: target });
    assert.equal(profile.validationCommands.lint, null);
    assert.equal(profile.validationCommands.typecheck, null);
    assert.equal(profile.validationCommands.governance, 'node .agents/loopengine/governance/validate.mjs');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('task schema accepts recovery, escalation, verifier, and cross-repo evidence fields', async () => {
  const schema = JSON.parse(await readFile('schemas/task.schema.json', 'utf8'));
  const task = {
    id: 'T-100',
    title: 'Validate governance contracts',
    phase: 'verify',
    status: 'waiting_dependency',
    resolution: 'open',
    goal: 'Prove task governance is recoverable.',
    acceptanceCriteria: ['Semantic validation passes.'],
    nonGoals: [],
    writeScope: ['docs/**'],
    forbiddenActions: ['Do not bypass review.'],
    verification: ['node .agents/loopengine/governance/validate.mjs'],
    stopCondition: 'Reviewer records a verdict.',
    rollbackPlan: 'Revert governance files.',
    nextAction: 'Request review.',
    resumeHint: 'Resume from the review packet.',
    blockedReason: 'Waiting for reviewer.',
    packetTier: 'Lightweight',
    implementTier: 'Full',
    verifier: 'independent-reviewer',
    crossRepoEvidence: {
      backendRef: '../backend',
      endpoint: 'GET /health',
      verifyCommand: 'curl http://service/health',
      resultSummary: 'Health contract verified.',
    },
    risk: 'high',
    children: [{
      id: 'T-100.001',
      title: 'Review child',
      goal: 'Review the change.',
      acceptanceCriteria: ['Verdict recorded.'],
      writeScope: ['docs/**'],
      verification: ['node check.mjs'],
      stopCondition: 'Review complete.',
      parallelSafety: 'shared-readonly',
      dependsOn: [],
      humanConfirmation: 'not_required',
      phase: 'review',
      status: 'idle',
      resolution: 'open',
    }],
  };

  assert.deepEqual(validateJsonAgainstSchema(task, schema, 'task'), []);
});

test('init defaults governance to basic and uses the installed validator command', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-v03-init-'));
  try {
    await runCli(['init', '--project', target]);
    const config = JSON.parse(await readFile(path.join(target, 'loopengine.config.json'), 'utf8'));
    assert.equal(config.governance.mode, 'basic');
    assert.equal(config.validationCommands.governance, 'node .agents/loopengine/governance/validate.mjs');
    assert.equal(config.validationCommands.lint, null);
    assert.equal(config.validationCommands.typecheck, null);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('validate project reports configured command availability without executing commands', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-v03-command-report-'));
  try {
    await runCli(['init', '--project', target]);
    await writeFile(path.join(target, 'package.json'), JSON.stringify({
      scripts: { lint: 'echo must-not-run' },
    }, null, 2), 'utf8');
    const configPath = path.join(target, 'loopengine.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.validationCommands.lint = 'npm run lint';
    config.validationCommands.typecheck = 'custom verify --all';
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await runCli(['install', '--project', target, '--target', 'codex', '--profile', 'core', '--write']);

    const report = await runCli(['validate', '--project', target]);
    assert.equal(report.commandStatus.lint.status, 'available');
    assert.equal(report.commandStatus.typecheck.status, 'manual');
    assert.equal(report.commandStatus.governance.status, 'available');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('v0.2 configs remain valid and governance mode follows the selected profile', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-v03-compat-'));
  try {
    await runCli(['init', '--project', target]);
    const configPath = path.join(target, 'loopengine.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    delete config.governance;
    config.validationCommands = {
      governance: 'pnpm run check:governance',
      lint: 'pnpm lint',
      typecheck: 'pnpm check:type',
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    const report = await runCli(['install', '--project', target, '--target', 'codex', '--profile', 'full', '--dry-run']);
    const agents = report.previewFiles.find((file) => file.target === 'AGENTS.md').content;
    assert.match(agents, /full/);
    assert.equal(report.governanceMode, 'full');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('minimal governance off mode does not reference an uninstalled validator', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-v03-minimal-command-'));
  try {
    await runCli(['init', '--project', target]);
    const configPath = path.join(target, 'loopengine.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.profile = 'minimal';
    config.governance.mode = 'off';
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    const install = await runCli(['install', '--project', target, '--target', 'codex', '--profile', 'minimal', '--write']);
    assert.equal(install.governanceMode, 'off');
    const agents = await readFile(path.join(target, 'AGENTS.md'), 'utf8');
    assert.doesNotMatch(agents, /node \.agents\/loopengine\/governance\/validate\.mjs/);
    const report = await runCli(['validate', '--project', target]);
    assert.equal(report.commandStatus.governance.status, 'not_configured');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('profile overrides select a safe governance mode and reject unsupported combinations', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-v03-mode-matrix-'));
  try {
    await runCli(['init', '--project', target]);
    const minimal = await runCli(['install', '--project', target, '--target', 'codex', '--profile', 'minimal', '--dry-run']);
    assert.equal(minimal.governanceMode, 'off');

    const configPath = path.join(target, 'loopengine.config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.profile = 'core';
    config.governance.mode = 'full';
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await assert.rejects(
      () => runCli(['install', '--project', target, '--target', 'codex', '--profile', 'core', '--dry-run']),
      /governance\.mode=full is not supported by profile core/,
    );
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('command status recognizes run scripts and does not overclaim external tool availability', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'loopengine-v03-command-semantics-'));
  try {
    await writeFile(path.join(target, 'package.json'), JSON.stringify({ scripts: { check: 'node check.mjs' } }), 'utf8');
    const { inspectValidationCommands } = await import('../scripts/lib/command-status.js');
    const report = await inspectValidationCommands({
      targetDir: target,
      commands: {
        check: 'pnpm run check',
        maven: 'mvn test',
        dotnet: 'dotnet test',
      },
    });
    assert.equal(report.check.status, 'available');
    assert.equal(report.maven.status, 'manual');
    assert.equal(report.dotnet.status, 'manual');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('installed packet templates expose the validator section contract', async () => {
  const workflow = await readFile('templates/workflow-packet.md', 'utf8');
  const review = await readFile('templates/review-packet.md', 'utf8');
  for (const heading of ['## Summary', '## Dynamic Workflow', '## Evidence']) assert.match(workflow, new RegExp(heading));
  assert.match(workflow, /^- Validation:$/mu);
  for (const heading of ['## Review Verdict', '## Findings', '## Verification Checked', '## Residual Risk']) assert.match(review, new RegExp(heading));
  assert.match(review, /^- Specification:$/mu);
});
