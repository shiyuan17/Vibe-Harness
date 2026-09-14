import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  buildEnvelopeDraft,
  checkEnvelope,
  DEFAULT_BASE_REF,
  modeEffectCeiling,
  summarizeEnvelopeCheck,
  summarizeEnvelopePlan,
} from '../scripts/lib/envelope-records.js';
import { removeTemporaryDirectory } from '../scripts/lib/temp-cleanup.js';
import { evaluateExecutionEnvelope, inspectWorkspaceIdentity } from '../runtime/hooks/lib/execution-envelope.mjs';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '..');
const ENVELOPE_CLI = path.join(repositoryRoot, 'scripts', 'envelope.js');
const FIXTURE_BRANCH = 'codex/wave-2-fixture';

async function makeGitFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'vibe-envelope-'));
  await writeFile(path.join(root, 'README.md'), '# fixture\n', 'utf8');
  await execFileAsync('git', ['init', '-q'], { cwd: root, windowsHide: true });
  await execFileAsync('git', ['symbolic-ref', 'HEAD', `refs/heads/${FIXTURE_BRANCH}`], { cwd: root, windowsHide: true });
  await execFileAsync('git', ['add', '.'], { cwd: root, windowsHide: true });
  await execFileAsync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '-q', '-m', 'fixture'], { cwd: root, windowsHide: true });
  const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true })).stdout.trim();
  return { head, root };
}

// One shared fixture keeps the git subprocess cost of this file bounded: each
// temporary repository costs several `git` spawns on Windows.
let fixture;
test.before(async () => { fixture = await makeGitFixture(); });
test.after(async () => { await removeTemporaryDirectory(fixture.root); });

async function runCli(args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [ENVELOPE_CLI, ...args], { windowsHide: true, ...options });
    return { code: 0, stderr, stdout };
  } catch (error) {
    return { code: error.code, stderr: error.stderr ?? '', stdout: error.stdout ?? '' };
  }
}

function hostProof(observedAt = new Date().toISOString()) {
  return {
    approval: 'interactive',
    filesystem: 'workspace-write',
    network: 'allowlisted',
    observedAt,
    process: 'isolated',
    source: 'host',
  };
}

// A structurally valid v2 envelope. The frozen workspace paths are placeholders
// because the mode-ceiling parity check below is decided before the hook
// compares them, so no git fixture is needed for that assertion.
function fakeEnvelope({ allowedEffects = [], mode = 'execute', riskClass = 'standard', hostContext = hostProof() } = {}) {
  return {
    activeObjective: 'parity fixture',
    allowedEffects,
    forbiddenEffects: [],
    hostContext,
    mode,
    requestId: 'req-fixture',
    riskClass,
    schema: 'vibe-harness.execution-envelope/v2',
    scope: {
      externalTargets: [],
      workspace: {
        allowedWriteRoots: [repositoryRoot],
        baseRef: 'HEAD',
        baseSha: '0'.repeat(40),
        branch: 'codex/fixture',
        canonicalCwd: path.join(repositoryRoot, 'fixture-cwd'),
        gitCommonDir: path.join(repositoryRoot, 'fixture-git-common'),
        gitDir: path.join(repositoryRoot, 'fixture-git-dir'),
        initialHeadSha: '1'.repeat(40),
        worktreeRoot: path.join(repositoryRoot, 'fixture-worktree'),
      },
    },
    sessionId: 'session-fixture',
    targetIssueIds: ['ENG-123'],
    terminalCondition: 'parity fixture',
  };
}

test('mode effect ceiling agrees with runtime enforcement for every mode', () => {
  const cases = [
    { effect: 'gitCommit', input: { toolInput: { command: 'git commit -m ENG-123' }, toolName: 'Shell' }, mode: 'plan' },
    { effect: 'workspaceWrite', input: { toolInput: { command: 'Set-Content ENG-123.txt ok' }, toolName: 'Shell' }, mode: 'monitor' },
    { effect: 'gitCommit', input: { toolInput: { command: 'git commit -m ENG-123' }, toolName: 'Shell' }, mode: 'linear-sync' },
    { effect: 'linearWrite', input: { toolInput: { id: 'ENG-123' }, toolName: 'mcp__linear__save_issue' }, mode: 'linear-sync' },
    { effect: 'gitCommit', input: { toolInput: { command: 'git commit -m ENG-123' }, toolName: 'Shell' }, mode: 'execute' },
    { effect: 'linearWrite', input: { toolInput: { id: 'ENG-123' }, toolName: 'mcp__linear__save_issue' }, mode: 'execute' },
  ];
  for (const { effect, input, mode } of cases) {
    const envelope = fakeEnvelope({ allowedEffects: [effect], mode });
    const decision = evaluateExecutionEnvelope({ ...input, cwd: repositoryRoot, sessionId: envelope.sessionId, executionEnvelope: envelope });
    const deniedByCeiling = decision.reasonCode === 'EXECUTION_ENVELOPE_MODE_VIOLATION';
    assert.equal(deniedByCeiling, !modeEffectCeiling(mode, 2).includes(effect), `${mode}/${effect}: ${JSON.stringify(decision)}`);
  }
  assert.deepEqual(modeEffectCeiling('execute', 1), modeEffectCeiling('execute', 1).filter((effect) => effect !== 'hostWrite' && effect !== 'externalWrite'));
});

test('envelope drafts freeze the real workspace identity and never fabricate host proof', () => {
  const plan = buildEnvelopeDraft({
      activeObjective: 'land wave 2',
      allowedEffects: ['workspaceWrite', 'gitCommit'],
      cwd: fixture.root,
      mode: 'execute',
      targetIssueIds: ['ENG-123'],
      terminalCondition: 'wave 2 scripts landed',
    });
  assert.equal(plan.valid, false);
  assert.deepEqual(plan.hostInjectedFields, ['requestId', 'sessionId', 'hostContext']);
  assert.equal(plan.hostProof.status, 'absent');
  assert.equal(plan.envelope.schema, 'vibe-harness.execution-envelope/v2');
  assert.equal(plan.envelope.hostContext, null);
  assert.equal(plan.envelope.scope.workspace.branch, FIXTURE_BRANCH);
  assert.equal(plan.envelope.scope.workspace.initialHeadSha, fixture.head);
  assert.equal(plan.envelope.scope.workspace.baseRef, DEFAULT_BASE_REF);
  assert.equal(plan.envelope.scope.workspace.baseSha, null);
  assert.equal(plan.envelope.scope.workspace.canonicalCwd.toLowerCase().endsWith(path.basename(fixture.root).toLowerCase()), true);
  const codes = plan.problems.map((problem) => problem.code);
  assert.equal(codes.includes('HOST_PROOF_ABSENT'), true);
  assert.equal(codes.includes('REQUEST_ID_MISSING'), true);
  assert.equal(codes.includes('BASE_REF_UNRESOLVED'), true);

  const complete = buildEnvelopeDraft({
    activeObjective: 'land wave 2',
    allowedEffects: ['workspaceWrite', 'gitCommit'],
    baseRef: 'HEAD',
    cwd: fixture.root,
    hostContext: hostProof(),
    mode: 'execute',
    requestId: 'req-1',
    sessionId: 'session-1',
    targetIssueIds: ['ENG-123'],
    terminalCondition: 'wave 2 scripts landed',
  });
  assert.equal(complete.valid, true, JSON.stringify(complete.problems));
  assert.equal(complete.enforcementGrade, 'scoped/standard');
  assert.deepEqual(complete.hostInjectedFields, []);
  assert.equal(complete.envelope.scope.workspace.baseSha, fixture.head);
  assert.equal(summarizeEnvelopePlan(complete).includes('status: valid'), true);
});

test('envelope checks fail closed on ceiling, conflict and expiry problems', async () => {
  // The workspace identity is inspected once and reused: these cases are about
  // the semantic checks, not about re-reading the Git workspace.
  const workspace = inspectWorkspaceIdentity(fixture.root);
  const check = (envelope) => checkEnvelope(envelope, { cwd: fixture.root, workspace });
  const valid = buildEnvelopeDraft({ activeObjective: 'high risk', allowedEffects: ['hostWrite'], baseRef: 'HEAD', cwd: fixture.root, hostContext: hostProof(), mode: 'execute', requestId: 'req-2', riskClass: 'high', sessionId: 'session-1', targetIssueIds: ['ENG-123'], terminalCondition: 'high risk' });
  assert.equal(valid.enforcementGrade, 'host-verified/high-risk');

  const validEnvelope = buildEnvelopeDraft({
    activeObjective: 'check fixture',
    allowedEffects: ['gitCommit'],
    baseRef: 'HEAD',
    cwd: fixture.root,
    hostContext: hostProof(),
    mode: 'execute',
    requestId: 'req-1',
    sessionId: 'session-1',
    targetIssueIds: ['ENG-123'],
    terminalCondition: 'check fixture',
  }).envelope;
  assert.equal(check(validEnvelope).ok, true);

  const ceiling = check({ ...validEnvelope, allowedEffects: ['gitCommit'], mode: 'plan' });
  assert.equal(ceiling.ok, false);
  assert.equal(ceiling.problems.some((problem) => problem.code === 'MODE_CEILING_EXCEEDED'), true);
  assert.deepEqual(ceiling.effectsOutsideCeiling, ['gitCommit']);

  const conflict = check({ ...validEnvelope, forbiddenEffects: ['gitCommit'] });
  assert.equal(conflict.problems.some((problem) => problem.code === 'EFFECT_CONFLICT'), true);

  const expired = check({ ...validEnvelope, expiresAt: '2020-01-01T00:00:00.000Z' });
  assert.equal(expired.problems.some((problem) => problem.code === 'ENVELOPE_EXPIRED'), true);

  const empty = check({ ...validEnvelope, targetIssueIds: [] });
  assert.equal(empty.ok, true);
  assert.equal(empty.problems.some((problem) => problem.code === 'ENVELOPE_TARGETS_EMPTY'), true);
});

test('envelope checks fail closed on host-proof and schema problems', () => {
  const workspace = inspectWorkspaceIdentity(fixture.root);
  const check = (envelope) => checkEnvelope(envelope, { cwd: fixture.root, workspace });
  const build = (overrides) => buildEnvelopeDraft({
    activeObjective: 'check fixture',
    allowedEffects: ['gitCommit'],
    baseRef: 'HEAD',
    cwd: fixture.root,
    hostContext: hostProof(),
    mode: 'execute',
    requestId: 'req-1',
    sessionId: 'session-1',
    targetIssueIds: ['ENG-123'],
    terminalCondition: 'check fixture',
    ...overrides,
  }).envelope;

  const stale = build({ hostContext: hostProof(new Date(Date.now() - 30 * 60 * 1000).toISOString()), riskClass: 'high' });
  assert.equal(check(stale).problems.find((problem) => problem.code === 'HOST_PROOF_STALE').severity, 'error');
  const standardStale = check({ ...stale, riskClass: 'standard' });
  assert.equal(standardStale.problems.find((problem) => problem.code === 'HOST_PROOF_STALE').severity, 'warning');
  assert.equal(standardStale.ok, true);

  const impostor = check({ ...build({}), hostContext: { ...hostProof(), source: 'agent' } });
  assert.equal(impostor.problems.some((problem) => problem.code === 'HOST_PROOF_SOURCE_INVALID'), true);
  const missingHost = check({ ...build({}), hostContext: undefined });
  assert.equal(missingHost.ok, false);
  assert.equal(missingHost.problems.some((problem) => problem.code === 'HOST_PROOF_ABSENT'), true);
  const hole = check({ ...build({}), sessionId: undefined });
  assert.equal(hole.problems.some((problem) => problem.code === 'ENVELOPE_SCHEMA_VIOLATION'), true);

  assert.equal(check({ schema: 'vibe-harness.execution-envelope/v9' }).problems[0].code, 'ENVELOPE_SCHEMA_UNSUPPORTED');
  assert.equal(check(null).problems[0].code, 'ENVELOPE_NOT_OBJECT');
});

test('v1 envelopes stay on the contract-only path and cannot carry high risk', () => {
  const base = {
    activeObjective: 'degraded v1',
    allowedEffects: ['gitCommit'],
    mode: 'execute',
    requestId: 'req-1',
    sessionId: 'session-1',
    targetIssueIds: ['ENG-123'],
    terminalCondition: 'degraded v1',
    version: 1,
  };
  const degraded = buildEnvelopeDraft({ ...base, cwd: fixture.root });
  assert.equal(degraded.valid, true, JSON.stringify(degraded.problems));
  assert.equal(degraded.enforcementGrade, 'contract-only/degraded');
  assert.equal(degraded.envelope.schema, 'vibe-harness.execution-envelope/v1');
  assert.equal(degraded.envelope.scope, undefined);
  assert.equal(degraded.envelope.hostContext, undefined);
  assert.equal(degraded.hostProof.required, false);
  assert.deepEqual(degraded.hostInjectedFields, []);

  const refused = buildEnvelopeDraft({ ...base, cwd: fixture.root, riskClass: 'high' });
  assert.equal(refused.valid, false);
  assert.equal(refused.problems.some((problem) => problem.code === 'V1_CANNOT_AUTHORIZE_HIGH_RISK'), true);

  const hostWrite = buildEnvelopeDraft({ ...base, allowedEffects: ['hostWrite'], cwd: fixture.root });
  assert.equal(hostWrite.problems.some((problem) => problem.code === 'UNKNOWN_EFFECT'), true);
});

test('envelope checks catch a workspace that no longer matches the frozen identity', async () => {
  const other = await makeGitFixture();
  try {
    const envelope = buildEnvelopeDraft({
      activeObjective: 'workspace check',
      allowedEffects: ['gitCommit'],
      baseRef: 'HEAD',
      cwd: fixture.root,
      hostContext: hostProof(),
      mode: 'execute',
      requestId: 'req-1',
      sessionId: 'session-1',
      targetIssueIds: ['ENG-123'],
      terminalCondition: 'workspace check',
    }).envelope;
    const elsewhere = checkEnvelope(envelope, { cwd: other.root });
    assert.equal(elsewhere.ok, false);
    const problem = elsewhere.problems.find((item) => item.code === 'WORKSPACE_MISMATCH');
    assert.equal(problem.path, 'scope.workspace');
    assert.equal(summarizeEnvelopeCheck(elsewhere).includes('status: failed'), true);

    const reshaped = { ...envelope, checkpoint: { ...checkpointFixture(envelope), headSha: '2'.repeat(40) } };
    const stale = checkEnvelope(reshaped, { cwd: fixture.root });
    assert.equal(stale.problems.some((item) => item.code === 'CHECKPOINT_STALE'), true);
  } finally {
    await removeTemporaryDirectory(other.root);
  }
});

function checkpointFixture(envelope) {
  return {
    activeObjective: envelope.activeObjective,
    blockerCount: 0,
    blockerFingerprint: 'none',
    completedFacts: [],
    continuationCount: 1,
    dagStructureHash: 'hash',
    headSha: envelope.scope.workspace.initialHeadSha,
    liveStates: { node: 'succeeded' },
    nextAction: 'none',
    noRepeatSet: [],
    targetIssueId: envelope.targetIssueIds[0],
  };
}

test('envelope CLI plans a draft, injects host proof and checks the result', async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'vibe-envelope-out-'));
  try {
    const draft = await runCli(['plan', '--cwd', fixture.root, '--mode', 'execute', '--issue', 'ENG-123', '--effect', 'gitCommit', '--objective', 'cli', '--terminal', 'cli', '--base-ref', 'HEAD', '--json', '--out', path.join(outDir, 'draft.json')]);
    assert.equal(draft.code, 1);
    const plan = JSON.parse(draft.stdout);
    assert.equal(plan.valid, false);
    assert.deepEqual(plan.hostInjectedFields, ['requestId', 'sessionId', 'hostContext']);
    assert.equal(plan.envelope.scope.workspace.branch, FIXTURE_BRANCH);

    const hostFile = path.join(outDir, 'host-context.json');
    await writeFile(hostFile, `${JSON.stringify(hostProof(), null, 2)}\n`, 'utf8');
    const envelopeFile = path.join(outDir, 'envelope.json');
    const written = await runCli([
      'plan', '--cwd', fixture.root, '--mode', 'execute', '--issue', 'ENG-123', '--effect', 'gitCommit',
      '--objective', 'cli', '--terminal', 'cli', '--base-ref', 'HEAD', '--host-context', hostFile,
      '--request-id', 'req-1', '--session-id', 'session-1', '--emit', 'envelope', '--out', envelopeFile, '--write',
    ]);
    assert.equal(written.code, 0, written.stderr);
    const envelope = JSON.parse(await readFile(envelopeFile, 'utf8'));
    assert.equal(envelope.sessionId, 'session-1');
    assert.equal(envelope.hostContext.source, 'host');
    assert.equal(envelope.scope.workspace.baseSha, fixture.head);

    const checked = await runCli(['check', '--file', envelopeFile, '--cwd', fixture.root, '--json']);
    assert.equal(checked.code, 0, checked.stderr);
    assert.equal(JSON.parse(checked.stdout).ok, true);
  } finally {
    await removeTemporaryDirectory(outDir);
  }
});

test('envelope CLI check fails closed outside the frozen workspace and reads stdin', async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'vibe-envelope-out-'));
  try {
    const hostFile = path.join(outDir, 'host-context.json');
    await writeFile(hostFile, `${JSON.stringify(hostProof(), null, 2)}\n`, 'utf8');
    const envelopeFile = path.join(outDir, 'envelope.json');
    const written = await runCli([
      'plan', '--cwd', fixture.root, '--mode', 'execute', '--issue', 'ENG-123', '--effect', 'gitCommit',
      '--objective', 'cli', '--terminal', 'cli', '--base-ref', 'HEAD', '--host-context', hostFile,
      '--request-id', 'req-1', '--session-id', 'session-1', '--emit', 'envelope', '--out', envelopeFile, '--write',
    ]);
    assert.equal(written.code, 0, written.stderr);
    const stale = await runCli(['check', '--file', envelopeFile, '--cwd', outDir, '--json']);
    assert.equal(stale.code, 1);
    // Outside a Git workspace the frozen identity cannot be verified, so the
    // pre-flight check fails closed instead of reporting a pass.
    assert.equal(JSON.parse(stale.stdout).problems.some((problem) => problem.code === 'WORKSPACE_UNAVAILABLE'), true);

    const envelope = JSON.parse(await readFile(envelopeFile, 'utf8'));
    const piped = execFileSync(process.execPath, [ENVELOPE_CLI, 'check', '--stdin', '--cwd', fixture.root, '--json'], {
      encoding: 'utf8',
      input: JSON.stringify(envelope),
      windowsHide: true,
    });
    assert.equal(JSON.parse(piped).ok, true);

    const bad = await runCli(['check', '--file', path.join(outDir, 'missing.json')]);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /not readable JSON/u);
    const unknownFlag = await runCli(['check', '--file', envelopeFile, '--nope']);
    assert.equal(unknownFlag.code, 1);
  } finally {
    await removeTemporaryDirectory(outDir);
  }
});
