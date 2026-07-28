# Codex safety hooks

The Codex Hook runtime applies project-scoped safety policy only. It does not create task state, run validation commands, inspect delivery records, or block completion.

## Events

| Event | Behavior |
| --- | --- |
| `PreToolUse` | Rejects destructive Git operations, global Agent configuration writes, credential exfiltration, and writes outside the project boundary. Adds context for project red-zone writes. |
| `PermissionRequest` | Rejects requests that violate the same hard safety boundaries; ordinary approval requests remain controlled by the host. |

`hooks.mode` supports `off`, `observe`, and `guarded`. Optional RTK command routing uses the same safety boundary and is enabled only through the explicit RTK plugin setting.

The runtime never changes global Agent configuration or local Git `core.hooksPath`.
