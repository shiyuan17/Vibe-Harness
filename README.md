# Cognis

[English](README.md) | [简体中文](README.zh-CN.md)

Cognis installs project-scoped rules, domain Skills, optional Evals, explicit tool plugins, and safety Hooks for Codex, Claude Code, and Gemini CLI. It writes only inside the target project and never changes global Agent configuration.

There is one default execution path: `gather facts -> execute -> focused verification -> concise delivery`. Quick, light, and full are risk levels used only to choose safeguards and verification depth.

## Quick start

Requires pnpm 10+ and Node.js 20.19+, 22.18+, or 24+.

```bash
pnpm install
pnpm cognis init --project ../some-project --target codex
pnpm cognis install --project ../some-project --target codex --profile core --dry-run
pnpm cognis install --project ../some-project --target codex --profile core --write
pnpm cognis validate --project ../some-project
```

`validate` checks installation consistency only. Run configured project checks with:

```bash
pnpm cognis verify --project ../some-project
```

`verify` runs configured commands in `lint -> typecheck -> test -> eval` order and skips unconfigured commands.

## Execution model

- Quick: read-only work, explanations, documentation, and tiny non-behavioral changes.
- Light: reversible local behavior changes with checks focused on the affected surface.
- Full: security, production, releases, data migration, public contracts, red-zone, irreversible, or cross-repository work with broader verification and rollback preparation.

A single Agent handles work by default. Explicit `open-code-review`, browser verification, Eval, and project test tools remain available. Task Markdown is an optional human-readable note and is not part of runtime decisions.

## Profiles

| Profile | Installed surface |
| --- | --- |
| `minimal` | Platform instructions, safety boundaries, Git/Test rules, and optional task/delivery templates |
| `core` | `minimal` plus common engineering rules, five domain Skills, and offline Eval |
| `full` | `core` plus three domain Skills, online Eval, and Codex safety Hooks |
| `docs-only` | Rules, templates, and schemas without runtime, Skills, MCP, or Hooks |

External tools and memory remain explicit `--plugin` choices. Codex `full` requires `--confirm-red-zone` when writing `.codex/hooks.json`.

```bash
pnpm cognis install --project ../some-project --target codex --profile full --dry-run
pnpm cognis install --project ../some-project --target codex --profile full --write --confirm-red-zone
```

Claude Code and Gemini CLI use the same four profiles; preview capabilities require explicit `--allow-preview`.

## Project configuration

`cognis init` creates this structure:

```json
{
  "projectName": "ExampleProject",
  "language": "zh-CN",
  "packageManager": "pnpm",
  "target": "codex",
  "profile": "core",
  "validationCommands": {
    "lint": null,
    "typecheck": null,
    "test": null,
    "eval": null
  },
  "evaluations": {
    "enabled": false,
    "suites": [],
    "reference": "evals/references/project.json",
    "thresholds": {
      "criticalPassRate": 1,
      "overallScore": 0.9,
      "maxCapabilityRegression": 0.05
    },
    "onlineRunner": null,
    "repetitions": 3
  },
  "hooks": {
    "allowedWriteRoots": [],
    "allowedEgressHosts": [],
    "mode": "guarded"
  },
  "riskZones": {
    "red": ["auth", "secrets", "ci-cd", "env"],
    "yellow": ["shared-libs", "state", "routing", "io-clients"]
  },
  "crossRepo": {
    "enabled": false,
    "backendRepo": ""
  },
  "projectRules": {
    "mode": "auto",
    "overrides": {}
  },
  "clarification": {
    "posture": "balanced"
  },
  "memory": {
    "enabled": true,
    "path": ".agents/memory"
  }
}
```

Legacy `governance.mode`, `governance.workflow`, `hooks.completionGate`, and `validationCommands.governance` fields raise `COGNIS_OBSOLETE_GOVERNANCE_CONFIG`. Cognis does not silently accept or rewrite them.

## Explicit tools

Optional plugins are `rtk`, `ast-grep`, `codebase-memory-mcp`, `chrome-devtools-mcp`, `playwright-cli`, `open-code-review`, and `agentmemory`.

```bash
pnpm cognis install --project ../some-project --target codex --profile core --plugin -rtk --dry-run
pnpm cognis install --project ../some-project --target codex --profile core --plugin -rtk ast-grep --write
pnpm cognis install --project ../some-project --target codex --profile core --plugin none --write
```

Plugin choices persist in project install-state. `--modules` is an advanced replacement for the profile module set, not an incremental plugin interface.

## Upgrade and removal

Upgrade compares the old install-state with the new plan. Managed files no longer planned are retired by `--upgrade --write` only when unchanged; modified files are reported as conflicts and preserved. Obsolete runtime state is removed precisely without deleting the whole `.cognis` directory.

```bash
pnpm cognis install --project ../some-project --target codex --profile core --dry-run --upgrade
pnpm cognis install --project ../some-project --target codex --profile core --write --upgrade
pnpm cognis uninstall --project ../some-project --target codex --dry-run
pnpm cognis uninstall --project ../some-project --target codex --write
```

## Safety boundaries

- Existing project files are preserved unless `--force` is explicit.
- Every mutation requires `--write`; red-zone writes require explicit confirmation.
- The installer does not modify global Agent configuration or `.git/config`.
- Codex Hooks listen only to `PreToolUse` and `PermissionRequest` to block dangerous Git, global configuration writes, credential exfiltration, red-zone file uploads, out-of-project writes, and (when an `allowedEgressHosts` allowlist is configured) non-allowlisted network egress.
- Completion claims must match fresh evidence; narrow the claim and report risk when verification is unavailable.

## Documentation

- [Documentation index](docs/README.md)
- [Architecture](docs/architecture.md)
- [Migration guide](docs/migration-guide.md)
- [Hook safety policy](docs/hooks.md)
- [Eval](docs/evals.md)
- [Contributing](CONTRIBUTING.md)

## License

[MIT](LICENSE)
