# Cognis

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/shiyuan17/Cognis/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/shiyuan17/Cognis/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20.19%2B-339933?logo=node.js&logoColor=white)](package.json)
[![pnpm](https://img.shields.io/badge/pnpm-10%2B-F69220?logo=pnpm&logoColor=white)](package.json)

**Make AI coding end with evidence, not just a claim.**

Cognis gives Codex, Claude Code, and Gemini CLI a shared way to plan, execute, and verify work. It combines project instructions, task validation, status snapshots, and optional tools so an Agent can show what it changed and how the result was checked. Everything stays inside the project; Cognis does not change your global Agent settings.

> [!IMPORTANT]
> Cognis shows you what it plans to change before it writes anything. It does not replace existing files unless you use `--force`, and it asks for extra confirmation before changing sensitive Codex configuration.

## From Common AI Failures to Verifiable Work

| Common problem | What Cognis adds | What you get |
| --- | --- | --- |
| The Agent starts editing before it understands the task. | A five-step workflow and fast, lightweight, or full risk levels. | Small tasks stay quick; risky work starts with a plan and a rollback path. |
| The Agent says “done” without showing proof. | Task templates connect each acceptance criterion (`AC-ID`) to evidence, and the installed validator (automatic checker) checks completed tasks. | A completion claim can be checked against commands, artifacts, reviews, or manual confirmation. |
| Multiple Agents overwrite shared work or trust self-reported tests. | Version 2 parent/child task contracts define a flat DAG, write scopes, serial/parallel batches, merge-back state, and integrated validation. | Only independent child work runs in parallel; the parent Agent inspects the final diff and reruns checks in the target workspace. |
| Important coding context gets buried in prose. | Core, full, and docs-only profiles choose compact Markdown structures for complex requests and replies: checkbox todos, lists, comparison tables, and portable information blocks. | Simple answers stay short while plans, progress, evidence, and decisions remain easy to scan without altering code or command output. |
| Agent rules or skills change without behavioral regression evidence. | Eval-ID scenarios compare offline and real-Agent runs with an approved evaluation reference. | Prompt and governance changes can be reviewed against critical behavior, not only file snapshots. |
| A long task loses important context between sessions. | `baseline` records project, installation, tool, and verification status; project memory and handoff templates preserve decisions and known issues. | The next session can recover project facts without reconstructing everything from chat history. |
| Rules drift between AI coding tools. | Native project files and tested install levels (`profiles`) for Codex, Claude Code, and Gemini CLI. | Each tool gets the same core working rules in the format it actually supports. |
| Installing or updating shared rules feels risky. | Dry-run previews, clearly marked sections, backups, validation, safe uninstall, and rollback. | You can inspect changes before writing and reverse managed changes without replacing unrelated project content. |
| Useful coding tools are scattered or configured globally. | Explicit `--plugin` selection installs pinned tools inside the project; Agentmemory remains preview while its dependency advisories are unresolved. | Code understanding, browser checks, diagnostics, review, and memory stay project-local without making every `full` install download tools. |

## Why Not Just Write an AGENTS.md?

An `AGENTS.md` file can tell an Agent how to work, but it does not install versioned rules and skills, validate task evidence, record project status, or safely update and remove its own files. Cognis uses the platform instruction file as the entry point, then adds automatic checks and safe file management around it. Your existing content stays editable because Cognis updates only its clearly marked section.

## Quick Start

You need pnpm `10` or later and one of these Node.js versions: `20.19+`, `22.18+`, or `24+`.

```bash
pnpm install
pnpm cognis init --project ../some-project --target codex
pnpm cognis install --project ../some-project --target codex --profile core --dry-run
pnpm cognis install --project ../some-project --target codex --profile core --write
pnpm cognis validate --project ../some-project
```

These commands do four things:

1. Create a Cognis configuration file in the target project.
2. Preview the files Cognis wants to install.
3. Install the `core` setup after you review the preview.
4. Check that the installation is complete and unchanged.

`install` writes governance assets only. Preview and provision project-local tools separately:

```bash
pnpm cognis provision --project ../some-project --target codex --profile full --dry-run
pnpm cognis provision --project ../some-project --target codex --profile full --write
```

`install --provision` keeps the one-command compatibility path. If a write is interrupted, `recover --project <project>` previews the active transaction and `recover --project <project> --write` restores its preimages.

## Supported AI Coding Tools

| Tool | Main project file | Available install levels | What Cognis can add |
| --- | --- | --- | --- |
| Codex | `AGENTS.md` | `minimal`, `core`, `full`, `docs-only` | Instructions, skills, project tools through MCP, and automatic checks through hooks |
| Claude Code | `CLAUDE.md` | `minimal`, `core`, `docs-only`; `full` preview | Project instructions and skills; experimental full mappings require `--allow-preview` |
| Gemini CLI | `GEMINI.md` | `minimal`, `core`, `docs-only`; `full` preview | Project instructions and skills; experimental full mappings require `--allow-preview` |

MCP lets an Agent call tools that belong to the current project. Hooks run checks automatically at specific points in an Agent session. Cognis currently installs these features only for Codex.

Claude Code and Gemini CLI keep `full` behind `--allow-preview`. The report lists preview and missing capabilities so incomplete platform mappings are never presented as stable.

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

For multi-Agent work, keep one Markdown file per task under `docs/tasks/`. New tasks use control version 2. Only the parent Agent dispatches children and updates task state; children cannot delegate again. `doctor` reports legacy v1 parent/child contracts without making them invalid, while `--verbose` reveals the paths that should be migrated.

## Choose an Install Level

An install level, called a `profile` in commands and configuration, is a ready-made group of Cognis files and features.

| Profile | What you get | Best for |
| --- | --- | --- |
| `minimal` | The main Agent instruction file, hard boundaries, Git and test rules, and version 2 task templates | Small projects that want basic guidance without extra skills or tools |
| `core` | Everything in `minimal`, plus common engineering rules, v1/v2 task and graph checks, Red Team completion review, and routing skills | Most projects; this is the recommended starting point |
| `full` | Everything in `core`, plus the multi-Agent execution skill, project memory, advanced workflow skills, online evaluation assets, and Codex hooks | Long-running or high-risk Codex projects |
| `docs-only` | Instructions, reusable rules, version 2 templates, and schemas, without executable runtime, skills, MCP, or hooks | Projects that only want the documentation-based setup |
The exact files included in each profile are defined in `manifests/profiles.json`.

## More Commands

<details>
<summary><strong>Standard project installation</strong></summary>

This is the installation method most users should choose. Use `--project` for the project folder, `--target` for the AI coding tool, and `--write` only after you have reviewed the preview.

```bash
# Create the project configuration
pnpm cognis init --project ../some-project --target codex

# Preview first, then install
pnpm cognis install --project ../some-project --target codex --profile core --dry-run
pnpm cognis install --project ../some-project --target codex --profile core --write

# Check that the installation is still valid
pnpm cognis validate --project ../some-project
```

By default, commands return compact JSON that scripts can read. Add `--output summary` for a short report written for people. Add `--verbose` when you need the full file preview and complete diagnostic paths.

Use the same target in both `init` and `install` when installing for Claude Code or Gemini CLI:

```bash
pnpm cognis init --project ../claude-project --target claude
pnpm cognis install --project ../claude-project --target claude --profile core --write

pnpm cognis init --project ../gemini-project --target gemini
pnpm cognis install --project ../gemini-project --target gemini --profile core --write
```

</details>

<details>
<summary><strong>Project settings</strong></summary>

Most users only need to review this file after running `init`. Cognis creates `cognis.config.json`, where you can choose the install level, list project checks, and identify sensitive areas.

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
    "governance": "node .agents/cognis/governance/validate.mjs",
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

The `target` value must match the `--target` option you use later. Cognis reads the target project but does not change its `package.json`.

</details>

<details>
<summary><strong>Run evaluation-driven development checks</strong></summary>

```bash
pnpm cognis eval check --project ../some-project
pnpm cognis eval run --project ../some-project --mode offline
pnpm cognis eval run --project ../some-project --mode offline --write
```

An evaluation `reference` is separate from the project `baseline`. Updating it requires `eval reference --write --confirm-reference-update`; Cognis never promotes a reference automatically. See [Evaluation-driven development](docs/evals.md).

</details>

<details>
<summary><strong>Enable project-local tool plugins</strong></summary>

No profile installs external tool plugins by default. `--plugin` adds tools to the selected profile without replacing its governance, memory, skills, or hooks:

```bash
# Enable one plugin
pnpm cognis install --project ../some-project --target codex --profile core --plugin -rtk --dry-run

# Enable multiple plugins
pnpm cognis install --project ../some-project --target codex --profile core --plugin -rtk ast-grep --write

# Enable all plugins, including preview Agentmemory
pnpm cognis install --project ../some-project --target codex --profile full --plugin -all --dry-run --allow-preview

# Clear a plugin selection persisted by an earlier install
pnpm cognis install --project ../some-project --target codex --profile core --plugin none --write
```

Public plugin names are `rtk`, `ast-grep`, `codebase-memory-mcp`, `chrome-devtools-mcp`, `playwright-cli`, `open-code-review`, and `agentmemory`. `all` expands to all seven. One leading `-` is accepted for the requested command style, comma-separated values and repeated `--plugin` options are also accepted, and duplicate or unknown names are rejected. Selecting Agentmemory for installation or provisioning requires `--allow-preview`.

CLI selection takes precedence over `plugins` in `cognis.config.json`, which takes precedence over the selection saved in `.cognis/install-state.json`. Later install, validate, doctor, baseline, provision, rollback, and uninstall operations reuse that saved selection. Reports expose the canonical module ids in `requestedPlugins` and the complete dependency closure in `resolvedModules`.

</details>

<details>
<summary><strong>Choose individual features</strong></summary>

This is an advanced replacement interface for users who do not want one of the ready-made profiles. Unlike `--plugin`, `--modules` replaces the profile module set. You can list individual modules in `cognis.config.json` or pass them to a single install command:

```bash
pnpm cognis install --project ../some-project --target codex --profile core --modules agents,rules,skills --dry-run
pnpm cognis install --project ../some-project --target codex --profile core --modules agents,rules,skills --write
```

Available modules are `agents`, `rules`, `templates`, `governance`, `skills`, `memory`, `playwright`, `chrome-devtools`, `codebase-memory`, `open-code-review`, `agentmemory`, `rtk`, `ast-grep`, and `hooks`. Cognis automatically adds required dependencies. The command report shows the replacement request, final installation, and added dependencies as `requestedModules`, `resolvedModules`, and `implicitModules`.

</details>

<details>
<summary><strong>Check a project and create a status snapshot</strong></summary>

Use these commands after installation. `validate` checks the Cognis files, `verify` runs your project's configured checks, and `baseline` creates a snapshot of the current project and installation status.

```bash
# Check Cognis configuration and installed files; do not run project commands
pnpm cognis validate --project ../some-project

# Run the configured governance, lint, and typecheck commands
pnpm cognis verify --project ../some-project

# Preview or save a project status snapshot
pnpm cognis baseline --project ../some-project --dry-run
pnpm cognis baseline --project ../some-project --write

# Run project checks and include a safe summary in the snapshot
pnpm cognis baseline --project ../some-project --verify --write
```

If a configured check requires a person to complete it, `verify` stops unless you explicitly add `--allow-manual`. A baseline records useful status information, but it does not save source code, credentials, absolute project paths, or raw command output.

</details>

<details>
<summary><strong>Remove Cognis safely</strong></summary>

Use these commands to preview and then remove a standard project installation:

```bash
pnpm cognis uninstall --project ../some-project --target codex --dry-run
pnpm cognis uninstall --project ../some-project --target codex --write
```

Cognis removes only files that it installed and that have not been changed. It also removes only its own marked sections from shared instruction and MCP files. Your configuration, status snapshots, backups, unrelated documents, and edited files stay in place.

</details>

<details>
<summary><strong>Migrate an older Codex installation</strong></summary>

The old profile names and command format have been removed. For a project that still has an older install state, run standard init first. Cognis normalizes the state to `full` or `minimal`, and the standard upgrade writes back the canonical profile.

```bash
pnpm cognis init --project ../some-project
pnpm cognis install --project ../some-project --target codex --profile full --dry-run --upgrade
pnpm cognis install --project ../some-project --target codex --profile full --write --upgrade --confirm-red-zone
pnpm cognis validate --project ../some-project
pnpm cognis doctor --project ../some-project
```

`--target` now selects only the adapter and never accepts a project path. All mutations use `--write`.

</details>

<details>
<summary><strong>Built-in tools and command status</strong></summary>

This section helps when an install or health check reports a problem. `core` and `full` install no external tool plugins by default. Enable RTK, ast-grep, codebase-memory-mcp, Chrome DevTools MCP, Playwright CLI, Open Code Review, or Agentmemory with `--plugin`; `--plugin -all --allow-preview` selects all seven.

Cognis writes MCP settings only to its own marked section in the project's `.codex/config.toml`. It reads credentials from the current terminal session and never saves them in the project.

The `chrome-devtools` module pins `chrome-devtools-mcp@1.6.0` and starts the project-local entry with system Google Chrome in headless isolated mode. It disables usage statistics, update checks, and CrUX enrichment, redacts network headers, does not forward arbitrary command arguments, and never connects to a personal Chrome profile or remote debugging port. Provisioning calls `list_pages` as a real browser smoke check; a missing or failed Chrome launch is reported as `CHROME_LAUNCH_FAILED` without persisting pages, headers, response bodies, credentials, or the raw process environment.

Open Code Review resolves its endpoint in this order: a complete `OCR_LLM_URL` + `OCR_LLM_TOKEN` + `OCR_LLM_MODEL` set, the active provider in the current user's `~/.opencodereview/config.json`, compatible `ANTHROPIC_*` or `OPENAI_*` environment variables, and finally the current Codex provider in `~/.codex/config.toml`. The selected values are passed only to the Open Code Review child process. They are never written to `cognis.config.json`, `.cognis/tool-state`, or MCP configuration. Missing or incomplete settings remain `pending-config` with a redacted diagnostic.

Codebase-memory indexing is project-scoped. Cognis sets `CBM_ALLOWED_ROOT` and the child process working directory to the target project, then sends `--repo-path .` when indexing that root. This keeps ASCII, spaced, and Unicode Windows paths on the same path-validation route. A root-boundary failure is reported as `INDEX_PATH_OUTSIDE_ALLOWED_ROOT`; a corrupt local cache is cleared and rebuilt on the next provision attempt, and a repeated failure is reported as `INDEX_CORRUPT_REINDEX_REQUIRED`. `index_status` must still confirm `ready`, the target root, and non-negative node and edge counts.

RTK `v0.43.0` is downloaded from a pinned official release asset and SHA-256 verified before the project-local wrapper can run it. ast-grep uses the pinned `@ast-grep/cli@0.44.1` lockfile and exposes both `sg` and `ast-grep`. RTK is preferred for high-volume, non-sensitive command output; ast-grep is preferred for structural code searches. If either tool is `pending`, `degraded`, or `unsupported`, use the documented original-command or `rg` fallback and record the limitation.

Install, validate, and doctor use the same health status values:

| Status | Exit code | What it means |
| --- | --- | --- |
| `ready` | `0` | Governance assets are valid and no attempted provisioning has failed; selected tools not yet provisioned remain visible as `pending` or `pending-config` warnings. |
| `invalid` | `1` | The configuration or installed files do not match what Cognis expects. |
| `degraded` | `2` | A required tool, credential, or feature is not currently available. |

`--allow-degraded` changes the exit code to `0` for automation, but it does not hide the problem. The report still contains `ok: false`, `status: "degraded"`, warnings, and recommended next steps. `pending` and `pending-config` do not fail an asset-first install; an attempted provisioning failure or an incomplete provisioning process marker does degrade health.

Individual tools additionally report `pending`, `ready`, `degraded`, or `unsupported`; `unsupported` means no verified release asset exists for the current platform and the documented fallback must be used.

Before the first provision attempt, Cognis computes `pending` or `unsupported` from the selected plugins and current platform without writing state. A real provision records each attempted tool's version, platform, package source, start and finish times, result, and redacted log summary in `.cognis/tool-state/tools.json`. Install, validate, doctor, baseline, and summary output show the current computed or persisted state. Failure diagnostics include the failed phase, stable code, exit code when available, and bounded output tails. Project paths and credential-like values are redacted; raw command environments and full output are never stored. Interrupted provisioning leaves `.cognis/tool-state/provisioning.json`; `doctor` reports and degrades on it without modifying the environment.

Maintainers run `pnpm runtime:audit` against the same dependency surface used by provisioning. Critical or High findings and unavailable audits fail the command; Moderate findings remain visible warnings. Agentmemory excludes optional dependencies during both provisioning and the enforced audit.

</details>

## What Cognis Will and Will Not Change

- It writes only inside the target project, never to user-level or global Agent settings.
- It does not replace an existing file unless you use `--force`. When replacement is necessary, it creates a backup first.
- In shared instruction and Codex MCP files, it updates only the clearly marked section that belongs to Cognis.
- It does not change `.git/config`. Packaged Git hooks work only after you explicitly set `core.hooksPath` for that repository.
- It treats `.codex/` configuration as a sensitive area. A real Codex `full` or internal install must include `--confirm-red-zone` before changing it.
- It keeps private project names, contracts, personal paths, and task data out of reusable shared files.

## Learn More

- [Documentation index](docs/README.md)
- [How Cognis is organized](docs/architecture.md)
- [How to move from an older version](docs/migration-guide.md)
- [How automatic hooks work](docs/hooks.md)
- [What changed between versions](CHANGELOG.md)
- [Minimal project example](examples/minimal-project/README.md)
- [Contributing](CONTRIBUTING.md)

## Checks for Contributors

The Chinese [contribution guide](CONTRIBUTING.md) is the source of truth for change classification, documentation impact, verification, pull requests, and releases. `AGENTS.md` keeps the mandatory Agent command quick reference.

## License

[MIT](LICENSE)
