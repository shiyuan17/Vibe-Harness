import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';

import { pathExists } from './manifest.js';
import { readHostHookState } from './host-hook-state.js';
import { hashFile } from './install-state.js';
import { hookBootstrapCommand } from './template-renderer.js';
import { evaluateHook, HOOK_FAILURE_CODES } from '../../runtime/hooks/codex-hook.mjs';

const execFileAsync = promisify(execFile);
const hookConfigTargets = {
  codex: '.codex/hooks.json',
};
// The managed hook entrypoint doubles as the hooks-group sentinel: preview and
// multi-target installs land it on disk even for hosts that can never load it.
const runtimeHookEntryPath = '.agents/runtime/hooks/codex-hook.mjs';

/**
 * User-facing text for each host Hook trust state. The reasonCode stays the
 * machine contract; the sentence only has to be actionable.
 */
const MANUAL_TRUST_VERIFICATION = {
  'trusted-disabled': '本项目 Hook 已在宿主侧停用（hooks.state enabled=false），安全策略当前不生效；请在 Codex 中用 /hooks 或宿主配置重新启用后再复跑 doctor 或 validate。',
  'trusted-enabled': '本项目 Hook 已被宿主信任，但仍没有证据表明宿主已加载它；请保留本次结论为 configured-unverified。',
  'untrusted': '宿主没有本项目的 Hook 信任记录，安全策略当前不生效；请在 Codex 中运行 /hooks 信任当前项目的 Hook 定义。',
  'unknown': '无法读取宿主 Hook 信任状态；请在 Codex 中运行 /hooks 复核当前项目的 Hook 定义。',
};

export const HOOK_COVERAGE_LIMITATIONS = [
  'Command-string inspection is heuristic and does not cover arbitrary PowerShell, Python, Node.js, package-manager, or Git network behavior.',
  'Project files cannot prove that the host loaded or trusted the installed Hook configuration.',
  'Host sandbox, approval policy, process isolation, and network proxy enforcement require independent host-level verification.',
];

/**
 * Declared host support for starting a sub-Agent whose context does not inherit
 * the parent session: `isolated` (a fresh context is available), `inherited`
 * (sub-Agents only continue the parent session), `unavailable` (the host offers
 * no sub-Agent context at all). The evidence field records how far the
 * declaration was verified on a real host, reusing the manifest's evidence
 * vocabulary.
 */
export const FRESH_CONTEXT_MODES = ['isolated', 'inherited', 'unavailable'];
export const FRESH_CONTEXT_EVIDENCE = ['verified', 'configured-unverified', 'preview'];

/**
 * User-facing text for each fresh-context conclusion. The reason codes stay the
 * machine contract; the sentence has to name the next useful action.
 */
const FRESH_CONTEXT_VERIFICATION = {
  'FRESH_CONTEXT_CONTRADICTS_SUBAGENTS': '宿主声明 subagents 不支持，却声明了可用的 fresh-context 模式（或相反）；请对照宿主契约修正 manifests/adapters.json 后重新核对。',
  'FRESH_CONTEXT_INHERITED_ONLY': '该宿主的子 Agent 只能继承父会话上下文，无法提供不继承的独立复审上下文；本轮不能用它承担独立复审（独立复审要求宿主真实支持 fresh context，仅新建 contextId 不构成独立性证明）。',
  'FRESH_CONTEXT_UNDECLARED': '该宿主没有声明 fresh-context 能力；按 fail-closed 记为 unavailable，直到补上声明并在真实宿主上核对。',
  'FRESH_CONTEXT_UNAVAILABLE': '该宿主声明没有子 Agent 上下文能力；它不能提供独立复审上下文，相关完成主张只能依赖宿主原生审批与人工复核。',
  'FRESH_CONTEXT_UNVERIFIED': '该宿主声明可提供不继承的独立上下文，但证据状态不是 verified；`contextIndependence=verified` 只能在真实宿主证据就位后成立。',
};

/**
 * Read one adapter's declared fresh-context capability. An absent or invalid
 * declaration never falls back to "isolated": independent review needs a
 * host-supported non-inheriting context, so the diagnostic stays fail-closed.
 *
 * @param {any} adapter
 */
export function inspectFreshContext(adapter) {
  const declared = adapter?.freshContext ?? {};
  const declaredMode = FRESH_CONTEXT_MODES.includes(declared.mode) ? declared.mode : null;
  const evidence = FRESH_CONTEXT_EVIDENCE.includes(declared.evidence) ? declared.evidence : 'configured-unverified';
  const mode = declaredMode ?? 'unavailable';
  const subagents = adapter?.capabilities?.subagents;
  const codes = [];
  if (declaredMode === null) {
    codes.push('FRESH_CONTEXT_UNDECLARED');
  } else if ((subagents === 'unsupported') !== (mode === 'unavailable')) {
    codes.push('FRESH_CONTEXT_CONTRADICTS_SUBAGENTS');
  } else if (mode === 'inherited') {
    codes.push('FRESH_CONTEXT_INHERITED_ONLY');
  } else if (mode === 'unavailable') {
    codes.push('FRESH_CONTEXT_UNAVAILABLE');
  } else if (evidence !== 'verified') {
    codes.push('FRESH_CONTEXT_UNVERIFIED');
  }
  return {
    evidence,
    host: typeof adapter?.id === 'string' ? adapter.id : null,
    // Only a verified, non-inheriting context can carry an independent review;
    // a second reviewer identity inside one context never qualifies.
    independentReviewSupported: mode === 'isolated' && evidence === 'verified',
    messages: codes.map((code) => ({ code, message: FRESH_CONTEXT_VERIFICATION[code] })),
    mode,
  };
}

export function hookConfigTarget(adapter) {
  return adapter.projectConfig?.hooks?.target || hookConfigTargets[adapter.id] || null;
}

/** Absolute path of the adapter's installed Hook definition, if it has one. */
export function hookDefinitionPath(adapter, targetDir) {
  const relativeTarget = hookConfigTarget(adapter);
  return relativeTarget ? path.join(targetDir, relativeTarget) : null;
}

/**
 * True when the installed Hook definition no longer matches the hash the
 * installer recorded for it. The host keys its own trust record on the
 * definition text, so a definition that changed after the recorded install
 * (edited by hand, or rendered by a newer pack) may require re-trusting before
 * the safety policy applies again.
 *
 * The host's own hash algorithm is not reproducible from the project, so this
 * stays a "may require re-trust" signal: it never claims causality, and it is
 * silent when there is no install record or no installed definition to compare.
 *
 * @param {any} adapter
 * @param {string} targetDir
 * @param {any} installState
 * @returns {Promise<boolean>}
 */
export async function hookDefinitionDrift(adapter, targetDir, installState) {
  const relativeTarget = hookConfigTarget(adapter);
  if (!relativeTarget || !Array.isArray(installState?.files)) return false;
  const record = installState.files.find((file) => file.target === relativeTarget);
  if (!record?.targetHash) return false;
  const installed = path.join(targetDir, relativeTarget);
  if (!await pathExists(installed)) return false;
  return await hashFile(installed) !== record.targetHash;
}

function selfCheckPayload(adapterId, targetDir) {
  const outsidePath = path.resolve(targetDir, '..', '.vibe-harness-hook-self-check');
  if (adapterId === 'antigravity') {
    return {
      toolCall: { name: 'write_file', args: { path: outsidePath } },
      workspacePaths: [targetDir],
    };
  }
  return {
    cwd: targetDir,
    hook_event_name: 'PreToolUse',
    session_id: 'hook-self-check',
    tool_input: { file_path: outsidePath },
    tool_name: 'Write',
  };
}

function selfCheckDenied(adapterId, result) {
  if (adapterId === 'cursor') return result?.continue === false;
  if (adapterId === 'antigravity') return result?.decision === 'deny';
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

/** @param {any} adapter @param {string} targetDir @param {{configured?: boolean}} options */
export async function inspectRuntimeHookSelfCheck(adapter, targetDir, { configured } = {}) {
  if (adapter.hookActivation === 'unsupported') {
    return { status: 'unsupported', code: 'HOOK_SELF_CHECK_UNSUPPORTED' };
  }
  if (!configured) return { status: 'not-installed', code: 'HOOK_SELF_CHECK_NOT_INSTALLED' };
  const wiring = await inspectInstalledHookWiring(adapter, targetDir);
  if (wiring.status !== 'pass') return wiring;
  try {
    const result = await evaluateHook(selfCheckPayload(adapter.id, targetDir), {
      expectedEvent: 'PreToolUse',
      host: adapter.id,
    });
    return selfCheckDenied(adapter.id, result)
      ? { status: 'pass', code: 'HOOK_SELF_CHECK_PASSED' }
      : { status: 'degraded', code: 'HOOK_SELF_CHECK_NOT_DENIED' };
  } catch (error) {
    const stableCodes = new Set(Object.values(HOOK_FAILURE_CODES));
    return { status: 'degraded', code: stableCodes.has(error?.code) ? error.code : 'HOOK_SELF_CHECK_FAILED' };
  }
}

/**
 * The installed Hook surface this self-check is allowed to speak about.
 *
 * The synthetic request below runs the pack's own evaluator, so it proves
 * something about the target only while the installed handler *is* that
 * evaluator and the target's configuration points at it. An empty or miswired
 * `hooks.json`, or a stale/tampered `.agents` handler, would otherwise still
 * report `pass` and be read as enforcement evidence.
 */
async function inspectInstalledHookWiring(adapter, targetDir) {
  const configTarget = hookConfigTarget(adapter);
  const entryDir = path.posix.dirname(runtimeHookEntryPath);
  const installedHooksDir = path.join(targetDir, ...entryDir.split('/'));
  const packHooksDir = path.join(path.resolve(import.meta.dirname, '..', '..'), 'runtime', 'hooks');
  // The handler is not a single module: `codex-hook.mjs` statically imports the
  // policy, context and envelope modules beside it, so a self-check that hashes
  // only the entry would pass while a tampered or missing dependency changes
  // behavior. The whole installed Hook directory is compared to the pack.
  const modules = await listFiles(packHooksDir).catch(() => null);
  if (modules === null || modules.length === 0) {
    return { status: 'degraded', code: 'HOOK_SELF_CHECK_HANDLER_UNVERIFIED' };
  }
  // Which verdict a partially installed surface gets is decided by the order
  // the pack is walked in: an installed handler whose entry module does not
  // match the pack is drift, while one that only lacks a module beside the
  // entry is missing. The entry is therefore compared first, and the modules
  // around it follow in sorted order, so the same install reports the same
  // code on every volume.
  const entryModule = path.posix.basename(runtimeHookEntryPath);
  const ordered = modules.includes(entryModule)
    ? [entryModule, ...modules.filter((relative) => relative !== entryModule)]
    : modules;
  for (const relative of ordered) {
    const installed = path.join(installedHooksDir, relative);
    if (!(await pathExists(installed))) {
      return { status: 'degraded', code: 'HOOK_SELF_CHECK_HANDLER_MISSING' };
    }
    const [installedHash, packHash] = await Promise.all([
      hashFile(installed).catch(() => null),
      hashFile(path.join(packHooksDir, relative)).catch(() => null),
    ]);
    if (installedHash === null || packHash === null) {
      return { status: 'degraded', code: 'HOOK_SELF_CHECK_HANDLER_UNVERIFIED' };
    }
    if (installedHash !== packHash) {
      return { status: 'degraded', code: 'HOOK_SELF_CHECK_HANDLER_DRIFT' };
    }
  }
  if (configTarget) {
    const raw = await readFile(path.join(targetDir, configTarget), 'utf8').catch(() => null);
    // Parsing is the point: raw substring membership would accept unrelated
    // prose, invalid JSON, or a command that merely echoes the path.
    let config;
    try {
      config = raw === null ? null : JSON.parse(raw);
    } catch {
      return { status: 'degraded', code: 'HOOK_SELF_CHECK_CONFIG_UNWIRED' };
    }
    const wiring = await inspectManagedHookWiring(adapter, config, targetDir);
    if (wiring.status !== 'pass') return wiring;
  }
  return { status: 'pass', code: 'HOOK_SELF_CHECK_WIRING_VERIFIED' };
}

/**
 * The guarded-event surface the installed Hook definition has to reproduce.
 *
 * Both halves are read from the pack's own adapter template, so the comparison
 * is structural rather than textual: for every event the template guards, the
 * installed definition has to carry an entry — at the adapter's declared
 * configuration path, with exactly the template's matcher (including its
 * absence, which is how these templates state "every tool") — whose command is
 * a *parsed* invocation of the managed handler naming the same canonical event,
 * with the template's host and timeout. A definition that keeps the managed
 * command under an irrelevant event, narrows the matcher, drops the host, or
 * only mentions the handler path in prose, therefore cannot pass while the
 * guarded event runs something else.
 */
async function inspectManagedHookWiring(adapter, config, targetDir) {
  const templatePath = path.join(path.resolve(import.meta.dirname, '..', '..'), 'adapters', adapter.id, 'hooks.template.json');
  const rawTemplate = await readFile(templatePath, 'utf8').catch(() => null);
  let template;
  try {
    template = rawTemplate === null ? null : JSON.parse(rawTemplate);
  } catch {
    template = undefined;
  }
  if (template === undefined || template === null || typeof template !== 'object' || Array.isArray(template)) {
    return { status: 'degraded', code: 'HOOK_SELF_CHECK_WIRING_UNVERIFIED' };
  }
  const wrapperInvalid = template.hooks !== undefined && (template.hooks === null || typeof template.hooks !== 'object' || Array.isArray(template.hooks));
  const events = wrapperInvalid ? [] : Object.entries(template.hooks ?? template);
  if (events.length === 0) {
    return { status: 'degraded', code: 'HOOK_SELF_CHECK_WIRING_UNVERIFIED' };
  }
  const installed = hookEventMap(adapter, config, template);
  if (installed === null) return { status: 'degraded', code: 'HOOK_SELF_CHECK_CONFIG_UNWIRED' };
  for (const [event, groups] of events) {
    if (!Array.isArray(groups)) return { status: 'degraded', code: 'HOOK_SELF_CHECK_WIRING_UNVERIFIED' };
    // The host's configuration key is not necessarily the evaluator's event
    // name (Cursor registers `preToolUse`), so both sides are compared after
    // canonicalization. An alias the evaluator cannot canonicalize is not a
    // guarded event this check can speak about.
    const guardedEvent = canonicalHookEvent(event);
    if (guardedEvent === null) return { status: 'degraded', code: 'HOOK_SELF_CHECK_WIRING_UNVERIFIED', event };
    const installedGroups = Array.isArray(installed[event]) ? installed[event] : [];
    for (const group of groups) {
      const expectedHooks = Array.isArray(group?.hooks) ? group.hooks : [];
      if (expectedHooks.length === 0) return { status: 'degraded', code: 'HOOK_SELF_CHECK_WIRING_UNVERIFIED', event };
      const matched = installedGroups.some((candidate) => candidate !== null && typeof candidate === 'object'
        // The matcher is part of the guarded surface: a template group that
        // states no matcher guards every tool, so an installed group that adds
        // one silently narrows the policy, and vice versa.
        && candidate.matcher === group?.matcher
        && Array.isArray(candidate.hooks)
        && expectedHooks.every((hook) => candidate.hooks.some((installedHook) =>
          managedHookMatches(installedHook, hook, adapter, guardedEvent, targetDir))));
      if (!matched) return { status: 'degraded', code: 'HOOK_SELF_CHECK_CONFIG_UNWIRED', event };
    }
  }
  return { status: 'pass', code: 'HOOK_SELF_CHECK_WIRING_VERIFIED' };
}

/**
 * Whether one installed Hook entry reproduces one template entry.
 *
 * `type` and `timeout` are execution-critical: the host runs the entry through
 * its own schema, and a handler the host kills before it decides leaves the
 * tool call unguarded. The command is compared as a parsed invocation of the
 * managed entry for the event this group is registered under.
 */
function managedHookMatches(installedHook, hook, adapter, guardedEvent, targetDir) {
  if (installedHook === null || typeof installedHook !== 'object' || Array.isArray(installedHook)) return false;
  if (installedHook.type !== hook?.type) return false;
  if (hook?.timeout !== undefined && installedHook.timeout !== hook.timeout) return false;
  const requireHost = templateDeclaresHost(hook);
  return managedCommandEvent(installedHook.command, adapter, { targetDir, requireHost }) === guardedEvent;
}

/**
 * Whether the template entry's own command names a host.
 *
 * The templates that declare `--host` make it part of the managed invocation;
 * Codex's template declares none, and the runtime then defaults to Codex.
 */
function templateDeclaresHost(hook) {
  const templateCommand = String(hook?.command ?? '');
  const placeholder = '{{hookBootstrapCommand}}';
  const index = templateCommand.indexOf(placeholder);
  const options = index === -1 ? templateCommand : templateCommand.slice(index + placeholder.length);
  return commandOption(options, '--host') !== null;
}

/**
 * The event map inside an installed definition.
 *
 * The managed block is written at the adapter's declared configuration path,
 * and a template that carries its own single `hooks` wrapper (`codex`, which
 * declares no `projectConfig` at all and therefore installs the template
 * verbatim) adds one further level. Both levels are derived from the template,
 * so a definition that keeps the managed command one level off the guarded
 * events cannot be read as wired.
 */
function hookEventMap(adapter, config, template) {
  const declared = adapter?.projectConfig?.hooks?.path;
  const wrapper = template.hooks !== undefined && Object.keys(template).length === 1 ? ['hooks'] : [];
  const segments = [...(Array.isArray(declared) ? declared : []), ...wrapper];
  let current = config;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return null;
    current = current[segment];
  }
  return current !== null && typeof current === 'object' && !Array.isArray(current) ? current : null;
}

// The installer single-sources an inline bootstrap as `node -e "<payload>" --`,
// but the placeholder is substituted into the JSON template as raw text, so the
// constant carries JSON-escaped quotes while the *parsed* command carries real
// ones. Comparing the parsed command against the escaped constant would never
// match, so the prefix is unescaped once here.
const hookBootstrapPrefix = hookBootstrapCommand.replaceAll('\\"', '"');

// The evaluator canonicalizes host event aliases before comparing them with the
// configured event, so the configuration-key half of the comparison speaks the
// alias vocabulary while the declared `--expected-event` has to be the canonical
// name that comparison uses.
const canonicalHookEvents = new Map([
  ['pretooluse', 'PreToolUse'],
  ['permissionrequest', 'PermissionRequest'],
]);

/** The evaluator's canonical guarded-event name for a host alias or key, or null. */
function canonicalHookEvent(value) {
  if (typeof value !== 'string') return null;
  return canonicalHookEvents.get(value.replaceAll(/[_-]/gu, '').toLowerCase()) ?? null;
}

/**
 * The canonical name itself, or null.
 *
 * `--expected-event` reaches the evaluator verbatim, where it is compared with
 * the *canonicalized* payload event: a value that merely canonicalizes to the
 * right name (Cursor's `preToolUse`) is a mismatch at runtime, which denies only
 * for events the evaluator does not guard and otherwise leaves the tool call
 * unguarded.
 */
function exactHookEvent(value) {
  if (typeof value !== 'string') return null;
  const canonical = canonicalHookEvents.get(value.replaceAll(/[_-]/gu, '').toLowerCase()) ?? null;
  return canonical === value ? value : null;
}

/**
 * The `--expected-event` of a parsed managed invocation, or null.
 *
 * Two shapes are legitimate: the inline bootstrap the installer single-sources
 * (matched as the exact prefix, never as a substring) and a host that names the
 * managed entry directly. The direct form is tokenized, so `echo .agents runtime
 * hooks codex-hook.mjs` has the wrong program and is not an invocation.
 *
 * @param {any} command
 * @param {any} adapter
 * @param {{targetDir?: string, requireHost?: boolean}} [options]
 * @returns {string|null}
 */
function managedCommandEvent(command, adapter, { targetDir, requireHost = false } = {}) {
  if (typeof command !== 'string' || command.trim() === '') return null;
  const trimmed = command.trim();
  const resolvedTarget = path.resolve(targetDir ?? process.cwd());
  const samePath = (value) => (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));
  // The inline bootstrap is matched as an exact prefix, never as a substring.
  if (trimmed.startsWith(hookBootstrapPrefix)) {
    const remainder = trimmed.slice(hookBootstrapPrefix.length);
    // The prefix ends in `--`, so a directly concatenated `--expected-event`
    // parses here as a valid option while the shell hands Node a longer token it
    // never accepts. The prefix only counts as a whole token when whitespace
    // separates it from the rest of the command line.
    if (!/^\s/u.test(remainder)) return null;
    // The bootstrap does not run a handler *under* the target: it walks upward
    // to the first directory holding a `.git` entry and runs *that* root's
    // handler. The hashes above therefore only describe what the host executes
    // when the target is itself that root; a project nested inside an outer
    // repository would otherwise be reported as guarded while the outer
    // handler — which this check never looked at — is what decides. A target
    // with no repository at all is left to the bootstrap, which denies every
    // tool call rather than resolving someone else's handler.
    const root = effectiveGitRoot(resolvedTarget);
    if (root !== null && samePath(root) !== samePath(resolvedTarget)) return null;
    return managedInvocationEvent(remainder, adapter, { requireHost });
  }
  const tokens = tokenizeCommand(trimmed);
  if (tokens.length < 3) return null;
  if (!/^node(?:\.exe)?$/iu.test(tokens[0] ?? '')) return null;
  // The entry has to *be* the managed handler inside this target: a suffix match
  // would also accept `/tmp/.agents/runtime/hooks/codex-hook.mjs`, which the host
  // would execute instead of the hashed installed surface.
  const entry = tokens[1] ?? '';
  if (entry === '' || entry.startsWith('-')) return null;
  const managedEntry = path.join(resolvedTarget, ...runtimeHookEntryPath.split('/'));
  if (samePath(path.resolve(resolvedTarget, entry)) !== samePath(managedEntry)) return null;
  return managedInvocationEvent(tokens.slice(2), adapter, { requireHost });
}

/**
 * The repository root the inline bootstrap resolves for one directory, or null.
 *
 * This mirrors the bootstrap's own resolution (`scripts/lib/hook-bootstrap.cjs`)
 * rather than `git rev-parse`: the bootstrap looks for a `.git` entry while
 * walking upward, so a worktree's `.git` file and a submodule's `.git` file both
 * count, exactly as they do there.
 *
 * @param {string} startDir
 * @returns {string|null}
 */
function effectiveGitRoot(startDir) {
  let current = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Splits a command line into tokens, honouring simple quoting. */
function tokenizeCommand(command) {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/gu)].map((match) => match[1] ?? match[2] ?? match[3]);
}

/**
 * The guarded event a managed invocation declares, or null when it is malformed.
 *
 * Only the exact `--host <adapter>` / `--expected-event <event>` option pairs are
 * accepted, so a trailing shell operator or redirection is not an invocation the
 * host would run as the managed handler. A host that omits `--host` is accepted
 * only where the template omits it (an explicit, matching host is equivalent),
 * because omitting it changes input normalization and denial shape elsewhere.
 *
 * @param {string[]|string} args
 * @param {any} adapter
 * @param {{requireHost?: boolean}} [options]
 * @returns {string|null}
 */
function managedInvocationEvent(args, adapter, { requireHost = false } = {}) {
  const tokens = Array.isArray(args) ? args : tokenizeCommand(args);
  let event = null;
  let host = null;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token !== '--expected-event' && token !== '--host') return null;
    const value = tokens[index + 1];
    if (value === undefined) return null;
    index += 1;
    if (token === '--host') {
      if (host !== null) return null;
      host = value;
      continue;
    }
    if (event !== null) return null;
    event = exactHookEvent(value);
    if (event === null) return null;
  }
  if (event === null) return null;
  if (requireHost) return host === adapter?.id ? event : null;
  return host === null || host === adapter?.id ? event : null;
}

/** The value of one `--name <value>` option, or null when absent or malformed. */
function commandOption(text, name) {
  const match = new RegExp(`(?:^|\\s)${name}\\s+(?:"([^"]*)"|'([^']*)'|(\\S+))`, 'u').exec(text);
  if (match === null) return null;
  const value = match[1] ?? match[2] ?? match[3];
  return value === undefined || value === '' || value.startsWith('--') ? null : value;
}

async function listFiles(root, prefix = '') {
  // `readdir` order is filesystem-dependent: NTFS hands names back in uppercase
  // collation while ext4 hands back hash order. A self-check that walked the
  // pack in that order would report `missing` for one volume and `drift` for
  // another on the same installed surface, so the walk is sorted instead.
  const entries = (await readdir(path.join(root, prefix), { withFileTypes: true }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const files = [];
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await listFiles(root, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

/**
 * @param {any} adapter
 * @param {string} targetDir
 * @param {{hostEvidence?: Record<string, any>, hostHookState?: Record<string, any> | null, selfCheck?: boolean}} options
 */
export async function inspectRuntimeHooks(adapter, targetDir, { hostEvidence = {}, hostHookState = null, selfCheck = true } = {}) {
  const configTarget = hookConfigTarget(adapter);
  const configured = Boolean(configTarget && await pathExists(path.join(targetDir, configTarget)));
  const filesInstalled = await pathExists(path.join(targetDir, runtimeHookEntryPath));
  const mechanism = adapter.hookActivation;
  const supported = mechanism !== 'unsupported';
  // Host trust is recorded outside the project, so it can only be read, never
  // inferred from project files (see readHostHookState for the field contract).
  const trustState = mechanism === 'manual-trust'
    ? (hostHookState ?? await readHostHookState({ adapterId: adapter.id, projectDir: targetDir }))
    : null;
  let status = 'unknown';
  let verification = configTarget
    ? 'Confirm that the host loaded ' + configTarget + ' for this project.'
    : 'No project Hook configuration is installed.';
  if (mechanism === 'unsupported') {
    status = 'unsupported';
    verification = 'This host does not support Vibe-Harness runtime Hooks.';
  } else if (mechanism === 'manual-trust') {
    status = Object.hasOwn(MANUAL_TRUST_VERIFICATION, trustState?.status) ? trustState.status : 'unknown';
    verification = MANUAL_TRUST_VERIFICATION[status];
  } else if (configured) {
    status = 'configured-unverified';
  }
  const authority = adapter.executionAuthority || {
    envelopeVersions: [],
    goalLifecycle: 'unsupported',
    highRiskEnforcement: 'unsupported',
    projectConfigMayAuthorize: false,
    trustedSource: 'none',
  };
  // A host with no declared execution envelope cannot enforce the runtime Hook
  // policy no matter what is installed, so the report states that explicitly
  // instead of leaving it implicit in executionAuthority.
  const envelopeDegraded = authority.envelopeVersions.length === 0
    || authority.highRiskEnforcement === 'unsupported';
  const activated = supported && hostEvidence.activated === true ? true : (supported ? null : false);
  const hostContextVerified = ['sandbox', 'approval', 'process', 'network']
    .every((field) => hostEvidence[field] === true);
  const envelopeRequired = hostEvidence.envelopeRequired === true;
  const selfCheckResult = selfCheck
    ? await inspectRuntimeHookSelfCheck(adapter, targetDir, { configured })
    : null;
  const enforced = configured
    && activated === true
    && envelopeRequired
    && hostContextVerified
    && authority.highRiskEnforcement === 'host-required'
    && selfCheckResult?.status === 'pass';
  const enforcementReasonCode = !supported
    ? 'HOST_HOOK_UNSUPPORTED'
    : !configured
      ? 'HOOK_NOT_CONFIGURED'
      : activated !== true
        ? 'HOST_HOOK_NOT_ACTIVATED'
        : !envelopeRequired
          ? 'EXECUTION_ENVELOPE_UNPROVEN'
          : !hostContextVerified
            ? 'HOST_CAPABILITIES_UNPROVEN'
            : authority.highRiskEnforcement !== 'host-required'
              ? 'ADAPTER_ENFORCEMENT_NOT_HOST_REQUIRED'
              : selfCheckResult?.status !== 'pass'
                ? (selfCheckResult?.code ?? 'HOOK_SELF_CHECK_UNVERIFIED')
                : 'ENFORCED';
  const diagnosticStatus = enforced
    ? 'enforced'
    : !supported
      ? 'unsupported'
      : !configured
        ? 'not-configured'
        : selfCheckResult?.status === 'degraded'
          ? 'degraded'
          : activated === true
            ? 'verified'
            : 'configured-unverified';
  const checkedAt = new Date().toISOString();
  const hostEvidenceSummary = {
    activated: hostEvidence.activated === true,
    envelopeRequired,
    sandbox: hostEvidence.sandbox === true,
    approval: hostEvidence.approval === true,
    process: hostEvidence.process === true,
    network: hostEvidence.network === true,
  };
  if (activated === true) {
    status = 'verified';
    verification = 'Host evidence confirms the Hook is activated for this project.';
  }
  const report = {
    activated,
    configured,
    coverageLimitations: [...HOOK_COVERAGE_LIMITATIONS],
    declaredEvents: { ...adapter.hookEvents },
    enforced,
    envelopeSupport: {
      degraded: envelopeDegraded,
      highRiskEnforcement: authority.highRiskEnforcement,
      versions: [...authority.envelopeVersions],
    },
    executionAuthority: {
      ...authority,
      envelopeRequired,
      hostContextVerified,
    },
    filesInstalled,
    // The host's declared fresh-context capability travels with the runtime
    // diagnostics entry because an independent review needs a context the host
    // can really start without the implementing session, and the host report is
    // the only place that fact is available to callers.
    freshContext: inspectFreshContext(adapter),
    host: adapter.id,
    pathResolution: 'git-root',
    status: diagnosticStatus,
    supported,
    activation: { mechanism, status, verification },
    hostEvidence: hostEvidenceSummary,
    enforcementReasonCode,
    evidenceSource: enforced
      ? 'host-and-self-check'
      : selfCheckResult ? 'project-config-and-self-check' : configured ? 'project-config' : 'none',
    checkedAt,
    hostHookState: trustState
      ? {
          entries: { ...trustState.entries },
          reason: trustState.reason,
          status: trustState.status,
        }
      : null,
  };
  if (selfCheckResult) report.selfCheck = selfCheckResult;
  return report;
}

/**
 * @param {any} runtimeHooks
 * @param {{definitionChanged?: boolean, enforcementPolicy?: string}} [options]
 * `definitionChanged` carries the caller's own comparison of the Hook
 * definition before and after the current operation (an install that rewrites
 * the definition), because the post-install record already matches the new
 * file. `enforcementPolicy` mirrors the project's hooks.enforcement setting:
 * under "strict" the unproven-enforcement warning is marked blocking and
 * callers downgrade their success status instead of treating it as advisory.
 */
export function runtimeHookWarnings(runtimeHooks, { definitionChanged = false, enforcementPolicy = 'advisory' } = {}) {
  const warnings = [];
  if (runtimeHooks.envelopeSupport?.degraded) {
    warnings.push({
      code: 'ENVELOPE_UNSUPPORTED',
      message: 'This host declares no high-risk execution envelope (envelopeVersions is empty and highRiskEnforcement is unsupported), so runtime red-zone, egress, and credential policies cannot be enforced here; high-risk operations rely on host-native approval and human review only.',
    });
  }
  if (runtimeHooks.supported === false && runtimeHooks.filesInstalled) {
    // The hooks group can be on disk for a host that can never load it (a
    // preview install, or a multi-target project where another host owns the
    // files); name that host instead of letting the files read as an active
    // policy.
    warnings.push({
      code: 'HOOK_ACTIVATION_UNSUPPORTED',
      message: runtimeHooks.host + ' 的 Hook 机制不被支持：Hook 文件仅随安装落盘、不会被该宿主激活；红区与凭据策略依赖宿主原生审批与人工复核。',
    });
  }
  if (definitionChanged
    && runtimeHooks.configured
    && runtimeHooks.activation.status === 'trusted-enabled') {
    warnings.push({
      code: 'HOOK_TRUST_REREVIEW_REQUIRED',
      message: '已安装的 Hook 定义与宿主信任的那份不同（本次安装或手工改写改动了定义文本），宿主可能要求重新信任；请在 Codex 中运行 /hooks 复核并启用当前定义。',
    });
  }
  const disabled = runtimeHooks.configured && runtimeHooks.activation.status === 'trusted-disabled';
  if (disabled) {
    // The host records the Hook as trusted but switched off: that is a sharper
    // statement than "activation unverified", so it replaces it instead of
    // stacking a second warning about the same condition.
    warnings.push({
      code: 'HOOK_DISABLED',
      message: runtimeHooks.activation.verification,
    });
  } else if (runtimeHooks.configured && !['unsupported', 'verified'].includes(runtimeHooks.activation.status)) {
    warnings.push({
      code: 'HOOK_ACTIVATION_UNVERIFIED',
      message: runtimeHooks.activation.verification,
    });
  }
  if (runtimeHooks.configured && !runtimeHooks.enforced) {
    const strict = enforcementPolicy === 'strict';
    warnings.push({
      code: 'HOOK_ENFORCEMENT_UNVERIFIED',
      message: strict
        ? 'hooks.enforcement is "strict" and Hook enforcement is not proven for this project, so this command reports a degraded status; verify the host sandbox, approval policy, process isolation, and network proxy (or re-run with --allow-degraded) before relying on the Hook policy.'
        : 'Hook policy is defense in depth only; verify the host sandbox, approval policy, process isolation, and network proxy before treating it as enforced.',
      ...(strict ? { blocking: true } : {}),
    });
  }
  if (runtimeHooks.selfCheck?.status === 'degraded') {
    warnings.push({
      code: 'HOOK_SELF_CHECK_DEGRADED',
      message: 'The project Hook self-check did not produce the expected fail-closed decision.',
    });
  }
  return warnings;
}

/**
 * First blocking Hook warning, or null when every warning is advisory. Under
 * hooks.enforcement "strict" a blocking warning must downgrade the command's
 * success status even when every other check passed.
 *
 * @param {any[]} [warnings]
 */
export function blockingHookWarning(warnings = []) {
  return warnings.find((warning) => warning?.blocking === true) ?? null;
}

function extractField(content, labels) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const match = content.match(new RegExp('^\\s*-\\s*' + escaped + '\\s*:\\s*(.*?)\\s*$', 'imu'));
    if (match) return match[1].trim();
  }
  return null;
}

function parseDate(value) {
  if (!value || value.includes('YYYY-MM-DD')) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return Number.NaN;
  const parsed = new Date(value + 'T00:00:00.000Z');
  if (Number.isNaN(parsed.getTime())) return Number.NaN;
  return parsed.toISOString().slice(0, 10) === value ? parsed : Number.NaN;
}

function hasMeaningfulFields(content, labels) {
  return labels.some((labelSet) => {
    const value = extractField(content, labelSet);
    return value !== null && value.length > 0;
  });
}

async function headCommitDate(targetDir) {
  try {
    const result = await execFileAsync('git', ['log', '-1', '--format=%cI'], { cwd: targetDir, windowsHide: true });
    const value = result.stdout.trim();
    return value ? new Date(value) : null;
  } catch {
    return null;
  }
}

async function inspectMemoryFile({ contentLabels, dateLabels, installed, maxAgeDays, relativePath, targetDir, headDate }) {
  if (!installed) return { path: relativePath, status: 'not-installed' };
  const absolutePath = path.join(targetDir, relativePath);
  if (!(await pathExists(absolutePath))) return { path: relativePath, status: 'missing' };
  let content;
  try {
    content = await readFile(absolutePath, 'utf8');
  } catch {
    return { path: relativePath, status: 'invalid' };
  }
  if (!content.trim()) return { path: relativePath, status: 'empty' };
  const dateValue = extractField(content, dateLabels);
  if ((!dateValue || dateValue.includes('YYYY-MM-DD')) && !hasMeaningfulFields(content, contentLabels)) {
    return { path: relativePath, status: 'empty' };
  }
  const date = parseDate(dateValue);
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return { path: relativePath, status: 'invalid' };
  }
  const ageMs = Date.now() - date.getTime();
  const staleByAge = ageMs > maxAgeDays * 24 * 60 * 60 * 1000;
  const staleByHead = headDate instanceof Date && dateValue < headDate.toISOString().slice(0, 10);
  return {
    date: dateValue,
    path: relativePath,
    status: staleByAge || staleByHead ? 'stale' : 'current',
  };
}

export async function inspectMemory(config, installState, targetDir) {
  const runtimePath = path.posix.join((config.memory?.path || '.agents/memory').replaceAll('\\', '/'), 'CURRENT.md');
  const durablePath = 'docs/memory/PROJECT_STATE.md';
  if (config.memory?.enabled === false) {
    return {
      runtime: { path: runtimePath, status: 'disabled' },
      durable: { path: durablePath, status: 'disabled' },
    };
  }
  const installedTargets = new Set((installState?.files || []).map((file) => file.target.replaceAll('\\', '/')));
  const headDate = await headCommitDate(targetDir);
  const runtime = await inspectMemoryFile({
    contentLabels: [['目标', 'Goal'], ['当前状态', 'Current status'], ['已验证证据', 'Verified evidence'], ['下一步最小动作', 'Next action']],
    dateLabels: ['最后验证', 'Last verified'],
    headDate,
    installed: installedTargets.has(runtimePath),
    maxAgeDays: 1,
    relativePath: runtimePath,
    targetDir,
  });
  const durable = await inspectMemoryFile({
    contentLabels: [['当前阶段', 'Current phase'], ['当前重点', 'Current focus'], ['下一步动作', 'Next action'], ['恢复提示', 'Resume hint']],
    dateLabels: ['最后更新', 'Last updated'],
    headDate: null,
    installed: installedTargets.has(durablePath),
    maxAgeDays: 30,
    relativePath: durablePath,
    targetDir,
  });
  return { runtime, durable };
}
