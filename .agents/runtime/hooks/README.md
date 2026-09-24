# Project safety hooks

The Hook runtime applies project-scoped safety policy, plus one read-only gate that keeps already-frozen acceptance test assets frozen. It does not create task state, run validation commands, inspect delivery records, block completion, commit, or push.

## Event contract

The single source of truth is manifests/adapters.json. PreToolUse is stable on Codex, Claude, Cursor, Qoder, and ZCode; preview on Antigravity; unsupported on Gemini and OpenCode. PermissionRequest is stable on Codex, Claude, Qoder, and ZCode and unsupported elsewhere. Stop is not-projected on Codex and Claude Code (the hosts support the event, this project installs no Stop hook) and unsupported on the remaining hosts; "not-projected" and "unsupported" are different conclusions.

PreToolUse enforces destructive-Git, global-configuration, credential, egress, red-zone, project-boundary, control-plane, and frozen-test-asset controls. PermissionRequest enforces the same hard boundaries while leaving ordinary approval to the host.

PreToolUse matches every tool name, so a tool the host introduces later is judged instead of silently skipping the policy. Tools that cannot touch the workspace — a plan or image viewer, the sub-agent tools, the read-only thread and automation tools, and every tool whose name already reads as a read verb — are classified as read-only and pass. Tools that mutate host state, and every tool the classifier does not name, keep the Execution Envelope path.

When hooks are active, high-risk effects require an Execution Envelope even without explicit injection. A host-injected envelope or parent-owned VIBE_HARNESS_EXECUTION_ENVELOPE_REQUIRED=1 also enforces the envelope for other effectful calls, including when hooks.mode is off. Low-risk project writes do not require an envelope when neither is present. The required switch is deliberately parent-owned; repository files are not an authorization root. Without host injection and durable request/checkpoint state, the installed Hook remains defense in depth and must not be reported as complete host-level execution authorization.

## Frozen test assets

A managed task anchor can freeze the acceptance assets of a defect fix. When an anchor under `.vibe-harness/tasks/` carries `units[].testFreeze.paths` with `status: frozen`, PreToolUse denies a write whose resolved target intersects those paths or their parent entries. The gate covers structured edit tools, `*** Update/Add/Delete File:` patch headers, shell redirection, `rm`/`mv`/`cp`/`tee`/`ln`/`mklink`, a filesystem call inside an interpreter command, and a target that only reaches the asset through a symbolic link. A write-classified request whose target cannot be resolved is denied as `FROZEN_TEST_WRITE_TARGET_UNKNOWN` rather than allowed, and an unreadable anchor denies as `FROZEN_TEST_STATE_UNAVAILABLE`; both stay fail-closed because a freeze that is silently skipped has no gate behind it.

The anchors themselves are control-plane paths, so a direct edit, patch, or shell write to `.vibe-harness/tasks/` is denied as `CONTROL_PLANE_WRITE`: the freeze cannot be lifted by editing the record that owns it. The gate only reads. `run.mjs task freeze-tests` remains the establishing writer and `rebaseline-tests` additionally requires a protected approval receipt. It runs before the `hooks.mode = off` early return, because off disables the safety policy and not an already-frozen acceptance baseline, and it never judges task completion.

## Path resolution

The configured command runs an inline cross-platform Node bootstrap from the session working directory. It walks up from that directory to the nearest directory containing `.git` (a directory or a file, so worktrees and submodules resolve to their own checkout), locates .agents/runtime/hooks/codex-hook.mjs from that root, and launches it with process.execPath while passing the Hook arguments and standard streams through. The bootstrap forwards a fixed environment allowlist (PATH, PATHEXT, SystemRoot, SystemDrive, TEMP, TMP, HOME, USERPROFILE, CODEX_HOME, the two VIBE_HARNESS_EXECUTION_ENVELOPE switches, plus the resolved VIBE_HARNESS_GIT_ROOT) instead of the host's whole environment. It never calls git and never uses a shell, so no command substitution is possible and a missing Git binary is not a failure mode.

## Failure contract

Failures are reported through the host decision channel, not through a non-zero exit: a host records a non-zero exit as a failed Hook run and then continues the tool call, so only `exit 2` or a host-recognised deny decision blocks anything.

A missing project root, a missing managed runtime, a child-process launch error, and the bootstrap's own 8-second budget all write a host-specific deny payload, one diagnostic line to stderr, and then exit 0. The payload shape follows the host: codex, claude, qoder, and zcode use `hookSpecificOutput.permissionDecision=deny` for PreToolUse and `hookSpecificOutput.decision.behavior=deny` for PermissionRequest, Cursor receives `{"continue":false}`, and Antigravity receives `{"decision":"deny"}`. Only a completely unknown host falls back to `exit 2`. Every reason starts with `[VIBE_HARNESS_HOOK:BOOTSTRAP_UNAVAILABLE]`.

The managed runtime keeps its own 5-second budget inside the host's 10-second timeout and answers with the same deny shape (`HOOK_BUDGET_EXCEEDED`) instead of being killed, because a host-killed Hook does not block the tool call. `VIBE_HARNESS_HOOK_BUDGET_MS` can only shorten that budget.

### Residual risk

The installed command starts with `node`, so it depends on a `node` binary on the host PATH and on a Node version able to run the managed runtime. When the interpreter itself cannot start, the command never runs and the host records a failed Hook run and continues the tool call — the fail-open path this contract exists to avoid. The pack keeps the portable `node` invocation instead of freezing `process.execPath` into the installed definition, so one definition survives worktree moves and machine migration; a project that needs that last guarantee must pin the interpreter in its own host configuration.

## Activation

Codex uses manual trust. Project-file consistency cannot prove runtime activation; validate and doctor keep the status unknown and direct the user to /hooks. Configuration-file hosts report configured-unverified until checked in the host. Unsupported hosts report unsupported.

hooks.mode supports off, observe, and guarded; only the frozen-test-asset gate above keeps applying when the project turns the mode off. Optional RTK routing uses the same safety boundary and requires explicit project configuration. The runtime never changes global Agent configuration or local Git core.hooksPath.
