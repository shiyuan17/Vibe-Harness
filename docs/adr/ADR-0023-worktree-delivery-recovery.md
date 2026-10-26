---
id: ADR-0023
title: 受管 Worktree 交付的 supersede 与外部集成归档
status: accepted
date: 2026-10-25
review-date: 2027-04-25
owner: vibe-harness-maintainers
decision-makers: [vibe-harness-maintainers]
consulted: [vibe-harness-contributors]
informed: [linear-workflow-users]
supersedes: []
superseded-by: null
---

# 受管 Worktree 交付的 supersede 与外部集成归档

## Context and Problem Statement

ADR-0022 将受管 merge、验证、推送和本地同步纳入仓库级 FIFO，但事务一旦
进入 `push_uncertain`，若远端随后前进且不再包含旧候选，普通 publish 会
持续拒绝而没有安全的重建出口。另一个场景是用户在远端独立集成了冻结源
提交，本地事务却仍是 `push_uncertain` 或历史阶段，普通 discard 和全局
recover 都无法证明其归属并安全关闭。直接删除事务 JSON 会绕过审计与清理
边界。

## Decision Drivers

- 旧候选可能已到达远端，supersede 不得先丢弃它。
- 远端前进后只能在最新基线上重建和重验，不能 force push。
- 外部集成必须用精确远端 SHA 和冻结源 HEAD 的祖先关系证明。
- 脏候选、未知 ref、用户分支和活动 lease 必须保留。
- 恢复动作必须继续经过仓库 FIFO，并与普通 stage/publish 共用并发边界。

## Considered Options

- 允许删除 `push_uncertain` 后重新创建无关联批次：拒绝，会丢失旧候选与
  推送结果证据，也容易产生并行候选。
- publish 自动忽略远端分叉并重建：拒绝，无法区分正常重建、外部集成和
  未知推送结果。
- 原批次显式 `--supersede`，外部集成使用独立显式归档：采纳。

## Decision Outcome

`worktree publish --batch <id> --supersede --write` 只接受
`publishing` 或 `push_uncertain`。它先读取精确远端：候选等于远端或已是
其祖先时确认集成；远端仍在旧基线时拒绝并要求普通 publish；远端已包含
全部冻结源 HEAD 但不含旧候选时返回 `LAND_SOURCE_ALREADY_INTEGRATED`；
其余情况下冻结源仍干净且未漂移时，记录 `supersedeHistory` 并使用原批次
ID 从最新远端重建、重验、推送、回读和本地同步。任何失败保留旧候选和
staged ref。

`worktree recover --batch <id> --archive-integrated --write` 在 FIFO 和
批次 lease 内重新 fetch 精确目标 ref，只有全部冻结源 HEAD 都是其祖先时
才写入 `archived_integrated`。事务文件保留审计；干净候选和匹配的 staged
ref 可回收，脏候选、不匹配 ref、源分支和用户 worktree 保留。归档不是
publish，不能把未确认的候选报告为已推送。

事务格式升级为 v4，新增 `supersedeHistory`、`archive` 和
`archived_integrated`。运行时继续读取 v1/v2/v3，并在下一次安全写入时升级
为 v4。所有恢复写入纳入仓库 FIFO。

## Consequences

- `push_uncertain` 不再因远端前进永久阻塞，也不会通过删除证据解决。
- 原批次 ID 保留在 supersede 全过程中，状态和报告可以连续审计。
- 外部集成成为显式动作，证明不足时事务保持原阶段。
- v4 事务与旧版运行时不可混用；首次写入前必须结束旧版交付进程。
- 直接调用项目自定义重型脚本仍不在运行时可拦截范围内，项目应使用
  `resourceClass: "repo-heavy"` 和受管 verify `--paths` 入口。

## Confirmation

集成测试覆盖远端前进后的重建、候选已包含、源已集成、远端不可证明、
源漂移、脏候选保留、显式归档、v1/v2/v3 读取、v4 升级和帮助文本。
真实多 worktree 测试继续验证所有 stage、publish、recover 写入共享同一
FIFO。

## Review Trigger

- supersede 改为自动执行、合并批次或新增优先级；
- 外部集成改由非精确远端证据判定；
- `archived_integrated` 的保留、清理或审计语义变化；
- 事务版本兼容窗口或 FIFO 协调范围变化。

## More Information

- 操作合同见 `docs/rules/git-rules.md` 的多 Worktree 并发交付节。
- FIFO 基础决策见 `docs/adr/ADR-0022-repository-delivery-fifo.md`。
- Schema 见 `schemas/worktree-transaction.schema.json`。
