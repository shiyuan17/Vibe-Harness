---
id: ADR-0014
title: Worktree 落地与清理的服务 teardown 改为 best-effort
status: accepted
date: 2026-10-12
review-date: 2026-11-09
owner: vibe-harness-maintainers
decision-makers: [vibe-harness-maintainers]
consulted: []
informed: []
supersedes: []
superseded-by: null
---

# Worktree 落地与清理的服务 teardown 改为 best-effort

## Context and Problem Statement

`runtime service start|status|stop` 让 Agent 在 worktree 内启动声明式服务，并在主检出的 `.vibe-harness/processes.json` 里登记归属。此前 `worktree land`、`worktree cleanup` 与 `worktree recover` 在工作区移除前调用 `teardownServices`，只要 teardown 不能证明停止（supervisor 不可达、归属字段漂移等），就整条命令 blocked。该门禁把「一个无法立即核实的服务」升级为「已合并的分支不能落地、已完成的 worktree 不能移除」，而失败原因通常与本次交付无关；它同时是一处只有规则文档描述、命令行帮助之外不可见的隐藏阻塞点。

## Decision Drivers

- 服务归属证明是安全边界，但只应由显式 `runtime service stop` 承担 fail-closed 判定。
- 已通过验证与门禁的合并落地不应被不相关进程的归属证明拖住。
- 停止服务仍是有价值的前置动作：进程退出时会向 worktree 写回状态，越早停止越少脏数据。
- 被删除的工作区里残留进程会让操作者看到真实失败（目录占用、`git worktree remove` 报错），无需在 teardown 阶段提前阻塞。

## Considered Options

- 保持现状：teardown 不能证明停止即 blocked。
- 完全移除 teardown 调用，服务生命周期完全由 `runtime service stop` 自理。
- 保留 teardown 尝试但不阻塞：结果写入收据，失败由操作者核对。

## Decision Outcome

选定方案：**保留 teardown 尝试但不阻塞**。理由是它保留「移除工作区前尽量停止服务」的既有价值与进程写回顺序，同时把归属证明的强判定留给显式 `runtime service stop`；完全移除调用会让进程与目录占用冲突变成更难诊断的 `git worktree remove` 失败，而保持现状则让一次与交付无关的 supervisor 不可达阻塞整条落地链路。

## Consequences

- 正面：`land`/`cleanup`/`recover` 的阻塞原因重新收敛到本次交付相关的事实（基线、收据、干净工作区、合并证据）。
- 正面：`runtime service stop` 的 fail-closed 归属校验不变，显式停止仍拒绝未经证明的目标。
- 取舍：无法证明停止时工作区仍会被移除，`services` 字段只是记录而不是保证；操作者必须读收据才知道有进程可能残留。
- 取舍：`land` 仍保留 teardown 后对 source 工作区的脏检查（`LAND_SOURCE_WORKTREE_DIRTY`），因为它反映的是服务停止写回，而不是归属证明。

## Confirmation

`tests/integration/project-worktree-command.test.js` 覆盖登记表中存在 supervisor 不可达、无法证明归属的服务时，`land`/`cleanup`/`recover` 仍完成移除并把 `services` 结果写进收据；`tests/integration/delivery-lifecycle.test.js` 继续覆盖 `runtime service stop` 对不可证明归属的拒绝。`docs/specs/delivery-lifecycle.md` 的「服务归属」节与 `README.en.md` 的交付生命周期段落声明同一分层语义。

## Review Trigger

如果出现「teardown 无法证明停止导致工作区删除失败或残留进程影响后续任务」的实测证据，或服务生命周期改为进程隔离模型（例如按 worktree 命名空间回收），重新审视本决策。

## More Information

实现位于 `runtime/commands/run.mjs`（`worktree cleanup`、`worktree land` 步骤 4、`worktree recover` 的两个分支）与 `runtime/lib/services.mjs`（`teardownServices`、`releaseServiceTeardown`）。相关决策：ADR-0011 定义受管服务的 supervisor 归属模型，本条目只调整 worktree 三个命令对 teardown 结果的处理方式。
