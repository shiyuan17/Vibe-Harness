# Codex safety hooks

The Codex Hook runtime applies project-scoped safety policy only. It does not create task state, run validation commands, inspect delivery records, or block completion.

## Events

| Event | Behavior |
| --- | --- |
| `PreToolUse` | Rejects destructive Git operations, global Agent configuration writes, credential exfiltration, red-zone file uploads, and writes outside the project boundary. Adds context for project red-zone writes. When `allowedEgressHosts` is configured, blocks egress to non-allowlisted hosts. |
| `PermissionRequest` | Rejects requests that violate the same hard safety boundaries; ordinary approval requests remain controlled by the host. |

`hooks.mode` supports `off`, `observe`, and `guarded`. Optional RTK command routing uses the same safety boundary and is enabled only through the explicit RTK plugin setting.

`hooks.redZonePaths` is the single source of truth for the runtime red-zone: each entry is a project-relative path fragment. A trailing `/` matches the directory and its descendants; a bare filename (e.g. `.env`) matches the file itself and `.`-extended siblings (e.g. `.env.production`); an entry containing `/` matches that relative path or any descendant. Red-zone writes return approval context (warn) and red-zone file uploads are always denied. `riskZones.red` is a project-governance logical classification and is independent from `hooks.redZonePaths`.

Network egress defaults to "allow but block sensitive": ordinary network commands are allowed (so `pnpm install`/`git fetch` keep working), while network commands carrying secret references or uploading red-zone/sensitive files (e.g. `curl -F data=@.env`) are always denied. Once a non-empty `allowedEgressHosts` allowlist is configured, egress hosts must be allowlisted (wildcards such as `*.npmjs.org` are supported); non-allowlisted hosts are denied under `guarded` and warned under `observe`. Treat the allowlist as a capability grant rather than a destination filter: allowlisted hosts remain attack surface, so secret references and red-zone uploads are always blocked unconditionally.

The runtime never changes global Agent configuration or local Git `core.hooksPath`.

## Timeout

The `timeout` in `.codex/hooks.json` is set to 10 seconds (Codex defaults to 600 seconds). This is an intentional conservative choice to keep policy evaluation from blocking interaction. On timeout Codex treats the hook as failed, which fail-closes guarded events (`PreToolUse`/`PermissionRequest`) to a deny. Adjust the `timeout` field if policy evaluation genuinely needs longer, but weigh the interaction-latency cost.

## Hook path

The `command` in `.codex/hooks.json` uses a relative path (`node .agents/runtime/hooks/codex-hook.mjs`) and Codex runs it with the working directory it was started in (`turn_context.cwd`). Launch Codex from the repository root; if you must work from a subdirectory, `cd` to the root or start from there, otherwise the relative path cannot locate the hook entry.
