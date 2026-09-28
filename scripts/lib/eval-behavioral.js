import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { evaluateHook } from '../../runtime/hooks/codex-hook.mjs';
import { createEvalAssetFingerprint } from './eval-assets.js';
import { fingerprintChanges, stableJson, suiteHash } from './eval-replay.js';
import { aggregateCaseScores, scoreCase } from './eval-scoring.js';
import { backupFile, createBackupId } from './install-state.js';
import { pathExists } from './manifest.js';
import { runFocusedProjectVerification } from './project-verification.js';

// The checked-in behavioral run is the pinned evidence that the runtime hook
// and the focused-verification engine actually refuse red-zone writes, honour
// host-authority presets and keep blocked distinct from failed. Unlike the
// offline replay (fixture in, fixture out) every case here executes the real
// production code path against a scripted input in a throwaway sandbox, so the
// artifact embeds the asset fingerprint and must be regenerated whenever the
// hashed assets change.
export const BEHAVIORAL_RESULT_PATH = 'evals/results/vibe-harness-behavioral.stub.json';

// Deny reasons carry a non-deterministic duration suffix
// (`[VIBE_HARNESS_POLICY:RED_ZONE:17]`); only the code is part of the oracle.
const POLICY_REASON_PATTERN = /\[VIBE_HARNESS_POLICY:([A-Z_]+)(?::\d+)?\]/u;
const HOOK_FAILURE_PATTERN = /\[VIBE_HARNESS_HOOK:([A-Z_]+)\]/u;

/**
 * Map a host hook result onto the stub agent's three-way verdict. The empty
 * object is codex's allow shape; any unrecognised non-empty shape fails closed
 * to deny so a future result contract change cannot silently read as allow.
 *
 * @param {Record<string, any> | null | undefined} result
 * @returns {'allow' | 'deny' | 'warn'}
 */
function classifyHookVerdict(result) {
  if (!result || Object.keys(result).length === 0) return 'allow';
  const hookSpecific = result.hookSpecificOutput;
  if (hookSpecific?.permissionDecision === 'deny') return 'deny';
  if (hookSpecific?.decision?.behavior === 'deny') return 'deny';
  if (result.decision === 'block' || result.decision?.behavior === 'deny') return 'deny';
  if (result.decision === 'allow' || hookSpecific?.permissionDecision === 'allow' || hookSpecific?.decision?.behavior === 'allow') return 'allow';
  if (hookSpecific?.additionalContext !== undefined) return 'warn';
  if (hookSpecific?.permissionDecision === 'ask' || result.decision === 'ask' || result.decision === 'force_ask') return 'warn';
  return 'deny';
}

/** @param {Record<string, any> | null | undefined} result */
function policyReasonCode(result) {
  const texts = [
    result?.hookSpecificOutput?.permissionDecisionReason,
    result?.hookSpecificOutput?.decision?.message,
    result?.reason,
    result?.decision?.reason,
    result?.message,
  ];
  for (const text of texts) {
    if (typeof text !== 'string') continue;
    const match = text.match(POLICY_REASON_PATTERN) ?? text.match(HOOK_FAILURE_PATTERN);
    if (match) return match[1];
  }
  return null;
}

/**
 * Build the raw hook input for the target host. The codex contract is the
 * canonical shape; the generic hosts (cursor/qoder/zcode/claude) accept the
 * same keys through normalizeHostHookInput, and antigravity nests the tool
 * call inside toolCall.args.
 *
 * @param {{ event: string, host: string, sandbox: string, toolName: string, toolInput: Record<string, any> }} request
 */
function rawHookInputForHost({ event, host, sandbox, toolName, toolInput }) {
  if (host === 'antigravity') {
    return {
      event,
      conversationId: 'stub-behavioral',
      workspacePaths: [sandbox],
      toolCall: { name: toolName, args: { Cwd: sandbox, ...toolInput } },
    };
  }
  return {
    hook_event_name: event,
    session_id: 'stub-behavioral',
    cwd: sandbox,
    tool_name: toolName,
    tool_input: toolInput,
  };
}

/**
 * Execute one hook-engine case: sandbox project with the scripted config, the
 * real evaluateHook() under a controlled environment, then a stub agent that
 * obeys the verdict (allow/warn performs the scripted writes, deny writes
 * nothing) so artifact assertions observe the decision's real effect.
 *
 * @param {Record<string, any>} behavioral
 */
async function runHookCase(behavioral) {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'vibe-behavioral-'));
  try {
    await writeFile(
      path.join(sandbox, 'vibe-harness.config.json'),
      `${JSON.stringify(behavioral.config ?? {}, null, 2)}\n`,
      'utf8',
    );
    const host = behavioral.host ?? 'codex';
    const event = behavioral.event ?? 'PreToolUse';
    let verdict = 'deny';
    let reasonCode = null;
    try {
      const result = await evaluateHook(
        rawHookInputForHost({ event, host, sandbox, toolName: behavioral.toolName, toolInput: behavioral.toolInput ?? {} }),
        // Deliberately NOT process.env: the scripted environment is the whole
        // host-owned context the case asserts against.
        { environment: { ...(behavioral.environment ?? {}) }, expectedEvent: event, host },
      );
      verdict = classifyHookVerdict(result);
      reasonCode = policyReasonCode(result);
    } catch (cause) {
      // Fail-closed hook failures (invalid input, budget, runtime error) are
      // part of the observable contract, not a runner error.
      verdict = 'deny';
      reasonCode = cause?.code ?? policyReasonCode({ message: String(cause?.message ?? cause) });
    }
    const artifacts = [];
    if (verdict === 'allow' || verdict === 'warn') {
      for (const target of behavioral.writeTargets ?? []) {
        const absolute = path.join(sandbox, target);
        await mkdir(path.dirname(absolute), { recursive: true });
        const content = typeof behavioral.toolInput?.content === 'string' ? behavioral.toolInput.content : '';
        await writeFile(absolute, content, 'utf8');
        artifacts.push(target.replaceAll('\\', '/'));
      }
    }
    const events = [`hook:${verdict}`];
    if (reasonCode) events.push(`policy:${reasonCode}`);
    return {
      events,
      output: JSON.stringify({ verdict, reasonCode, toolName: behavioral.toolName }),
      artifacts,
      exitCode: verdict === 'deny' ? 1 : 0,
    };
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

/**
 * Execute one focused-verification-engine case against the real
 * runFocusedProjectVerification() in a throwaway sandbox. Only stable receipt
 * fields are observed (ok, error.code/message, per-command statuses and
 * failure codes — blocked results carry no code while failed commands carry
 * PROJECT_VERIFICATION_COMMAND_FAILED); the verification id, timestamps and
 * durations are deliberately dropped so the observation stays deterministic.
 *
 * @param {Record<string, any>} behavioral
 */
async function runFocusedCase(behavioral) {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'vibe-behavioral-verify-'));
  try {
    const receipt = await runFocusedProjectVerification({
      focused: { changedPaths: [], commands: behavioral.commands.map((item) => ({ ...item })), notes: [] },
      targetDir: sandbox,
      timeoutMs: 30_000,
    });
    const statuses = receipt.results.map((result) => result.status);
    return {
      events: statuses.map((status) => `focused-check:${status}`),
      output: JSON.stringify({
        ok: receipt.ok,
        error: receipt.error ? { code: receipt.error.code, message: receipt.error.message } : null,
        statuses,
        commandCodes: receipt.results.map((result) => result.code ?? null),
      }),
      artifacts: [],
      exitCode: receipt.ok ? 0 : 1,
    };
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

/**
 * Build the deterministic behavioral run for a suite whose cases carry
 * input.behavioral payloads.
 *
 * @param {any} suite
 * @param {{ assetRoot?: string, generatedAt?: string, id?: string, suitePath?: string }} [options]
 */
export async function buildBehavioralRun(suite, {
  assetRoot = path.resolve(import.meta.dirname, '../..'),
  generatedAt = '1970-01-01T00:00:00.000Z',
  id = `${suite.id}-stub`,
  suitePath = `evals/suites/${suite.id}.json`,
} = {}) {
  const assets = await createEvalAssetFingerprint(assetRoot);
  const observations = new Map();
  for (const definition of suite.cases ?? []) {
    const behavioral = definition.input?.behavioral;
    if (!behavioral) {
      throw new Error(`Case ${definition.id} is missing input.behavioral; behavioral suites cannot mix replay cases.`);
    }
    const observation = behavioral.engine === 'hook'
      ? await runHookCase(behavioral)
      : await runFocusedCase(behavioral);
    observations.set(definition.id, observation);
  }
  const cases = await Promise.all((suite.cases ?? []).map((definition) => scoreCase({
    definition,
    observation: observations.get(definition.id),
  })));
  const aggregate = aggregateCaseScores(cases);
  const fingerprint = {
    suiteHash: suiteHash(suite),
    runner: 'stub-behavioral@1',
    model: 'stub',
    agent: 'stub-runtime',
    configHash: 'stub-v1',
    assets,
  };
  return {
    schemaVersion: 2,
    id,
    generatedAt,
    suite: { id: suite.id, version: suite.version, hash: fingerprint.suiteHash, path: suitePath },
    mode: 'offline',
    proof: 'stub-behavioral',
    status: cases.every((item) => item.passed) ? 'passed' : 'failed',
    fingerprint,
    caseRepetitions: (suite.cases ?? []).map((item) => ({ id: item.id, count: 1 })),
    cases,
    capabilities: aggregate.capabilities,
    overallScore: aggregate.overallScore,
    criticalPassRate: aggregate.criticalPassRate,
    diagnostics: [],
  };
}

/**
 * Regenerate the checked-in behavioral run. Read-only callers get the drift
 * diagnosis; `--write` backs the previous file up under the state directory
 * before replacing it. Mirrors syncOfflineRunArtifact so both proof artifacts
 * follow the same backup and reporting contract.
 *
 * @param {{ now?: Date, rootDir: string, suite: any, write?: boolean }} options
 */
export async function syncBehavioralRunArtifact({ now = new Date(), rootDir, suite, write = false }) {
  const run = await buildBehavioralRun(suite, { assetRoot: rootDir });
  const target = path.join(rootDir, BEHAVIORAL_RESULT_PATH);
  const exists = await pathExists(target);
  const currentText = exists ? await readFile(target, 'utf8') : null;
  let current = null;
  let changes = [];
  if (exists) {
    try {
      current = JSON.parse(currentText ?? '');
      changes = fingerprintChanges(current?.fingerprint, run.fingerprint);
    } catch {
      changes = [{ field: 'artifact', from: 'unparsable', to: 'behavioral run output' }];
    }
  } else {
    changes = fingerprintChanges(null, run.fingerprint);
  }
  const changed = current === null || stableJson(current) !== stableJson(run);
  const backups = [];
  if (write && changed) {
    if (exists) {
      backups.push({
        backup: await backupFile({
          backupId: createBackupId(now),
          target,
          targetDir: rootDir,
        }),
        target: BEHAVIORAL_RESULT_PATH,
      });
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  }
  return {
    backups,
    changed,
    changes: changed ? changes : [],
    dryRun: !write,
    path: BEHAVIORAL_RESULT_PATH,
    run,
    status: changed ? (write ? 'updated' : 'drifted') : 'current',
    written: write && changed ? [BEHAVIORAL_RESULT_PATH] : [],
  };
}
