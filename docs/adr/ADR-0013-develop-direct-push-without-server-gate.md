---
id: ADR-0013
title: Develop accepts direct local landings without a server gate
status: accepted
date: 2026-10-11
review-date: 2026-11-08
owner: vibe-harness-maintainers
decision-makers: [vibe-harness-maintainers]
consulted: []
informed: []
supersedes: [ADR-0009]
superseded-by: null
---

# Develop accepts direct local landings without a server gate

## Context and Problem Statement

`develop` 是日常集成分支，也是本仓库任务 worktree 的默认落地目标。ADR-0009 要求 `develop` 消费稳定的 `merge-gate` required check，而 `worktree land` 又把 `develop` 列在受保护分支里、拒绝把任务分支合并进去。这套组合在单维护者、单宿主环境里不可用：服务器端 required check 需要维护 ruleset，本地 land 入口却又主动挡住 `develop`，结果只能人肉在 GitHub 上点合并，或让 land 直接失败。是继续要求服务器端门禁、把质量责任留在远端，还是取消 `develop` 的服务器门禁、把责任前移到本地 land 的验证阶段，需要一个明确决策。

## Decision Drivers

- 让 `develop` 成为可被本地 `worktree land` 以 no-ff 方式直接落地的集成分支，不依赖服务器端 required gate。
- 保留真正的保护目标：`main`、`master`、`release/*` 仍受保护，land 与 `$git-deliver` 都不得直落。
- 保持一次落地仍可验证：候选 no-ff 合并 + 验证、锚点单元全 done、目标与来源 HEAD 未漂移。
- 放宽只读与同步类 Git 命令的判定，但不放开破坏性命令。

## Considered Options

- 维持 ADR-0009：`develop` 继续要求服务器端 required fast gate，land 继续拒绝 `develop`。
- 取消 `develop` 的服务器门禁，把质量责任放到本地 land 的候选合并验证与提交前检查。
- 放弃 `develop`，改用只保留 `main` 的单主干模型。

## Decision Outcome

选定方案：**取消 `develop` 的服务器端 required gate，并允许 land 直落 `develop`**。`develop` 从人工审批与受保护分支清单中移出：`worktree land` 的受保护目标正则收窄为 `main|master|release*`，`develop` 通过一份显式白名单被允许，且目标拒绝与「建跟踪推送」两处共用同一个 `isLandProtectedBranch` 判断源。配套地，`git fetch`、`git ls-remote`、`git stash list`、`git submodule status` 与带 `--ff-only` 的 `git pull` 被 hook 判为只读/同步，裸 `git pull` 为 `workspaceWrite`。ADR-0009 因此被本决策取代。

## Consequences

- 任务分支可用 `worktree land --delivery local-land --write --push` 以 no-ff 方式直接落回 `develop`，无需 MR 往返。
- 质量责任前移到本地 land 的候选合并验证与提交前检查（`check:fast` / `check`）；`develop` 不再有服务器端 required check 兜底，回归依赖本地验证与后续发布门禁发现。
- `main`、`master`、`release/*` 仍受保护，land 与 `$git-deliver` 均拒绝直落，`release-please` 仍以 `main` 为目标。
- 直接同步类命令（`pull --ff-only`）只在跟踪工作区干净时才放行，脏工作区仍被拒（`VIBE_HARNESS_SYNC_DIRTY_TREE`）。

## Confirmation

- `runtime/commands/run.mjs` 的 `isLandProtectedBranch` 是目标拒绝与建跟踪推送的同一判断源，组件/集成测试覆盖「`develop` 允许、`main`/`release*` 拒绝」。
- `tests/integration/hook-runtime.test.js` 与 `tests/component/hook-read-only-classification.test.js` 覆盖同步类命令的 allow/deny 与 `workspaceWrite` 分级。
- `docs/github-delivery.md`、`docs/rules/git-rules.md`、`docs/rules/linear-workflow.md`、`CONTRIBUTING.md` 与本 ADR 保持同一口径，`pnpm docs:audit` 与规则一致性检查通过。

## Review Trigger

当 `develop` 出现回归逃逸、land 落地后的验证失败率上升，或仓库重新引入服务器端 `develop` 门禁时复审；也可在连续一个发布周期后按逃逸率与 revert 率复核。

## More Information

- `docs/adr/ADR-0009-develop-required-fast-gate.md`（被本决策取代）
- `docs/rules/git-rules.md`
- `docs/github-delivery.md`
- `runtime/commands/run.mjs`
- `runtime/hooks/codex-hook.mjs`
