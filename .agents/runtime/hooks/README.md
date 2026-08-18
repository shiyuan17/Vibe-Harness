# Project safety hooks

The Hook runtime applies project-scoped safety policy only. It does not create task state, run validation commands, inspect delivery records, block completion, commit, or push.

## Event contract

The single source of truth is manifests/adapters.json. PreToolUse is stable on Codex, Claude, Cursor, Qoder, and ZCode; preview on Antigravity; unsupported on Gemini and OpenCode. PermissionRequest is stable on Codex, Claude, Qoder, and ZCode and unsupported elsewhere. Stop is unsupported on every host.

PreToolUse enforces destructive-Git, global-configuration, credential, egress, red-zone, and project-boundary controls. PermissionRequest enforces the same hard boundaries while leaving ordinary approval to the host.

Execution Envelope enforcement is active when the host injects an envelope or the parent process sets VIBE_HARNESS_EXECUTION_ENVELOPE_REQUIRED=1. The required switch is deliberately parent-owned; repository files are not an authorization root. Without host injection and durable request/checkpoint state, the installed Hook remains defense in depth and must not be reported as complete host-level execution authorization.

## Path resolution

The configured command runs an inline cross-platform Node bootstrap from the session working directory. It obtains the Git root with git rev-parse --show-toplevel, locates .agents/runtime/hooks/codex-hook.mjs from that root, and launches it with process.execPath while inheriting standard streams and arguments. Missing Git roots or runtimes fail with a non-zero exit. No shell command substitution is used.

## Activation

Codex uses manual trust. Project-file consistency cannot prove runtime activation; validate and doctor keep the status unknown and direct the user to /hooks. Configuration-file hosts report configured-unverified until checked in the host. Unsupported hosts report unsupported.

hooks.mode supports off, observe, and guarded. Optional RTK routing uses the same safety boundary and requires explicit project configuration. The runtime never changes global Agent configuration or local Git core.hooksPath.
