# Codex safety hooks

The Codex Hook runtime applies project-scoped safety policy only. It does not create task state, run validation commands, inspect delivery records, or block completion.

OpenCode installs no project plugin Hook. Its opencode.json and opencode.jsonc files remain in the default red-zone list so stable Hooks from other installed hosts protect them in multi-host projects; OpenCode itself reports DEGRADED_SAFETY_POSTURE.

## Events

| Event | Behavior |
| --- | --- |
| `PreToolUse` | Rejects destructive Git operations, global Agent configuration writes, credential exfiltration, red-zone file uploads, and writes outside the project boundary. Adds context for project red-zone writes. When `allowedEgressHosts` is configured, blocks egress to non-allowlisted hosts. |
| `PermissionRequest` | Rejects requests that violate the same hard safety boundaries; ordinary approval requests remain controlled by the host. |
| `Stop` | Auto-commit hook on ZCode, Claude Code, and Codex. When the agent finishes a response, the hook runs a completeness gate (safety scan, syntax check, lint + test) on task-branch working-tree changes and commits a single independently-rollbackable snapshot. Never pushes, never uses `--no-verify`, never handles red-zone files. Cursor, Qoder, and Antigravity do not support hooks and cannot auto-commit. |

`hooks.mode` supports `off`, `observe`, and `guarded`. Optional RTK command routing uses the same safety boundary and is enabled only through the explicit RTK plugin setting.
`hooks.redZonePaths` is the single source of truth for the runtime red-zone: each entry is a project-relative path fragment. A trailing `/` matches the directory and its descendants; a bare filename (e.g. `.env`) matches the file itself and `.`-extended siblings (e.g. `.env.production`); an entry containing `/` matches that relative path or any descendant. Red-zone writes return approval context (warn) and red-zone file uploads are always denied. `riskZones.red` is a project-governance logical classification and is independent from `hooks.redZonePaths`.

Network egress defaults to "allow but block sensitive": ordinary network commands are allowed (so `pnpm install`/`git fetch` keep working), while network commands carrying secret references or uploading red-zone/sensitive files (e.g. `curl -F data=@.env`) are always denied. Once a non-empty `allowedEgressHosts` allowlist is configured, egress hosts must be allowlisted (wildcards such as `*.npmjs.org` are supported); non-allowlisted hosts are denied under `guarded` and warned under `observe`. Treat the allowlist as a capability grant rather than a destination filter: allowlisted hosts remain attack surface, so secret references and red-zone uploads are always blocked unconditionally.

The runtime never changes global Agent configuration or local Git `core.hooksPath`.

## Timeout

The project Hook configuration uses a 10-second `timeout`. This conservative value prevents policy evaluation from blocking interaction; guarded `PreToolUse` and permission events fail closed on timeout. Cursor uses `.cursor/hooks.json`, Qoder uses `.qoder/settings.json`, ZCode uses `.zcode/config.json`, and Codex uses `.codex/hooks.json`.

## Hook path

Each host runs `node .agents/runtime/hooks/codex-hook.mjs --host <host>` with a project-relative command. The runtime resolves `vibe-harness.config.json` from the payload working directory and falls back to the current directory. Start the host from the project root so the relative command can locate the Hook entry.
