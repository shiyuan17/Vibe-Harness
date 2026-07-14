# LoopEngine

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/shiyuan17/LoopEngine/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/shiyuan17/LoopEngine/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20.19%2B-339933?logo=node.js&logoColor=white)](package.json)
[![pnpm](https://img.shields.io/badge/pnpm-10%2B-F69220?logo=pnpm&logoColor=white)](package.json)

**Make AI coding end with evidence, not just a claim.**

LoopEngine gives Codex, Claude Code, and Gemini CLI a shared way to plan, execute, and verify work. It combines project instructions, task validation, status snapshots, and optional tools so an Agent can show what it changed and how the result was checked. Everything stays inside the project; LoopEngine does not change your global Agent settings.

> [!IMPORTANT]
> LoopEngine shows you what it plans to change before it writes anything. It does not replace existing files unless you use `--force`, and it asks for extra confirmation before changing sensitive Codex configuration.

## From Common AI Failures to Verifiable Work

| Common problem | What LoopEngine adds | What you get |
| --- | --- | --- |
| The Agent starts editing before it understands the task. | A five-step workflow and fast, lightweight, or full risk levels. | Small tasks stay quick; risky work starts with a plan and a rollback path. |
| The Agent says “done” without showing proof. | Task templates connect each acceptance criterion (`AC-ID`) to evidence, and the installed validator (automatic checker) checks completed tasks. | A completion claim can be checked against commands, artifacts, reviews, or manual confirmation. |
| Agent rules or skills change without behavioral regression evidence. | Eval-ID scenarios compare offline and real-Agent runs with an approved evaluation reference. | Prompt and governance changes can be reviewed against critical behavior, not only file snapshots. |
| A long task loses important context between sessions. | `baseline` records project, installation, tool, and verification status; project memory and handoff templates preserve decisions and known issues. | The next session can recover project facts without reconstructing everything from chat history. |
| Rules drift between AI coding tools. | Native project files and tested install levels (`profiles`) for Codex, Claude Code, and Gemini CLI. | Each tool gets the same core working rules in the format it actually supports. |
| Installing or updating shared rules feels risky. | Dry-run previews, clearly marked sections, backups, validation, safe uninstall, and rollback. | You can inspect changes before writing and reverse managed changes without replacing unrelated project content. |
| Useful coding tools are scattered or configured globally. | Codex `full` prepares codebase indexing, Playwright, Open Code Review, and Agentmemory inside the project. | Code understanding, browser checks, review, and memory stay project-local; unavailable tools are reported as `degraded`. |

## Why Not Just Write an AGENTS.md?

An `AGENTS.md` file can tell an Agent how to work, but it does not install versioned rules and skills, validate task evidence, record project status, or safely update and remove its own files. LoopEngine uses the platform instruction file as the entry point, then adds automatic checks and safe file management around it. Your existing content stays editable because LoopEngine updates only its clearly marked section.

## Quick Start

You need pnpm `10` or later and one of these Node.js versions: `20.19+`, `22.18+`, or `24+`.

```bash
pnpm install
pnpm loopengine init --project ../some-project --target codex
pnpm loopengine install --project ../some-project --target codex --profile core --dry-run
pnpm loopengine install --project ../some-project --target codex --profile core --write
pnpm loopengine validate --project ../some-project
```

These commands do four things:

1. Create a LoopEngine configuration file in the target project.
2. Preview the files LoopEngine wants to install.
3. Install the `core` setup after you review the preview.
4. Check that the installation is complete and unchanged.

## Supported AI Coding Tools

| Tool | Main project file | Available install levels | What LoopEngine can add |
| --- | --- | --- | --- |
| Codex | `AGENTS.md` | `minimal`, `core`, `full`, `docs-only` | Instructions, skills, project tools through MCP, and automatic checks through hooks |
| Claude Code | `CLAUDE.md` | `minimal`, `core`, `docs-only` | Project instructions and skills |
| Gemini CLI | `GEMINI.md` | `minimal`, `core`, `docs-only` | Project instructions and skills |

MCP lets an Agent call tools that belong to the current project. Hooks run checks automatically at specific points in an Agent session. LoopEngine currently installs these features only for Codex.

Codex also supports the older compatibility names `codex-minimal` and `codex-internal`. Claude Code and Gemini CLI do not support the `full` level. If you request it, LoopEngine stops and recommends `core` instead of pretending that MCP and hooks are available.

## How the Workflow Works

```text
Understand the task -> Choose an approach -> Make the change -> Check the result -> Report what happened
```

| Workflow | When to use it | What the Agent must do |
| --- | --- | --- |
| Fast | Reading, documentation, and other low-risk work | Confirm the facts, then give a clear answer with evidence. |
| Lightweight | A small change in a clearly defined area | State which files may change and how the result will be checked. |
| Full | Security, releases, sensitive configuration, public APIs, cross-layer changes, or multi-Agent work | Plan before editing, keep a rollback path, and obtain an approved independent Red Team review packet before completion. |

If the risk is unclear, use the full workflow.

## Choose an Install Level

An install level, called a `profile` in commands and configuration, is a ready-made group of LoopEngine files and features.

| Profile | What you get | Best for |
| --- | --- | --- |
| `minimal` | The main Agent instruction file, basic working rules, Git and test rules, and task templates | Small projects that want basic guidance without extra skills or tools |
| `core` | Everything in `minimal`, plus common engineering rules, task checks, Red Team completion review, routing skills, and Playwright prepared for on-demand use | Most projects; this is the recommended starting point |
| `full` | Everything in `core`, plus project memory, advanced workflow skills, four project tools, Codex MCP setup, and Codex hooks | Long-running or high-risk Codex projects |
| `docs-only` | Instructions, reusable rules, templates, and schemas, without executable tools, skills, MCP, or hooks | Projects that only want the documentation-based setup |
| `codex-internal` | The same features as `full`, installed with the older Codex command format | Existing internal Codex installations only |

The exact files included in each profile are defined in `manifests/profiles.json`. `codex-minimal` remains available for projects that already use the older minimal Codex profile name.

## More Commands

<details>
<summary><strong>Standard project installation</strong></summary>

This is the installation method most users should choose. Use `--project` for the project folder, `--target` for the AI coding tool, and `--write` only after you have reviewed the preview.

```bash
# Create the project configuration
pnpm loopengine init --project ../some-project --target codex

# Preview first, then install
pnpm loopengine install --project ../some-project --target codex --profile core --dry-run
pnpm loopengine install --project ../some-project --target codex --profile core --write

# Check that the installation is still valid
pnpm loopengine validate --project ../some-project
```

By default, commands return compact JSON that scripts can read. Add `--output summary` for a short report written for people. Add `--verbose` when you need the full file preview and complete diagnostic paths.

Use the same target in both `init` and `install` when installing for Claude Code or Gemini CLI:

```bash
pnpm loopengine init --project ../claude-project --target claude
pnpm loopengine install --project ../claude-project --target claude --profile core --write

pnpm loopengine init --project ../gemini-project --target gemini
pnpm loopengine install --project ../gemini-project --target gemini --profile core --write
```

</details>

<details>
<summary><strong>Project settings</strong></summary>

Most users only need to review this file after running `init`. LoopEngine creates `loopengine.config.json`, where you can choose the install level, list project checks, and identify sensitive areas.

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
    "governance": "node .agents/loopengine/governance/validate.mjs",
    "eval": null
  },
  "evaluations": {
    "enabled": false,
    "suites": [],
    "reference": "evals/references/project.json",
    "thresholds": { "criticalPassRate": 1, "overallScore": 0.9, "maxCapabilityRegression": 0.05 },
    "onlineRunner": null,
    "repetitions": 3
  },
  "governance": { "mode": "basic" },
  "hooks": {
    "mode": "guarded",
    "completionGate": "advisory"
  },
  "riskZones": {
    "red": ["auth", "global request layer", "ci/cd", "env"],
    "yellow": ["shared components", "stores", "routing", "request clients"]
  },
  "crossRepo": { "enabled": false, "backendRepo": "" },
  "projectRules": { "mode": "auto", "overrides": {} },
  "memory": { "enabled": true, "path": ".agents/memory" }
}
```

The `target` value must match the `--target` option you use later. LoopEngine reads the target project but does not change its `package.json`.

</details>

<details>
<summary><strong>Run evaluation-driven development checks</strong></summary>

```bash
pnpm loopengine eval check --project ../some-project
pnpm loopengine eval run --project ../some-project --mode offline
pnpm loopengine eval run --project ../some-project --mode offline --write
```

An evaluation `reference` is separate from the project `baseline`. Updating it requires `eval reference --write --confirm-reference-update`; LoopEngine never promotes a reference automatically. See [Evaluation-driven development](docs/evals.md).

</details>

<details>
<summary><strong>Choose individual features</strong></summary>

This is an advanced option for users who do not want one of the ready-made profiles. You can list individual modules in `loopengine.config.json` or pass them to a single install command:

```bash
pnpm loopengine install --project ../some-project --target codex --profile core --modules agents,rules,skills --dry-run
pnpm loopengine install --project ../some-project --target codex --profile core --modules agents,rules,skills --write
```

Available modules are `agents`, `rules`, `templates`, `governance`, `skills`, `memory`, `playwright`, `codebase-memory`, `open-code-review`, `agentmemory`, and `hooks`. LoopEngine automatically adds any required dependencies. The command report shows what you requested, what will be installed, and which dependencies were added as `requestedModules`, `resolvedModules`, and `implicitModules`.

</details>

<details>
<summary><strong>Check a project and create a status snapshot</strong></summary>

Use these commands after installation. `validate` checks the LoopEngine files, `verify` runs your project's configured checks, and `baseline` creates a snapshot of the current project and installation status.

```bash
# Check LoopEngine configuration and installed files; do not run project commands
pnpm loopengine validate --project ../some-project

# Run the configured governance, lint, and typecheck commands
pnpm loopengine verify --project ../some-project

# Preview or save a project status snapshot
pnpm loopengine baseline --project ../some-project --dry-run
pnpm loopengine baseline --project ../some-project --write

# Run project checks and include a safe summary in the snapshot
pnpm loopengine baseline --project ../some-project --verify --write
```

If a configured check requires a person to complete it, `verify` stops unless you explicitly add `--allow-manual`. A baseline records useful status information, but it does not save source code, credentials, absolute project paths, or raw command output.

</details>

<details>
<summary><strong>Remove LoopEngine safely</strong></summary>

Use these commands to preview and then remove a standard project installation:

```bash
pnpm loopengine uninstall --project ../some-project --target codex --dry-run
pnpm loopengine uninstall --project ../some-project --target codex --write
```

LoopEngine removes only files that it installed and that have not been changed. It also removes only its own marked sections from shared instruction and MCP files. Your configuration, status snapshots, backups, unrelated documents, and edited files stay in place. Standard uninstall uses `--write`, not the older `--apply` option.

</details>

<details>
<summary><strong>Older Codex installation method</strong></summary>

Only existing `codex-internal` users need this section. This older command format uses `--target` for the project folder and `--apply` to write files. It is available only for Codex.

```bash
pnpm loopengine install --target ../some-project --profile codex-internal --dry-run
pnpm loopengine install --target ../some-project --profile codex-internal --apply --confirm-red-zone
pnpm loopengine validate --target ../some-project --profile codex-internal
pnpm loopengine doctor --target ../some-project

pnpm loopengine diff --target ../some-project --profile codex-internal
pnpm loopengine install --target ../some-project --profile codex-internal --apply --upgrade --confirm-red-zone
pnpm loopengine rollback --target ../some-project --dry-run
pnpm loopengine rollback --target ../some-project --apply --confirm-red-zone
```

Do not use `--project` and `--apply` in the same installation flow. Standard installations use `--project` with `--write`; older internal installations use `--target <project-folder>` with `--apply`.

</details>

<details>
<summary><strong>Built-in tools and command status</strong></summary>

This section helps when an install or health check reports a problem. The `core` profile prepares Playwright for browser checks when it is first needed. Codex `full` and `codex-internal` also prepare `codebase-memory-mcp`, Open Code Review, and Agentmemory.

LoopEngine writes MCP settings only to its own marked section in the project's `.codex/config.toml`. It reads credentials from the current terminal session and never saves them in the project.

Install, validate, and doctor use the same three status values:

| Status | Exit code | What it means |
| --- | --- | --- |
| `ready` | `0` | The installation and its required tools are ready to use. |
| `invalid` | `1` | The configuration or installed files do not match what LoopEngine expects. |
| `degraded` | `2` | A required tool, credential, or feature is not currently available. |

`--allow-degraded` changes the exit code to `0` for automation, but it does not hide the problem. The report still contains `ok: false`, `status: "degraded"`, warnings, and recommended next steps.

For a degraded project tool, LoopEngine stores the latest safe diagnostic in `.loopengine/tool-state/tools.json` and shows it in install, validate, doctor, and summary output. Diagnostics include the failed phase, stable code, exit code when available, and bounded output tails. Project paths and credential-like values are redacted; raw command environments and full output are never stored.

</details>

## What LoopEngine Will and Will Not Change

- It writes only inside the target project, never to user-level or global Agent settings.
- It does not replace an existing file unless you use `--force`. When replacement is necessary, it creates a backup first.
- In shared instruction and Codex MCP files, it updates only the clearly marked section that belongs to LoopEngine.
- It does not change `.git/config`. Packaged Git hooks work only after you explicitly set `core.hooksPath` for that repository.
- It treats `.codex/` configuration as a sensitive area. A real Codex `full` or internal install must include `--confirm-red-zone` before changing it.
- It keeps private project names, contracts, personal paths, and task data out of reusable shared files.

## Learn More

- [How LoopEngine is organized](docs/architecture.md)
- [How to move from an older version](docs/migration-guide.md)
- [How automatic hooks work](docs/hooks.md)
- [What changed between versions](CHANGELOG.md)
- [Minimal project example](examples/minimal-project/README.md)

## Checks for Contributors

```bash
pnpm check
pnpm test:integration
pnpm smoke:lifecycle
git diff --check
```

`pnpm check` runs linting, package validation, and the local test suite. Changes to the installer, profiles, runtime, or built-in tools must also pass the integration and lifecycle smoke checks shown above.

## License

[MIT](LICENSE)
