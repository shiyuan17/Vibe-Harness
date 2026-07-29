# Codex safety hooks

The Codex Hook runtime applies project-scoped safety policy only. It does not create task state, run validation commands, inspect delivery records, or block completion.

## Events

| Event | Behavior |
| --- | --- |
| `PreToolUse` | Rejects destructive Git operations, global Agent configuration writes, credential exfiltration, red-zone file uploads, and writes outside the project boundary. Adds context for project red-zone writes. When `allowedEgressHosts` is configured, blocks egress to non-allowlisted hosts. |
| `PermissionRequest` | Rejects requests that violate the same hard safety boundaries; ordinary approval requests remain controlled by the host. |

`hooks.mode` supports `off`, `observe`, and `guarded`. Optional RTK command routing uses the same safety boundary and is enabled only through the explicit RTK plugin setting.

Network egress defaults to "allow but block sensitive": ordinary network commands are allowed (so `pnpm install`/`git fetch` keep working), while network commands carrying secret references or uploading red-zone/sensitive files (e.g. `curl -F data=@.env`) are always denied. Once a non-empty `allowedEgressHosts` allowlist is configured, egress hosts must be allowlisted (wildcards such as `*.npmjs.org` are supported); non-allowlisted hosts are denied under `guarded` and warned under `observe`.

The runtime never changes global Agent configuration or local Git `core.hooksPath`.
