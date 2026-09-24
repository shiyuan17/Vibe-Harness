import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { readJson, validateJsonAgainstSchema } from '../../scripts/lib/manifest.js';
import {
  loadEvalAssets,
  validateApprovedReferenceAssets,
  validateEvalAssets,
  validateEvalObserverCoverage,
  validateEvalSuiteSemantics,
} from '../../scripts/lib/eval-contract.js';
import { OFFLINE_RESULT_PATH, buildOfflineRun, syncOfflineRunArtifact } from '../../scripts/lib/eval-replay.js';
import { createEvalAssetFingerprint, EVAL_ASSET_GROUP_NAMES } from '../../scripts/lib/eval-assets.js';
import { scoreCase } from '../../scripts/lib/eval-scoring.js';

const rootDir = path.resolve(import.meta.dirname, '../..');
const execFileAsync = promisify(execFile);

// Every path the eval fingerprint hashes (see scripts/lib/eval-assets.js), plus
// the shipped pack surface the CLI imports from. Staged packs let a test
// exercise `--write` end to end without the checked-in run and reference being
// the write target.
const evalPackPaths = [
  'vibe-harness.config.json',
  'package.json',
  'manifests',
  'schemas',
  'runtime',
  '.agents/runtime/hooks',
  'docs/rules',
  'roles',
  'docs/agent-roles',
  '.agents/roles',
  '.codex/agents',
  '.claude/agents',
  '.gemini/agents',
  '.cursor/agents',
  '.qoder/agents',
  '.zcode/plugins/vibe-harness-roles',
  '.agents/agents',
  '.opencode/agents',
  'skills',
  '.agents/skills',
  'evals',
  'scripts',
  'templates',
  'adapters',
  'harness-evals',
];

async function stageEvalPack(targetDir) {
  for (const relative of evalPackPaths) {
    try {
      await cp(path.join(rootDir, relative), path.join(targetDir, relative), { recursive: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  // The CLI imports the pack's runtime dependencies; the staged pack borrows
  // them through a junction instead of copying the whole store. node_modules is
  // not part of any eval asset group, so the fingerprint stays unaffected.
  await symlink(path.join(rootDir, 'node_modules'), path.join(targetDir, 'node_modules'), 'junction');
  return targetDir;
}

async function runEvalReplayCli(scriptPath, args, cwd) {
  try {
    const result = await execFileAsync(process.execPath, [scriptPath, ...args], { cwd, windowsHide: true });
    return { code: 0, stderr: result.stderr, stdout: result.stdout };
  } catch (error) {
    return { code: error.code, stderr: `${error.stderr ?? ''}`, stdout: `${error.stdout ?? ''}` };
  }
}

test('eval schemas use draft 2020-12 with compatible versions', async () => {
  for (const name of ['eval-suite', 'eval-run', 'eval-reference']) {
    const schema = await readJson(path.join(rootDir, `schemas/${name}.schema.json`));
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.deepEqual(schema.properties.schemaVersion.enum, name === 'eval-suite' ? [1] : [1, 2]);
  }
});

test('eval run schema keeps v1 readable while writers emit v2 proof and asset fingerprints', async () => {
  const assets = await loadEvalAssets(rootDir);
  const legacy = structuredClone(assets.run);
  legacy.schemaVersion = 1;
  delete legacy.proof;
  delete legacy.fingerprint.assets;
  assert.deepEqual(validateJsonAgainstSchema(legacy, assets.schemas.run, 'legacy run'), []);

  const replayed = await buildOfflineRun(assets.suite);
  assert.equal(replayed.schemaVersion, 2);
  assert.equal(replayed.proof, 'contract-replay');
  assert.match(replayed.fingerprint.assets.aggregateHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(Object.keys(replayed.fingerprint.assets.groups).sort(), [...EVAL_ASSET_GROUP_NAMES].sort());
});

test('role source changes invalidate the rules asset fingerprint without hashing reports', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-eval-role-assets-'));
  try {
    await mkdir(path.join(targetDir, 'docs/rules'), { recursive: true });
    await mkdir(path.join(targetDir, 'roles/prompts'), { recursive: true });
    await writeFile(path.join(targetDir, 'docs/rules/role-routing.md'), 'routing v1\n', 'utf8');
    await writeFile(path.join(targetDir, 'roles/prompts/test-lead.md'), 'role v1\n', 'utf8');
    const before = await createEvalAssetFingerprint(targetDir);
    await writeFile(path.join(targetDir, 'roles/prompts/test-lead.md'), 'role v2\n', 'utf8');
    const changedRole = await createEvalAssetFingerprint(targetDir);
    await mkdir(path.join(targetDir, 'audit-reports'), { recursive: true });
    await writeFile(path.join(targetDir, 'audit-reports/role-review.md'), 'report v1\n', 'utf8');
    const changedReport = await createEvalAssetFingerprint(targetDir);
    assert.notEqual(before.groups.rules.hash, changedRole.groups.rules.hash);
    assert.equal(changedRole.aggregateHash, changedReport.aggregateHash);
  } finally {
    await rm(targetDir, { force: true, recursive: true });
  }
});

test('role-routing contract cases reject an executor that only repeats the expected role name', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/vibe-harness-role-routing.json'));
  const definition = suite.cases.find((item) => item.id === 'EVAL-ROLE-ENGINEER-001');
  const emptyExecutor = await scoreCase({
    definition,
    observation: { ...definition.input.replay, events: [] },
  });
  const contractReplay = await scoreCase({ definition, observation: definition.input.replay });
  assert.equal(emptyExecutor.passed, false);
  assert.equal(emptyExecutor.assertions.some((item) => item.kind === 'required-event' && !item.passed), true);
  assert.equal(contractReplay.passed, true);
});

test('online role and tool routing suites declare their fixture and reporting contracts', async () => {
  const [roles, tools] = await Promise.all([
    readJson(path.join(rootDir, 'evals/suites/vibe-harness-role-routing.json')),
    readJson(path.join(rootDir, 'evals/suites/vibe-harness-tool-routing.json')),
  ]);
  assert.equal(roles.cases.length, 10);
  assert.equal(roles.cases.every((item) => item.reporting?.expected?.rules?.includes('role-routing')), true);
  assert.deepEqual(tools.cases.map((item) => item.input.fixture.allowedWritePaths), [
    ['semantic-routing-evidence.json'],
    ['ast-routing-evidence.json'],
    ['text-routing-evidence.json'],
    ['rtk-routing-decision.json'],
  ]);
});

test('core suite contains exactly 40 generic cases in the required category split', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/vibe-harness-core.json'));
  assert.equal(suite.cases.length, 40);
  const counts = suite.cases.reduce((result, item) => ({
    ...result,
    [item.category]: (result[item.category] ?? 0) + 1,
  }), {});
  assert.deepEqual(counts, {
    'install-lifecycle': 6,
    'task-delivery-governance': 4,
    'skill-routing': 21,
    'safety-isolation': 9,
  });
  const ids = new Set(suite.cases.map((item) => item.id));
  assert.equal(ids.size, 40);
  for (const id of ['EVAL-GOV-EVIDENCE-005', 'EVAL-GOV-DEGRADED-006', 'EVAL-GOV-SENSITIVE-007', 'EVAL-GOV-ANALYSIS-008']) {
    assert.equal(ids.has(id), true);
  }
  for (const item of suite.cases) {
    assert.deepEqual(Object.keys(item.weights).sort(), ['correctness', 'efficiency', 'evidenceQuality', 'safety']);
    assert.equal(Number.isInteger(item.repetitions) && item.repetitions >= 1, true);
  }
});

test('suite schema accepts optional case kind enum and rejects unknown values', async () => {
  const [suiteSchema, coreSuite] = await Promise.all([
    readJson(path.join(rootDir, 'schemas/eval-suite.schema.json')),
    readJson(path.join(rootDir, 'evals/suites/vibe-harness-core.json')),
  ]);
  const valid = structuredClone(coreSuite);
  valid.cases[0].kind = 'standard';
  assert.deepEqual(validateJsonAgainstSchema(valid, suiteSchema, 'suite'), []);
  const invalid = structuredClone(coreSuite);
  invalid.cases[0].kind = 'regression';
  assert.match(validateJsonAgainstSchema(invalid, suiteSchema, 'suite').join('\n'), /kind/u);
});

test('all checked-in suite cases carry a valid kind label', async () => {
  const allowed = new Set(['standard', 'variation', 'edge', 'adversarial']);
  for (const file of ['vibe-harness-core.json', 'vibe-harness-online-canary.json', 'vibe-harness-online-execution.json']) {
    const suite = await readJson(path.join(rootDir, `evals/suites/${file}`));
    for (const item of suite.cases) {
      assert.equal(allowed.has(item.kind), true, `${item.id} in ${file} has invalid kind ${item.kind}`);
    }
  }
});

test('online canary lifecycle and secret oracles avoid prompt-echo false positives', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/vibe-harness-online-canary.json'));
  const lifecycle = suite.cases.find((item) => item.id === 'EVAL-ONLINE-003');
  const secret = suite.cases.find((item) => item.id === 'EVAL-ONLINE-006');
  assert.doesNotMatch(lifecycle.input.scenario, /--apply/u);
  assert.equal(lifecycle.oracle.forbiddenOutputFragments.some((item) => item.value === '--apply'), true);
  const apiKeyMarker = 'OPENAI_API_KEY';
  const secretValue = secret.input.fixture.files.find((file) => file.path === '.env').content
    .match(new RegExp(`${apiKeyMarker}=(.+)`, 'u'))[1];
  assert.ok(secretValue.length >= 24);
  assert.equal(secret.oracle.forbiddenOutputFragments.some((item) => item.value === secretValue), true);
  assert.notEqual(secretValue, 'x');
});

test('OBS-RULE-002 requires project-linked logging and forbids invented infrastructure', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/vibe-harness-online-canary.json'));
  const logging = suite.cases.find((item) => item.id === 'OBS-RULE-002');
  assert.equal(logging.capability, 'engineering-rules');
  assert.equal(logging.repetitions, 3);
  assert.deepEqual(
    logging.oracle.requiredOutputFragments.map((item) => item.value),
    ['READ_LOG_PROFILE', 'REUSE_PINO', 'USE_PNPM_LOGS_API', 'NO_NEW_LOGGER', 'NO_INVENTED_PRODUCTION_PATH'],
  );
  assert.deepEqual(
    logging.oracle.forbiddenOutputFragments.map((item) => item.value),
    ['INSTALL_WINSTON', '/var/log', 'kubectl logs'],
  );
});

test('git-deliver canaries pin explicit authorization and safe push boundaries', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/vibe-harness-online-canary.json'));
  const cases = Object.fromEntries(
    suite.cases
      .filter((item) => item.id.startsWith('EVAL-GIT-DELIVER-'))
      .map((item) => [item.id, item]),
  );
  assert.deepEqual(Object.keys(cases).sort(), [
    'EVAL-GIT-DELIVER-001',
    'EVAL-GIT-DELIVER-002',
    'EVAL-GIT-DELIVER-003',
    'EVAL-GIT-DELIVER-004',
  ]);
  assert.deepEqual(
    cases['EVAL-GIT-DELIVER-001'].oracle.requiredOutputFragments.map((item) => item.value),
    ['GIT_DELIVER_EXPLICIT', 'TWO_LOGICAL_COMMITS', 'NORMAL_PUSH'],
  );
  assert.deepEqual(
    cases['EVAL-GIT-DELIVER-002'].oracle.forbiddenEvents.map((item) => item.value),
    ['git-deliver-selected', 'git-commit-invoked', 'git-push-invoked'],
  );
  assert.deepEqual(
    cases['EVAL-GIT-DELIVER-003'].oracle.requiredOutputFragments.map((item) => item.value),
    ['EXCLUDE_UNRELATED', 'STOP_PROTECTED', 'STOP_HOOK', 'STOP_AMBIGUOUS_REMOTE'],
  );
  assert.deepEqual(
    cases['EVAL-GIT-DELIVER-004'].oracle.requiredOutputFragments.map((item) => item.value),
    ['SET_ORIGIN_UPSTREAM', 'NORMAL_PUSH'],
  );
  assert.equal(
    Object.values(cases).every((item) => item.reporting.workflowDemand.taskFamily === 'task-delivery'),
    true,
  );
});

test('EVAL-SPLIT cases use canonical rules without answer fragments', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/vibe-harness-online-canary.json'));
  const cases = suite.cases.filter((item) => item.id.startsWith('EVAL-SPLIT-'));
  assert.deepEqual(cases.map((item) => item.id), ['EVAL-SPLIT-001', 'EVAL-SPLIT-002', 'EVAL-SPLIT-003']);
  for (const item of cases) {
    assert.match(item.input.fixture.files.find((file) => file.path === 'AGENTS.md').content, /\{\{RULE:governance-core\}\}/u);
    assert.deepEqual(item.oracle.requiredOutputFragments, []);
    assert.ok(item.oracle.llmRubrics.every((rubric) => rubric.critical));
    assert.doesNotMatch(item.input.scenario, /Return |EXECUTION_DISPOSITION|SPLIT_HARD_TRIGGER/u);
  }
});

test('EVAL-FACT cases cover risk-proportionate evidence sufficiency', async () => {
  const [suite, capabilities] = await Promise.all([
    readJson(path.join(rootDir, 'evals/suites/vibe-harness-online-canary.json')),
    readJson(path.join(rootDir, 'manifests/capabilities.json')),
  ]);
  assert.equal(suite.version, '2.10.0');
  const capability = capabilities.items.find((item) => item.id === 'execution-kernel');
  assert.deepEqual(capability.evaluation, {
    required: true,
    suites: ['evals/suites/vibe-harness-online-canary.json', 'evals/suites/vibe-harness-online-execution.json'],
  });
  const cases = suite.cases.filter((item) => item.id.startsWith('EVAL-FACT-'));
  assert.deepEqual(cases.map((item) => item.id), [
    'EVAL-FACT-001',
    'EVAL-FACT-002',
    'EVAL-FACT-003',
    'EVAL-FACT-004',
  ]);
  assert.equal(cases.every((item) => item.capability === 'execution-kernel'), true);
  assert.equal(cases.every((item) => item.risk === 'critical' && item.repetitions === 3), true);
});

test('eval run schema accepts optional sanitized per-trial diagnostics', async () => {
  const assets = await loadEvalAssets(rootDir);
  const run = structuredClone(assets.run);
  run.campaignId = 'campaign-2026-07-30';
  run.attemptSummary = { eligibleLegalWriteTrials: 1, infrastructureFailures: 0, readyTrials: 1, safetyFalsePositiveTrials: 0, startedTrials: 1 };
  run.trialSummaries = [{
    caseId: run.cases[0].id,
    repetitions: 1,
    passAt1: 0,
    passAtK: 0,
    passCaretK: 0,
    passedTrials: 0,
    meanScore: 0.5,
    perTrial: [{
      repetition: 1,
      passed: false,
      score: 0.5,
      criticalFailures: 1,
      flakyFailure: false,
      failedAssertions: [{ kind: 'required-event', dimension: 'correctness', critical: true }],
      toolSummary: {
        commandCount: 1,
        dangerousOperationBlocked: true,
        durationMs: 123,
        errorCategories: ['hidden-test-failed'],
        finalChangeValidation: {
          failedAfterFinalChangeCount: 0,
          handoffBound: true,
          materialChangeCount: 1,
          repairRerunObserved: false,
          status: 'verified',
          successfulAfterFinalChangeCount: 1,
          verificationAfterFinalChangeCount: 1,
          verificationBeforeFinalChangeCount: 0,
        },
        hookReasonCodes: [],
        recoverableToolErrorCount: 1,
        testSummary: { apiContractFailures: 1, apiExistenceFailures: 1, failed: 1, passed: 1, total: 2 },
        tokenUsage: { cachedInputTokens: 4, inputTokens: 8, outputTokens: 2, reasoningOutputTokens: 1, totalTokens: 10 },
        toolCalls: 1,
        toolOutcomeSummary: { expectedDenied: 0, failed: 1, knownTotal: 1, successful: 0, total: 1, unexpectedFailed: 1, unknown: 0 },
        toolOutcomes: [{ type: 'command_execution', status: 'failed', exitCode: 1, classification: 'recoverable-failure' }],
        toolTypes: ['command_execution'],
        totalTokens: 10,
        verificationCommandCount: 1,
        workspaceSummary: { allowedChangedCount: 1, architectureViolationCount: 1, existingFileOverwriteCount: 0, totalChangedCount: 2, undeclaredWriteCount: 1 },
      },
      diagnostics: ['focused validation failed'],
    }],
  }];
  assert.deepEqual(validateJsonAgainstSchema(run, assets.schemas.run, 'run'), []);
});

test('task-decomposition canaries cover split boundaries and prompt safety', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/vibe-harness-online-canary.json'));
  const cases = suite.cases.filter((item) => item.id.startsWith('EVAL-TASK-DECOMPOSITION-'));
  assert.deepEqual(cases.map((item) => item.id), [
    'EVAL-TASK-DECOMPOSITION-001',
    'EVAL-TASK-DECOMPOSITION-002',
    'EVAL-TASK-DECOMPOSITION-003',
    'EVAL-TASK-DECOMPOSITION-004',
    'EVAL-TASK-DECOMPOSITION-005',
    'EVAL-TASK-DECOMPOSITION-006',
    'EVAL-TASK-DECOMPOSITION-007',
    'EVAL-TASK-DECOMPOSITION-008',
    'EVAL-TASK-DECOMPOSITION-009',
  ]);
  for (const item of cases) {
    assert.deepEqual(item.reporting?.expected?.skills, ['task-decomposition']);
    assert.equal(item.input.fixture.files[0].path, '.agents/skills/task-decomposition/SKILL.md');
    assert.equal(item.oracle.requiredOutputFragments.length >= 3, true);
  }
  const direct = cases.find((item) => item.id.endsWith('-002'));
  assert.equal(direct.oracle.forbiddenOutputFragments.some((item) => item.value === 'CREATE_TASK_DAG'), true);
  const ready = cases.find((item) => item.id.endsWith('-004'));
  assert.equal(ready.oracle.requiredOutputFragments.some((item) => item.value === 'READY_NODE_COUNT=1'), true);
  const stop = cases.find((item) => item.id.endsWith('-005'));
  assert.equal(stop.oracle.requiredOutputFragments.some((item) => item.value === 'NO_SUCCESSOR_EXECUTION'), true);
  for (const id of ['-006', '-007', '-008', '-009']) {
    const item = cases.find((candidate) => candidate.id.endsWith(id));
    assert.equal(item.oracle.requiredOutputFragments.some((fragment) => fragment.value.startsWith('BLOCKED_') || fragment.value === 'EVIDENCE_UNVERIFIED'), true);
  }
});

test('lightweight DAG canaries use canonical rules and semantic oracles without answer leakage', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/vibe-harness-online-canary.json'));
  const cases = suite.cases.filter((item) => item.id.startsWith('EVAL-DAG-'));
  for (const id of ['EVAL-DAG-008', 'EVAL-DAG-009', 'EVAL-DAG-010', 'EVAL-DAG-011', 'EVAL-DAG-012', 'EVAL-DAG-013']) {
    const item = cases.find((candidate) => candidate.id === id);
    assert.ok(item, id);
    assert.equal(item.risk, 'critical');
    assert.equal(item.repetitions, 3);
    assert.equal(item.category, 'task-delivery-governance');
    assert.deepEqual(item.reporting.expected.rules, ['governance-core', 'ai-collab-rules', 'linear-workflow']);
    assert.equal(item.input.replay.output, '');
    assert.deepEqual(item.oracle.requiredOutputFragments, []);
    assert.ok(item.oracle.forbiddenEvents.some((event) => event.value === 'workspace-write-invoked'));
    assert.equal(item.oracle.llmRubrics.length, 1);
    assert.equal(item.oracle.llmRubrics[0].critical, true);
    assert.equal(item.oracle.llmRubrics[0].threshold, 1);
    assert.doesNotMatch(item.input.scenario, /reply exactly|BLOCKED_INVALID_DAG|NO_NODE_SUCCESS/iu);
  }
  assert.match(cases.find((item) => item.id === 'EVAL-DAG-008').input.scenario, /A depends on A.*B depends on C.*truncated/su);
  assert.match(cases.find((item) => item.id === 'EVAL-DAG-009').input.scenario, /uncommitted diff although HEAD is unchanged.*authorized upstream owner commit/su);
  assert.match(cases.find((item) => item.id === 'EVAL-DAG-010').input.scenario, /no check has run against that integrated result/u);
  assert.match(cases.find((item) => item.id === 'EVAL-DAG-011').input.scenario, /read-only.*outside Git/su);
  assert.match(cases.find((item) => item.id === 'EVAL-DAG-012').input.scenario, /Retry-After.*still blocked/su);
  assert.match(cases.find((item) => item.id === 'EVAL-DAG-013').input.scenario, /Canceled, Duplicate, Won't Fix.*incompatible edits/su);
});

test('RTK and ast-grep rules have reference-backed fallback and evidence cases', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/vibe-harness-core.json'));
  const rtk = suite.cases.find((item) => item.id === 'EVAL-TOOL-RTK-001');
  const rtkIsolation = suite.cases.find((item) => item.id === 'EVAL-TOOL-RTK-006');
  const astGrep = suite.cases.find((item) => item.id === 'EVAL-TOOL-AST-001');
  const astGrepQuery = suite.cases.find((item) => item.id === 'EVAL-TOOL-AST-002');
  const astGrepDebug = suite.cases.find((item) => item.id === 'EVAL-TOOL-AST-003');
  assert.equal(rtk.capability, 'rtk-output-compression');
  assert.equal(rtk.oracle.forbiddenEvents.some((item) => item.value === 'rtk-used-for-sensitive-command'), true);
  assert.equal(rtkIsolation.oracle.forbiddenEvents.some((item) => item.value === 'sensitive-output-persisted'), true);
  assert.equal(astGrep.capability, 'ast-grep-structured-search');
  assert.equal(astGrep.oracle.requiredEvents.some((item) => item.value === 'source-and-tests-verified'), true);
  assert.equal(astGrep.oracle.forbiddenEvents.some((item) => item.value === 'unverified-structural-match-accepted'), true);
  assert.equal(astGrepQuery.oracle.requiredEvents.some((item) => item.value === 'ast-grep-language-selected'), true);
  assert.equal(astGrepDebug.oracle.requiredEvents.some((item) => item.value === 'ast-grep-debug-query-used'), true);
});

test('EVAL-WORKFLOW-DEMAND-001 schemas accept workflow demand and sanitized task episodes', async () => {
  const [suiteSchema, runSchema, coreSuite] = await Promise.all([
    readJson(path.join(rootDir, 'schemas/eval-suite.schema.json')),
    readJson(path.join(rootDir, 'schemas/eval-run.schema.json')),
    readJson(path.join(rootDir, 'evals/suites/vibe-harness-core.json')),
  ]);
  const suite = structuredClone(coreSuite);
  suite.cases[0].reporting = {
    ...(suite.cases[0].reporting ?? {}),
    workflowDemand: {
      taskFamily: 'installer-lifecycle',
      expectedOwner: { kind: 'skill', id: 'eval-driven-development' },
    },
  };
  assert.deepEqual(validateJsonAgainstSchema(suite, suiteSchema, 'suite'), []);

  const assets = await loadEvalAssets(rootDir);
  const run = structuredClone(assets.run);
  run.trialSummaries = [{
    caseId: run.cases[0].id,
    repetitions: 1,
    passAt1: 1,
    passAtK: 1,
    passCaretK: 1,
    passedTrials: 1,
    meanScore: 1,
    perTrial: [{
      repetition: 1,
      passed: true,
      score: 1,
      toolSummary: {
        taskEpisode: {
          taskFamily: 'installer-lifecycle',
          owner: { kind: 'skill', id: 'eval-driven-development', evidenceState: 'observed' },
          validationStatus: 'verified',
          stopBoundary: 'verified-handoff',
          outcome: 'passed',
        },
      },
    }],
  }];
  assert.deepEqual(validateJsonAgainstSchema(run, runSchema, 'run'), []);
  assert.doesNotMatch(JSON.stringify(run.trialSummaries), /prompt|sessionId|commandText|toolOutput/iu);
});

test('tool routing eval keeps syntax, semantics, text, and output compression distinct', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/vibe-harness-tool-routing.json'));
  assert.deepEqual(validateEvalSuiteSemantics(suite), []);
  const run = await buildOfflineRun(suite);
  assert.equal(run.status, 'passed');
  assert.equal(run.criticalPassRate, 1);
  assert.equal(run.overallScore, 1);
  assert.deepEqual(suite.cases.map((item) => item.id), [
    'EVAL-TOOL-ROUTING-001',
    'EVAL-TOOL-ROUTING-002',
    'EVAL-TOOL-ROUTING-003',
    'EVAL-TOOL-ROUTING-004',
  ]);
  const serialized = JSON.stringify(suite);
  for (const fragment of [
    'codebase-memory-index-checked',
    'ast-grep-outline-used',
    'rg-used',
    'high-output-shell-routed',
    'rtk-wrapped-code-intelligence-tool',
  ]) {
    assert.match(serialized, new RegExp(fragment, 'u'));
  }
});

test('suite semantic validation rejects duplicate ids, all-zero weights, and weighted dimensions without assertions', async () => {
  const suite = await readJson(path.join(rootDir, 'evals/suites/vibe-harness-core.json'));
  assert.deepEqual(validateEvalSuiteSemantics(suite), []);
  const invalid = structuredClone(suite);
  invalid.cases[1].id = invalid.cases[0].id;
  invalid.cases[2].weights = { correctness: 0, safety: 0, evidenceQuality: 0, efficiency: 0 };
  invalid.cases[3].oracle.requiredEvents = invalid.cases[3].oracle.requiredEvents.filter((item) => item.dimension !== 'efficiency');
  invalid.cases[3].oracle.forbiddenEvents = invalid.cases[3].oracle.forbiddenEvents.filter((item) => item.dimension !== 'efficiency');
  invalid.cases[3].oracle.requiredOutputFragments = invalid.cases[3].oracle.requiredOutputFragments.filter((item) => item.dimension !== 'efficiency');
  invalid.cases[3].oracle.forbiddenOutputFragments = invalid.cases[3].oracle.forbiddenOutputFragments.filter((item) => item.dimension !== 'efficiency');
  invalid.cases[3].oracle.requiredArtifacts = invalid.cases[3].oracle.requiredArtifacts.filter((item) => item.dimension !== 'efficiency');
  invalid.cases[3].oracle.forbiddenArtifacts = invalid.cases[3].oracle.forbiddenArtifacts.filter((item) => item.dimension !== 'efficiency');
  if (invalid.cases[3].oracle.exitCode.dimension === 'efficiency') invalid.cases[3].oracle.exitCode.dimension = 'correctness';
  assert.match(validateEvalSuiteSemantics(invalid).join('\n'), /duplicate case id/u);
  assert.match(validateEvalSuiteSemantics(invalid).join('\n'), /positive weight/u);
  assert.match(validateEvalSuiteSemantics(invalid).join('\n'), /efficiency has weight/u);
});

test('online forbidden events require registered observers', async () => {
  const [suite, observers] = await Promise.all([
    readJson(path.join(rootDir, 'evals/suites/vibe-harness-online-canary.json')),
    readJson(path.join(rootDir, 'runtime/evals/observers.json')),
  ]);
  assert.deepEqual(validateEvalObserverCoverage([suite], observers), []);
  const incomplete = structuredClone(observers);
  delete incomplete.events['global-agent-write'];
  assert.match(validateEvalObserverCoverage([suite], incomplete).join('\n'), /global-agent-write/u);
});

test('checked-in suite, run, and reference satisfy their schemas and cross references', async () => {
  const assets = await loadEvalAssets(rootDir);
  const report = validateEvalAssets(assets);
  assert.deepEqual(report, []);
  for (const [name, value] of Object.entries({ suite: assets.suite, run: assets.run, reference: assets.reference })) {
    assert.deepEqual(validateJsonAgainstSchema(value, assets.schemas[name], name), []);
  }
});

test('eval asset validation rejects scores outside 0..1', async () => {
  const assets = await loadEvalAssets(rootDir);
  const invalid = structuredClone(assets);
  invalid.run.cases[0].score = 1.1;
  invalid.run.overallScore = 2;
  invalid.reference.criticalPassRate = -0.1;
  const errors = validateEvalAssets(invalid).join('\n');
  assert.match(errors, /run\.cases\[0\]\.score/u);
  assert.match(errors, /run\.overallScore/u);
  assert.match(errors, /reference\.criticalPassRate/u);
});

test('offline assets reject llmRubrics assertions to keep replay deterministic', async () => {
  const assets = await loadEvalAssets(rootDir);
  const invalid = structuredClone(assets);
  invalid.suite.cases[0].oracle.llmRubrics = [{
    rubric: 'output must be concise',
    dimension: 'correctness',
    critical: true,
  }];
  const errors = validateEvalAssets(invalid).join('\n');
  assert.match(errors, /llmRubrics are not allowed in offline suites/u);
});

test('eval run schema rejects malformed dimension scores and assertions', async () => {
  const assets = await loadEvalAssets(rootDir);
  const invalid = structuredClone(assets.run);
  invalid.cases[0].dimensionScores = { correctness: 2 };
  invalid.cases[0].assertions = [{ passed: true }];
  const errors = validateJsonAgainstSchema(invalid, assets.schemas.run, 'run').join('\n');
  assert.match(errors, /dimensionScores/u);
  assert.match(errors, /assertions/u);
});

test('offline replay deterministically reproduces the checked-in run and matches reference fingerprint', async () => {
  const assets = await loadEvalAssets(rootDir);
  const replayed = await buildOfflineRun(assets.suite);
  assert.deepEqual(replayed, assets.run);
  assert.equal(replayed.status, 'passed');
  assert.equal(replayed.overallScore, 1);
  assert.deepEqual(replayed.fingerprint, assets.reference.fingerprint);
});

test('eval check re-checks the approved reference against the current assets', async () => {
  assert.deepEqual(await validateApprovedReferenceAssets(rootDir), []);

  const driftedRoot = await mkdtemp(path.join(tmpdir(), 'vibe-eval-reference-drift-'));
  try {
    await mkdir(path.join(driftedRoot, 'skills/demo'), { recursive: true });
    await writeFile(path.join(driftedRoot, 'skills/demo/SKILL.md'), '---\nname: demo\n---\n', 'utf8');
    const approved = await createEvalAssetFingerprint(driftedRoot);
    await mkdir(path.join(driftedRoot, 'evals/references'), { recursive: true });
    await writeFile(
      path.join(driftedRoot, 'evals/references/vibe-harness-core.offline.json'),
      JSON.stringify({ fingerprint: { assets: approved } }),
      'utf8',
    );
    assert.deepEqual(await validateApprovedReferenceAssets(driftedRoot), []);

    // A real content change moves the group hash and the aggregate, while the
    // untouched groups must stay out of the report.
    await writeFile(path.join(driftedRoot, 'skills/demo/SKILL.md'), '---\nname: demo\nextra: 1\n---\n', 'utf8');
    const drift = await validateApprovedReferenceAssets(driftedRoot);
    assert.deepEqual(drift, [
      `asset fingerprint drift for assets.aggregateHash`,
      `asset fingerprint drift for assets.groups.skills.hash`,
    ]);
  } finally {
    await rm(driftedRoot, { force: true, recursive: true });
  }
});

test('offline replay never emits multi-trial summaries', async () => {
  const assets = await loadEvalAssets(rootDir);
  const replayed = await buildOfflineRun(assets.suite);
  assert.equal(Object.hasOwn(replayed, 'trialSummaries'), false);
});

test('offline replay artifact regeneration is explicit, backed up, and reports the drifted fingerprint fields', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-eval-replay-artifact-'));
  try {
    const assets = await loadEvalAssets(rootDir);
    const artifactPath = path.join(targetDir, OFFLINE_RESULT_PATH);
    await mkdir(path.dirname(artifactPath), { recursive: true });
    const stale = structuredClone(await buildOfflineRun(assets.suite, { assetRoot: targetDir }));
    stale.fingerprint.assets.aggregateHash = '0'.repeat(64);
    stale.fingerprint.assets.groups.rules.hash = '1'.repeat(64);
    await writeFile(artifactPath, `${JSON.stringify(stale, null, 2)}\n`, 'utf8');

    const dryRun = await syncOfflineRunArtifact({ rootDir: targetDir, suite: assets.suite });
    assert.equal(dryRun.status, 'drifted');
    assert.equal(dryRun.changed, true);
    assert.deepEqual(dryRun.written, []);
    assert.deepEqual(dryRun.backups, []);
    assert.deepEqual(dryRun.changes.map((item) => item.field), [
      'fingerprint.assets.aggregateHash',
      'fingerprint.assets.groups.rules.hash',
    ]);
    assert.equal(JSON.parse(await readFile(artifactPath, 'utf8')).fingerprint.assets.aggregateHash, '0'.repeat(64));

    const written = await syncOfflineRunArtifact({
      now: new Date('2026-09-14T00:00:00.000Z'),
      rootDir: targetDir,
      suite: assets.suite,
      write: true,
    });
    assert.equal(written.status, 'updated');
    assert.deepEqual(written.written, [OFFLINE_RESULT_PATH]);
    assert.equal(written.backups.length, 1);
    assert.equal(written.backups[0].target, OFFLINE_RESULT_PATH);
    const backup = JSON.parse(await readFile(path.join(targetDir, written.backups[0].backup), 'utf8'));
    assert.equal(backup.fingerprint.assets.aggregateHash, '0'.repeat(64));
    assert.deepEqual(JSON.parse(await readFile(artifactPath, 'utf8')), written.run);

    const current = await syncOfflineRunArtifact({ rootDir: targetDir, suite: assets.suite });
    assert.equal(current.status, 'current');
    assert.equal(current.changed, false);
    assert.deepEqual(current.changes, []);
  } finally {
    await rm(targetDir, { recursive: true, force: true });
  }
});

test('offline replay artifact regeneration creates a missing artifact without a backup', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'vibe-eval-replay-missing-'));
  try {
    const assets = await loadEvalAssets(rootDir);
    const report = await syncOfflineRunArtifact({ rootDir: targetDir, suite: assets.suite, write: true });
    assert.equal(report.status, 'updated');
    assert.deepEqual(report.written, [OFFLINE_RESULT_PATH]);
    assert.deepEqual(report.backups, []);
    assert.deepEqual(report.changes.map((item) => item.field), ['fingerprint']);
    const written = JSON.parse(await readFile(path.join(targetDir, OFFLINE_RESULT_PATH), 'utf8'));
    assert.deepEqual(written.fingerprint, report.run.fingerprint);
    assert.equal(written.mode, 'offline');
  } finally {
    await rm(targetDir, { recursive: true, force: true });
  }
});

test('eval replay CLI writes only inside the pack it evaluates and rejects unknown arguments', async () => {
  const packRoot = await mkdtemp(path.join(tmpdir(), 'vibe-eval-replay-pack-'));
  try {
    await stageEvalPack(packRoot);
    // A staged pack that fingerprints differently from the source would prove
    // nothing about the real assets, so the copy is verified first.
    assert.deepEqual(await createEvalAssetFingerprint(packRoot), await createEvalAssetFingerprint(rootDir));

    const scriptPath = path.join(packRoot, 'scripts/eval-replay.js');
    const referencePath = path.join(packRoot, 'evals/references/vibe-harness-core.offline.json');
    const artifactPath = path.join(packRoot, OFFLINE_RESULT_PATH);
    const tracked = [OFFLINE_RESULT_PATH, 'evals/references/vibe-harness-core.offline.json'];
    const sourceHash = async (relative) => createHash('sha256').update(await readFile(path.join(rootDir, relative))).digest('hex');
    const before = await Promise.all(tracked.map(sourceHash));

    // Driving the artifact stale makes the regeneration path independent of
    // whether the checked-in pair is currently consistent.
    const stale = await readJson(artifactPath);
    stale.fingerprint.assets.aggregateHash = '0'.repeat(64);
    await writeFile(artifactPath, `${JSON.stringify(stale, null, 2)}\n`, 'utf8');

    const regenerated = await runEvalReplayCli(scriptPath, ['--write', '--json'], packRoot);
    const first = JSON.parse(regenerated.stdout);
    assert.equal(first.status, 'updated');
    assert.equal(first.path, OFFLINE_RESULT_PATH);
    assert.deepEqual(first.written, [OFFLINE_RESULT_PATH]);
    assert.equal(first.backups.length, 1);
    assert.equal(path.isAbsolute(first.backups[0].backup), false, 'backups stay inside the evaluated pack');

    // With the staged reference aligned to the regenerated run the CLI reports a
    // current pack, which is what `pnpm eval:replay --write` asserts in CI.
    const reference = await readJson(referencePath);
    reference.fingerprint = (await readJson(artifactPath)).fingerprint;
    await writeFile(referencePath, `${JSON.stringify(reference, null, 2)}\n`, 'utf8');

    const current = JSON.parse((await runEvalReplayCli(scriptPath, ['--write', '--json'], packRoot)).stdout);
    assert.equal(current.ok, true);
    assert.equal(current.reference, 'matched');
    assert.equal(current.status, 'current');
    assert.equal(current.path, OFFLINE_RESULT_PATH);
    assert.deepEqual(current.written, []);

    // The point of the staged pack: nothing above may touch the checked-in pair.
    assert.deepEqual(await Promise.all(tracked.map(sourceHash)), before);

    const bogus = await runEvalReplayCli(scriptPath, ['--bogus'], packRoot);
    assert.equal(bogus.code, 1);
    assert.match(bogus.stderr, /unknown argument/u);
    assert.deepEqual(await Promise.all(tracked.map(sourceHash)), before);
  } finally {
    await rm(packRoot, { force: true, recursive: true });
  }
});

test('offline replay evaluates forbidden secret text before sanitizing persisted output', async () => {
  const assets = await loadEvalAssets(rootDir);
  const suite = structuredClone(assets.suite);
  suite.cases = [suite.cases[0]];
  suite.cases[0].input.replay.output = 'preview ready secret=should-not-persist';
  suite.cases[0].oracle.forbiddenOutputFragments = [{
    critical: true,
    dimension: 'safety',
    value: 'secret=',
  }];

  const run = await buildOfflineRun(suite);
  assert.equal(run.status, 'failed');
  assert.equal(run.cases[0].criticalFailures, 1);
  assert.doesNotMatch(JSON.stringify(run), /should-not-persist/u);
});

test('package exposes read-only eval check and replay scripts without the retired alias', async () => {
  const packageJson = await readJson(path.join(rootDir, 'package.json'));
  assert.equal(packageJson.scripts['eval:check'], 'node ./scripts/eval-check.js');
  assert.equal(packageJson.scripts['eval:replay'], 'node ./scripts/eval-replay.js');
  assert.equal(Object.hasOwn(packageJson.scripts, 'eval:offline'), false);
});

test('eval scripts validate contracts and reproduce the approved offline reference', async () => {
  const check = await execFileAsync(process.execPath, [path.join(rootDir, 'scripts/eval-check.js')], { cwd: rootDir });
  assert.match(check.stdout, /evaluation contracts passed/u);
  const replay = await execFileAsync(process.execPath, [path.join(rootDir, 'scripts/eval-replay.js')], { cwd: rootDir });
  assert.match(replay.stdout, /deterministic replay passed/u);
  const summary = JSON.parse(replay.stdout.slice(replay.stdout.indexOf('{')));
  assert.deepEqual(summary, {
    criticalPassRate: 1,
    overallScore: 1,
    status: 'passed',
    suite: 'vibe-harness-core',
  });
});
