# Vibe-Harness

[English](README.en.md) | [简体中文](README.md)

Vibe-Harness installs project-scoped rules, domain Skills, optional Evals, explicit tool plugins, and safety Hooks for Codex, Claude Code, Gemini CLI, Cursor, Qoder, ZCode, Antigravity, and OpenCode. It writes only inside the target project and never changes global Agent configuration.

There is one default execution path: `gather trustworthy facts -> decide and execute -> focused verification -> concise delivery`. The decision selects direct implementation, further investigation, clarification, authorization, planning, or task splitting according to evidence, ambiguity, and complexity. Quick, light, and full are risk levels used only to choose safeguards and verification depth.

## Quick start

Requires pnpm 10+ and Node.js 20.19+, 22.18+, or 24+.

From the Vibe-Harness repository, choose and copy one prompt below, replacing TARGET_PROJECT_ABSOLUTE_PATH with the absolute target project path. First identify every required host and put codex, claude, gemini, cursor, qoder, zcode, antigravity, or opencode in the single non-empty targets array. These prompts are for first-time installs; use the upgrade flow below for an existing installation.

In the prompts below, select every adapter the project actually uses and store them in one targets array; do not install separately per editor.

### minimal

    Install the Vibe-Harness minimal profile into TARGET_PROJECT_ABSOLUTE_PATH. You are working from the Vibe-Harness repository: first check the Node.js and pnpm versions and install this repository's dependencies; select the codex, claude, or gemini adapter for the current Agent host. If the target has no vibe-harness.config.json, initialize it with the selected adapter and minimal profile; if its configuration or existing install state does not match, stop and report the mismatch, and never use --force. Run an install dry-run first, inspect it for conflicts, out-of-project writes, or unexpected overwrites, and only then perform the install with --write. Finish with validate --project. The minimal install must not select optional plugins or create a code index. Write only inside the target project and do not modify global Agent, MCP, or Git configuration. Report actual writes, validation results, and anything incomplete.

### core (recommended)

    Install the Vibe-Harness core profile into TARGET_PROJECT_ABSOLUTE_PATH, then install and enable codebase-memory-mcp and create its initial code index. You are working from the Vibe-Harness repository: first check the Node.js and pnpm versions and install this repository's dependencies; select the codex, claude, or gemini adapter for the current Agent host. If the target has no vibe-harness.config.json, initialize it with the selected adapter and core profile; if its configuration or existing install state does not match, stop and report the mismatch, and never use --force. Both the install dry-run and write must explicitly select --plugin codebase-memory-mcp. Inspect the dry-run for conflicts, out-of-project writes, overwrites, and red-zone actions before using --write. I explicitly authorize this installation to write the project-scoped MCP red-zone configuration planned by that plugin; use --confirm-red-zone for the write. Preview provision, then run provision --write to install and enable the pinned project-local runtime, disable auto_index and auto_watch, build the index, verify that it belongs to the target project and is ready, and complete the MCP handshake. Finish with validate --project and doctor --project. Report complete success only when the installation is consistent and codebaseMemoryMcp is ready; otherwise report the failed phase and recovery command. Do not modify global Agent, MCP, or Git configuration.

### full

    Install the Vibe-Harness full profile into TARGET_PROJECT_ABSOLUTE_PATH, then install and enable codebase-memory-mcp and create its initial code index. You are working from the Vibe-Harness repository: first check the Node.js and pnpm versions and install this repository's dependencies; select the codex, claude, or gemini adapter for the current Agent host. If the target has no vibe-harness.config.json, initialize it with the selected adapter and full profile; if its configuration or existing install state does not match, stop and report the mismatch, and never use --force. Both the install dry-run and write must explicitly select --plugin codebase-memory-mcp. Inspect the dry-run for conflicts, out-of-project writes, overwrites, and red-zone actions before using --write. I explicitly authorize this full installation to write its planned project-scoped Hook and MCP red-zone configuration; use --confirm-red-zone for the write. Preview provision, then run provision --write to install and enable the pinned project-local runtime, disable auto_index and auto_watch, build the index, verify that it belongs to the target project and is ready, and complete the MCP handshake. Finish with validate --project and doctor --project. Report complete success only when the installation is consistent and codebaseMemoryMcp is ready; otherwise report the failed phase and recovery command. Do not modify global Agent, MCP, or Git configuration.

The core and full quick prompts explicitly add codebase-memory-mcp; this does not change the profile contract that external tools must be selected with --plugin. The equivalent manual core install is:

```bash
pnpm install
pnpm vibe-harness init --project ../some-project --target codex --profile core
pnpm vibe-harness install --project ../some-project --target codex --profile core --plugin codebase-memory-mcp --dry-run
pnpm vibe-harness install --project ../some-project --target codex --profile core --plugin codebase-memory-mcp --write --confirm-red-zone
pnpm vibe-harness provision --project ../some-project --target codex --profile core --dry-run
pnpm vibe-harness provision --project ../some-project --target codex --profile core --write
pnpm vibe-harness validate --project ../some-project
pnpm vibe-harness verify --project ../some-project --plan
pnpm vibe-harness verify --project ../some-project --full
pnpm vibe-harness doctor --project ../some-project
```

`validate` checks installation consistency only. Run configured project checks with:

```bash
pnpm vibe-harness verify --project ../some-project
```

`verify` builds one `auto` risk plan from changed paths: documentation, single-test, and pure-function changes run only affected checks; public contracts, installers, runtime, Hooks, CI, lockfiles, or unclassified changes fall back to full verification. `--plan` only prints risk, impact groups, selected/skipped checks, and fallback reasons; `--full` explicitly runs the complete matrix. Unselected checks are recorded as `not_selected`, while unconfigured checks remain `not_configured`.

Verification JSON also includes the run ID, timestamps, and a non-persisted Git worktree fingerprint. A worktree change during checks returns PROJECT_VERIFICATION_STALE.

### Project-local deterministic scripts

The `core` and `full` profiles install a project-local command surface by default; `minimal` and `docs-only` do not. Mechanical fact collection and configured checks stay in the script, while the Agent chooses scope and explains results:

```bash
node .agents/runtime/commands/run.mjs env --project . --json
node .agents/runtime/commands/run.mjs context --project . --json
node .agents/runtime/commands/run.mjs changes --project . --json
node .agents/runtime/commands/run.mjs verify --project . --plan --json
node .agents/runtime/commands/run.mjs verify --project . --json
```

`verify --plan` previews configured checks without executing them. The script has no arbitrary command option, does not edit configuration, and does not use the network. Commands come from `validationCommands` in `vibe-harness.config.json`; failures, timeouts, unsafe commands, and worktree changes during verification are reported explicitly.

## Multi-host installation

Install a project only once. The targets array declares every host. Without --target, install, upgrade, validate, doctor, and diff process all targets. With --target, a command selects one host still present in configuration or install-state and never adds it implicitly.

Common rules, runtime, memory, Evals, and the codebase-memory index have one shared owner at the project root. Host instructions, native Skills, MCP, and Hooks use adapter:id projection owners. Do not repeat installation in a project subdirectory to simulate multi-host support.

## Execution model

- Quick: read-only work, explanations, documentation, and tiny non-behavioral changes.
- Light: reversible local behavior changes with checks focused on the affected surface.
- Full: security, production, releases, data migration, public contracts, red-zone, irreversible, or cross-repository work with broader verification and rollback preparation.

A single Agent handles work by default. Explicit `open-code-review`, browser verification, Eval, and project test tools remain available. Task Markdown is an optional human-readable note and is not part of runtime decisions.

## Profiles

The core profile installs six native Skills; full installs nine.

| Profile | Installed surface |
| --- | --- |
| `minimal` | Platform instructions, safety boundaries, Git/Test rules, and optional task/delivery templates |
| `core` | `minimal` plus common engineering rules, six native Skills, project-local deterministic scripts, and offline Eval |
| `full` | `core` plus three native Skills, online Eval, and supported platform safety Hooks, for nine native Skills total |
| `docs-only` | Rules, templates, and schemas without runtime, Skills, MCP, or Hooks |

External tools and memory remain explicit `--plugin` choices. Every host configuration file is a red-zone write and requires `--confirm-red-zone`.

```bash
pnpm vibe-harness install --project ../some-project --target codex --profile full --dry-run
pnpm vibe-harness install --project ../some-project --target codex --profile full --write --confirm-red-zone
```

Claude Code and Gemini CLI use the same four profiles; preview capabilities require explicit `--allow-preview`.

## Adapter support

Codex, Cursor, Qoder, ZCode, and OpenCode share one host-neutral managed block in AGENTS.md. Antigravity rules, Skills, and MCP are stable; Hooks, sandbox, and memory integration remain preview and are not Codex-equivalent yet. OpenCode instructions, Skills, policy, and MCP are stable; sandbox and memory are preview; Hooks, plugin, and goals are unsupported.

OpenCode full requires preview to be explicitly allowed. It uses an existing opencode.json or opencode.jsonc and reports a conflict when both exist; JSONC comments, trailing commas, formatting, and user settings are preserved. OpenCode installs no project plugin Hook and always reports DEGRADED_SAFETY_POSTURE.

| Target | Project instructions | Skills | Project Hook / MCP configuration |
| --- | --- | --- | --- |
| OpenCode | AGENTS.md | .opencode/skills/ | opencode.json or opencode.jsonc; MCP only, no Hook installed |
| Antigravity | .agents/rules/vibe-harness.md | .agents/skills/ | .agents/mcp_config.json; Hook is preview |
| Codex | `AGENTS.md` | `.agents/skills/` | `.codex/` |
| Claude Code | `CLAUDE.md` | `.claude/skills/` | Preview capabilities |
| Gemini CLI | `GEMINI.md` | `.gemini/skills/` | Preview capabilities |
| Cursor | `AGENTS.md` | `.cursor/skills/` | `.cursor/hooks.json`, `.cursor/mcp.json` |
| Qoder | `AGENTS.md` | `.qoder/skills/` | `.qoder/settings.json`, `.mcp.json` |
| ZCode | `AGENTS.md` | Not installed automatically | `.zcode/config.json` |

ZCode project Skill storage has no documented project-scoped path, so Vibe-Harness never writes `~/.zcode` or guesses a project Skill directory. Import Skills manually through the ZCode UI when needed. Managed JSON updates only Vibe-Harness MCP servers and Hook groups; user settings remain intact.

## Project configuration

`vibe-harness init` creates this structure:

```json
{
  "projectName": "ExampleProject",
  "language": "zh-CN",
  "packageManager": "pnpm",
  "targets": ["codex"],
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
    "yellow": ["shared-libs", "state", "routing", "io-clients"],
    "pathPatterns": { "red": [], "yellow": [] }
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

Legacy `governance.mode`, `governance.workflow`, `hooks.completionGate`, and `validationCommands.governance` fields raise `VIBE_HARNESS_OBSOLETE_GOVERNANCE_CONFIG`. Vibe-Harness does not silently accept or rewrite them.

## Explicit tools

The Linear workflow is a separate external integration: linear-mcp uses the read-write endpoint and linear-mcp-readonly uses the read-only endpoint. They are mutually exclusive and neither is selected by plugin all. Codex, Cursor, Qoder, ZCode, Antigravity, and OpenCode receive project-scoped Remote MCP configuration. Claude and Gemini receive the same rules and Skill but report manual MCP setup as a degraded capability. The installer writes no token or OAuth credential; complete the host's native Linear authentication after configuration.

Optional plugins are `rtk`, `ast-grep`, `codebase-memory-mcp`, `chrome-devtools-mcp`, `playwright-cli`, and `open-code-review`. Agentmemory runtime is suspended (upstream High vulnerabilities) and is not a `--plugin` choice; install the `memory` module via `--modules memory` when memory support is re-enabled.

```bash
pnpm vibe-harness install --project ../some-project --target codex --profile core --plugin -rtk --dry-run
pnpm vibe-harness install --project ../some-project --target codex --profile core --plugin -rtk ast-grep --write
pnpm vibe-harness install --project ../some-project --target codex --profile core --plugin linear-mcp --write --confirm-red-zone
pnpm vibe-harness install --project ../some-project --target codex --profile core --plugin linear-mcp-readonly --write --confirm-red-zone
pnpm vibe-harness install --project ../some-project --target codex --profile core --plugin none --write
```

Plugin choices persist in project install-state. `--modules` is an advanced replacement for the profile module set, not an incremental plugin interface.

## Upgrade and removal

Legacy target configuration remains readable, but only install --upgrade --write atomically migrates it and state v4 to targets and state v5 owners. Manually deleting a target from configuration reports a stale projection and never removes it during upgrade. Target-scoped uninstall removes one projection; the final target and shared assets require --all-targets.

Upgrade compares the old install-state with the new plan. Managed files no longer planned are retired by `--upgrade --write` only when unchanged; modified files are reported as conflicts and preserved. Obsolete runtime state is removed precisely without deleting the whole `.vibe-harness` directory.

```bash
pnpm vibe-harness install --project ../some-project --target codex --profile core --dry-run --upgrade
pnpm vibe-harness install --project ../some-project --target codex --profile core --write --upgrade
pnpm vibe-harness uninstall --project ../some-project --target codex --dry-run
pnpm vibe-harness uninstall --project ../some-project --target codex --write
pnpm vibe-harness uninstall --project ../some-project --all-targets --write
```

The preserve-retired option keeps assets that an upgrade would retire and reports them as retained. Without it, upgrade retirement remains unchanged.

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success (or degraded with `--allow-degraded`). |
| 1 | Failure: invalid state, install error, or unhandled exception. |
| 2 | Partial skip: uninstall or rollback retained some files due to user modifications; or health check is degraded without `--allow-degraded`. |

## Safety boundaries

- Existing project files are preserved unless `--force` is explicit.
- Every mutation requires `--write`; red-zone writes require explicit confirmation.
- The installer does not modify global Agent configuration or `.git/config`.
- Codex, Cursor, Qoder, and ZCode Hooks normalize their `PreToolUse` and permission events through the same safety policy to block dangerous Git, global configuration writes, credential exfiltration, red-zone file uploads, out-of-project writes, and (when an `allowedEgressHosts` allowlist is configured) non-allowlisted network egress. RTK Hook routing remains Codex-only.
- Completion claims must match fresh evidence; narrow the claim and report risk when verification is unavailable.

## Roles

Full enables seven role personas by default; other profiles can opt in with roles.enabled. Each atomic action activates one role and may add at most one matching domain Skill, with rerouting only when the goal or action type changes. The ZCode role plugin stays project-local and doctor reports manual-activation-required; hosts with weaker permission expression report degraded mapping. See the [role documentation](docs/roles.md) for configuration, permissions, and routing.

## Documentation

- [Documentation index](docs/README.md)
- [Architecture](docs/architecture.md)
- [Migration guide](docs/migration-guide.md)
- [Hook safety policy](docs/hooks.md)
- [Eval](docs/evals.md)
- [Contributing](CONTRIBUTING.md)

## License

[MIT](LICENSE)
