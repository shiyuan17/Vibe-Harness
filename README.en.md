# Vibe-Harness

[English](README.en.md) | [简体中文](README.md)

Vibe-Harness installs project-scoped rules, domain Skills, optional Evals, explicit tool plugins, and safety Hooks for Codex, Claude Code, Gemini CLI, Cursor, Qoder, ZCode, Antigravity, and OpenCode. It is aimed at people and teams who use AI Agents on real projects for the long run: it turns "the Agent edits the code directly" into a reviewable chain of evidence, so completion claims bind to verification results instead of to wording. It writes only inside the target project and never changes global Agent configuration.

There is one default execution path: `gather trustworthy facts -> decide and execute -> focused verification -> concise delivery`. The decision selects direct implementation, further investigation, clarification, authorization, planning, or task splitting according to evidence, ambiguity, and complexity. Quick, light, and full are risk levels used only to choose safeguards and verification depth.

## First use: start with core

The recommended entry point is `core`: it installs the rules, domain Skills, project-local deterministic scripts, and safety Hooks, which is enough to run a real task without first accepting the extra exposure of the full tool plugin set. `full` and `--preset everything` are explicit advanced options, see "Full capabilities (advanced)"; choose `minimal` only when you want the smallest rules surface.

The first installation is three steps, with the commands in the core prompt under "Quick start" below: dry-run to see the write list, use `--write` once conflicts and out-of-scope overwrites are ruled out (adding `--confirm-red-zone` for red-zone files), then run `validate` for installation consistency plus one quick-layer `verify`.

### One task example

Give the installed project a concrete task, for example "change this module's error handling to return a Result and add tests for the failure paths". The reviewable shape of completion is: the Agent states which files changed and why, gives the verification command it actually ran and its result, and the verification happened after the last change; layers that did not run stay unrun and are never described as complete.

### Success criteria

- `validate` reports installation consistency; the quick-layer `verify` runs and is recorded as `scopeStatus: partial`, with the deferred layers and the next-tier entry listed on the receipt.
- Completion claims bind to evidence produced after the verification; integration, release, or overall completion carries separate `--tier standard|deep` or `--full` evidence.
- A capability without evidence is never reported as active — for example, a host Hook that never fired is not described as intercepting, and a missing graph tool is reported as a fallback to source search.

## Micro in an installed project

Installation does not scan business code or create probes. First dry-run the upgrade, then use the original install options with `--write` and validate. Both `.agents/runtime/commands/run.mjs` and `.agents/runtime/lib/micro-runner.mjs` must be updated. Node 22+ and a Git worktree are required.

    pnpm vibe-harness install --project <项目绝对路径> --dry-run
    pnpm vibe-harness validate --project <项目绝对路径>

Declare a reviewed `validationCommands.micro` entry in the target project's config; for example, `scripts/probes/normalize.mjs` exports `default(args)`:

```json
[
  {
    "id": "normalize-example",
    "kind": "pure",
    "entry": "scripts/probes/normalize.mjs",
    "args": { "value": "example" },
    "costTier": "quick",
    "scopes": ["affected", "layer"],
    "maxDurationMs": 3000,
    "maxOutputBytes": 2048,
    "network": "deny",
    "workspaceWrite": "deny",
    "allowedEnv": []
  }
]
```

Run `node .agents/runtime/commands/run.mjs verify --project . --micro normalize-example --plan --json`, then omit `--plan` to execute. This requires Node 22+ and a Git worktree; legacy `command` entries are rejected by the installed runtime. Micro proves only a local observation, not task completion. Node permissions do not enforce network isolation for untrusted probes; see [Micro verification rules](docs/rules/micro-verification.md).

## Full capabilities (advanced)

One prompt installs the full profile, every stable tool plugin, the Linear read-write integration, and the memory assets across multiple hosts, so plugins, Linear, and hosts do not have to be selected one by one:

    Install Vibe-Harness with --preset everything into TARGET_PROJECT_ABSOLUTE_PATH for the codex, zcode, and opencode hosts. You are working from the Vibe-Harness repository and run:
    pnpm install
    pnpm vibe-harness init --project <TARGET_PROJECT_ABSOLUTE_PATH> --targets codex,zcode,opencode --preset everything
    pnpm vibe-harness install --project <TARGET_PROJECT_ABSOLUTE_PATH> --write --confirm-red-zone
    pnpm vibe-harness validate --project <TARGET_PROJECT_ABSOLUTE_PATH>
    pnpm vibe-harness doctor --project <TARGET_PROJECT_ABSOLUTE_PATH>
    Run init only when the target has no vibe-harness.config.json. I authorize this installation to write the project-scoped Hook and MCP red-zone configuration and to enable preview capabilities for zcode and opencode. everything already includes provision, so --provision is not needed. Write only inside the target project and do not modify global Agent, MCP, or Git configuration; report the actual writes and anything incomplete.

Equivalent commands:

```bash
pnpm install
pnpm vibe-harness init --project ../full-project --targets codex,zcode,opencode --preset everything
pnpm vibe-harness install --project ../full-project --dry-run
pnpm vibe-harness install --project ../full-project --write --confirm-red-zone
pnpm vibe-harness validate --project ../full-project
pnpm vibe-harness doctor --project ../full-project
```

`--preset everything` expands to full, the three managed runtime plugins, Linear read-write and memory. `--plugin all` selects only the three runtime plugins. Red-zone writes still require `--confirm-red-zone`.

```json
{
  "targets": ["codex", "zcode", "opencode"],
  "profile": "full",
  "preset": "everything"
}
```

## Quick start

Requires pnpm 10+ and Node.js 20.19+, 22.18+, or 24+.

From the Vibe-Harness repository, choose and copy one prompt below, replacing TARGET_PROJECT_ABSOLUTE_PATH with the absolute target project path. First identify every required host and put codex, claude, gemini, cursor, qoder, zcode, antigravity, or opencode in the single non-empty targets array. These prompts are for first-time installs; use the upgrade flow below for an existing installation.

In the prompts below, select every adapter the project actually uses and store them in one targets array; do not install separately per editor.

### minimal

    Install the Vibe-Harness minimal profile into TARGET_PROJECT_ABSOLUTE_PATH. You are working from the Vibe-Harness repository: first check the Node.js and pnpm versions and install this repository's dependencies; select the codex, claude, or gemini adapter for the current Agent host. If the target has no vibe-harness.config.json, initialize it with the selected adapter and minimal profile; if its configuration or existing install state does not match, stop and report the mismatch, and never use --force. Run an install dry-run first, inspect it for conflicts, out-of-project writes, or unexpected overwrites, and only then perform the install with --write. Finish with validate --project. The minimal install must not select optional plugins or create a code index. Write only inside the target project and do not modify global Agent, MCP, or Git configuration. Report actual writes, validation results, and anything incomplete.

### core (recommended)

    Install the core profile into TARGET_PROJECT_ABSOLUTE_PATH. Inspect the dry-run first; use --write only for approved project-local changes and --confirm-red-zone for red-zone writes. Do not use --force or change global configuration. codebase-memory-mcp is externally managed: install only its usage rules, not the tool, MCP configuration or index. Finish with validate and doctor.

### full

    Install the full profile into TARGET_PROJECT_ABSOLUTE_PATH. Inspect the dry-run first; use --write only for approved project-local changes and --confirm-red-zone for red-zone writes. Do not use --force or change global configuration. codebase-memory-mcp is externally managed: install only its usage rules, not the tool, MCP configuration or index. Finish with validate and doctor.

Core and full include the external codebase-memory-mcp usage rules without installing a tool. Equivalent core installation:

```bash
pnpm install
pnpm vibe-harness init --project ../some-project --target codex --profile core
pnpm vibe-harness install --project ../some-project --target codex --profile core --dry-run
pnpm vibe-harness install --project ../some-project --target codex --profile core --write --confirm-red-zone
pnpm vibe-harness validate --project ../some-project
pnpm vibe-harness verify --project ../some-project --plan
pnpm vibe-harness verify --project ../some-project --tier standard
pnpm vibe-harness verify --project ../some-project --full
pnpm vibe-harness doctor --project ../some-project
```

`validate` checks installation consistency only and runs no tests. Run configured project checks with:

```bash
pnpm vibe-harness verify --project ../some-project
```

Without `--tier`, `verify` runs the quick layer only; the layer commands come from `validationCommands.tiers` in the project's `vibe-harness.config.json` (when absent they are derived from package scripts, and only a project that yields nothing falls back to the changed-path `auto` risk plan). The quick layer is the default path, so the standard and deep layers must be requested explicitly: `--tier standard|deep` accumulates layers, and `--full` runs the complete matrix and is mutually exclusive with `--tier`. `--plan` only previews the plan — scope and cost layer, selected checks, the deferred `deferredChecks` with their next-tier entry `nextTier`, and unselected checks marked `not_selected` (unconfigured ones stay `not_configured`) — and executes nothing.

The three verdicts do not substitute for each other: `validate` proves installation consistency only, a quick `verify` proves the current work unit is not broken, and integration, release, or overall completion needs the matching `--tier standard|deep` or `--full` evidence; a quick-layer pass is recorded as `scopeStatus: partial`, so nothing may be reported as complete before the deferred layers carry evidence.

Verification JSON also includes the run ID, timestamps, and a non-persisted Git worktree fingerprint. A worktree change during checks returns PROJECT_VERIFICATION_STALE.

### Project-local deterministic scripts

The `core` and `full` profiles install a project-local command surface by default; `minimal` and `docs-only` do not. Mechanical fact collection and configured checks stay in the script, while the Agent chooses scope and explains results:

```bash
node .agents/runtime/commands/run.mjs env --project . --json
node .agents/runtime/commands/run.mjs context --project . --json
node .agents/runtime/commands/run.mjs changes --project . --json
node .agents/runtime/commands/run.mjs verify --project . --plan --json
node .agents/runtime/commands/run.mjs verify --project . --json
node .agents/runtime/commands/run.mjs worktree check --project . --strict --json
node .agents/runtime/commands/run.mjs slice --project . --file <path> --from <n>
node .agents/runtime/commands/run.mjs patch --project . --spec <spec.json>
```

`verify --plan` previews configured checks without executing them. The script has no arbitrary command option, does not edit configuration, and does not use the network. Commands come from `validationCommands` in `vibe-harness.config.json`; failures, timeouts, unsafe commands, and worktree changes during verification are reported explicitly. Cost tiers default to the fast path: without `--tier`, `verify` runs only the quick layer (it follows implementation and blocks the current work unit), and the standard and deep layers have to be asked for with `--tier standard|deep` or `--full` for the complete matrix. A passing quick-layer run reports `scopeStatus: partial` and lists the deferred checks plus the next layer, so it can never be read as integration, release, or overall completion.

`worktree`, `slice`, and `patch` are read-only by default. `worktree check` reports isolation units, merge-back state, dependency links, and the port registration facts plus a `cleanupAllowed` advisory. `worktree bootstrap` runs six steps (`worktree add` -> dependency links -> port block and env file -> declared envFiles -> declared setupCommands -> toolchain probe), prints the plan unless `--write` is passed, and additionally needs `--confirm-red-zone` when a target matches `hooks.redZonePaths`; ports are segmented by the main checkout's `.vibe-harness/worktree-ports.json` registry under the `.vibe-harness/worktree-ports.lock` exclusive lock, and a main checkout without `node_modules` ends the bootstrap as `blocked` instead of continuing silently. `worktree cleanup` only writes when `--write` is passed, refuses while a branch has not landed in `worktree.baseRef` or the worktree is dirty, and never deletes a branch. `worktree recover` clears crash residue — incomplete worktrees left by an interrupted bootstrap, prunable bindings whose directory is gone, and orphaned branches or port registrations with attribution evidence; it also only prints a plan unless `--write` is passed, and branch deletion stays behind the evidence gates for branches that never left the baseline. `slice` prints a line range; `patch` applies guarded range or sequence edits in memory and writes only after every operation passed. They replace inline `node -e` snippets and one-off scripts inside a project.

## Delivery lifecycle

New configurations default to `delivery.default: managed-mr` (squash). `--delivery local-land` selects local no-ff delivery; `inspect-only` prevents writes and verification execution. Existing configurations without delivery retain legacy behavior with a migration warning. Installation profiles and delivery profiles are independent.

Use the installed runtime's `task checkpoint`, `task event`, `runtime service start|status|stop`, and `worktree cleanup --receipt <file> --merge-evidence <file>` (or `--mr <iid>`). Mutations require `--write`. Cleanup requires current evidence, a clean source and matching target/patch identities; missing GitLab access stays blocked, while `runtime service stop` refuses a registration whose ownership cannot be proven. Worktree land/cleanup/recover only attempt service teardown: an unproven teardown is reported on the receipt and no longer blocks the removal. Host compaction/message events require a real bridge; shipping the command does not install a listener.

See [delivery lifecycle](docs/specs/delivery-lifecycle.md) for configuration and migration details.

## Multi-host installation

Install a project only once. The targets array declares every host. Without --target, install, upgrade, verify, validate, doctor, and diff process all targets. With --target, a command selects one host still present in configuration or install-state and never adds it implicitly.

Common rules, runtime, memory, and Evals have one shared owner at the project root. Host instructions, native Skills, MCP, and Hooks use adapter:id projection owners. Do not repeat installation in a project subdirectory to simulate multi-host support.

## Execution model

- Quick: read-only work, explanations, documentation, and tiny non-behavioral changes.
- Light: reversible local behavior changes with checks focused on the affected surface.
- Full: security, production, releases, data migration, public contracts, red-zone, irreversible, or cross-repository work with broader verification and rollback preparation.

A single Agent handles work by default. Explicit `open-code-review`, browser verification, Eval, and project test tools remain available. Task Markdown is an optional human-readable note and is not part of runtime decisions.

## Profiles and roles

The core profile installs eleven native Skills; full installs fourteen and enables seven role personas by default. The role system uses single-primary-role dynamic switching: each atomic action activates exactly one role and may stack at most one domain Skill; it is not a fixed seven-stage pipeline.

| Profile | Installed surface |
| --- | --- |
| `minimal` | Platform instructions, safety boundaries, Git/Test rules, and optional task/delivery templates |
| `core` | `minimal` plus common engineering rules, eleven native Skills, project-local deterministic scripts, and offline Eval |
| `full` | `core` plus three native Skills, online Eval, and supported platform safety Hooks, for fourteen native Skills total |
| `docs-only` | Rules, templates, and schemas without runtime, Skills, MCP, or Hooks |

Explicit delivery Skills use `Vb …` display names and `vb-…` invocation IDs:

| Display name | Invocation | Legacy trigger |
| --- | --- | --- |
| Vb Git Split Push | `$vb-git-split-push` | `$git-deliver` |
| Vb Git Develop Flow | `$vb-git-develop-flow` | `$gd-flow` |
| Vb Linear Worktree Develop | `$vb-linear-worktree-develop` | `$lwflow` |

Split Push reuses git-deliver: commit logical groups under the project's Git rules, then normally push the current branch after verification. It does not create worktrees or merge. Old names remain compatibility triggers; upgrades migrate managed Skill files and preserve locally edited copies as conflicts.

Invoke `$vb-git-develop-flow` explicitly to implement in an external worktree, then locally merge and push `develop`. With the writable Linear plugin installed, `$vb-linear-worktree-develop` first syncs the current plan as a parent/task DAG and executes only those newly created nodes. Neither adds a shell command nor changes the default delivery profile; an unclean primary checkout or unavailable write/Claim capability stops the flow.

External tools remain explicit `--plugin` choices. Every host configuration file is a red-zone write and requires `--confirm-red-zone`.

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
    "eval": null,
    "tiers": {
      "quick": [],
      "standard": [],
      "deep": []
    }
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
    "allowedEgressHosts": []
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

Managed runtime plugins are `chrome-devtools-mcp`, `playwright-cli`, and `open-code-review`. codebase-memory-mcp usage rules ship with common rules; the user or host manages the tool independently.

```bash
pnpm vibe-harness install --project ../some-project --target codex --profile core --plugin chrome-devtools-mcp --dry-run
pnpm vibe-harness install --project ../some-project --target codex --profile core --plugin chrome-devtools-mcp playwright-cli --write
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

- Existing project files are preserved unless `--force` is explicit. Project-owned managed seeds (`docs/memory/*`, `.agents/memory/*`) keep the project's drifted content, re-record it as the baseline, and are reported through `retainedProjectOwned` (`reason: project-owned-drift`) and the `PROJECT_OWNED_FILE_RETAINED` warning; drifted harness-owned files still fail closed with `Refusing to upgrade user-modified file`.
- Every mutation requires `--write`; red-zone writes require explicit confirmation.
- The installer does not modify global Agent configuration or `.git/config`.
- Codex, Cursor, Qoder, and ZCode Hooks normalize their `PreToolUse` and permission events through the same safety policy to block dangerous Git, global configuration writes, credential exfiltration, red-zone file uploads, out-of-project writes, and (when an `allowedEgressHosts` allowlist is configured) non-allowlisted network egress.
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
