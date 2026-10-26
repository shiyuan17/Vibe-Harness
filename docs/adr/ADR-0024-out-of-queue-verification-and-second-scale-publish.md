---
id: ADR-0024
title: 验证出队与秒级发布终锁的交付协议
status: accepted
date: 2026-10-26
review-date: 2027-04-26
owner: vibe-harness-maintainers
decision-makers: [vibe-harness-maintainers]
consulted: [vibe-harness-contributors]
informed: [linear-workflow-users]
supersedes: [ADR-0022, ADR-0023]
superseded-by: null
---

# 验证出队与秒级发布终锁的交付协议

## Context and Problem Statement

ADR-0022 把候选构建、验证、目标 ref 更新、push 与本地同步全部纳入仓库级
FIFO，消除了候选并行的竞态窗口，代价是队列持有时间等于最重的验证时长：
一个批次的重型检查会让其他批次的秒级收口无限等待，与验证内容是否相关
无关。ADR-0023 为 `push_uncertain` 与外部集成补上 `--supersede` 与
`--archive-integrated` 两个显式仪式，恢复仍依赖人工判断远端事实。失败
语义没有区分候选本身失败与环境性阻塞：验证超时、排队或取消都会把候选
打入同一恢复路径，迫使已验证的候选重新 stage。

真实并发交付（多 worktree 会话）显示主要等待来自无关验证串行，而真正
需要仓库级互斥的只有精确目标 ref 的最终更新窗口。

## Decision Drivers

- FIFO 只保护真正的临界区：精确目标 ref 的读取、非强制推送与远端 SHA
  回读，时长为秒级。
- 候选构建与验证在 detached 候选 worktree 与私有 ref 上运行，不触碰
  共享状态，不需要仓库级串行。
- 恢复结论必须能从 fetch 到的远端事实自动推导，不再依赖人工仪式或
  删除证据。
- 被取代候选仍在跑的重型检查是浪费，必须可发现、可协作取消。
- 候选失败与环境失败必须分流：环境失败续跑同一候选，候选失败才要求
  修源重 stage。
- 远端基线反复前进时重建必须有界，收据复用使重验只付出增量成本。

## Considered Options

- 维持全流程入队并压缩验证时长：拒绝，队列持有时间仍与验证时长耦合，
  无关交付继续互相阻塞。
- 保留全流程入队、为恢复增加更多显式命令：拒绝，恢复继续依赖人工判断，
  仪式数量随场景增长。
- 验证全部出队，publish 只在秒级 finalize 持有队首，远端前进由 fetch
  自动对账推导恢复结论：采纳。

## Decision Outcome

交付协议收敛为五个要点：

1. **验证出队**：`stage` 与 publish 的重建、重验全部在仓库 FIFO 外
   执行。stage 从本地 `develop` 快照构建 detached 候选、no-ff 合入
   冻结源、在候选 worktree 内完成按风险选择的完整验证，写入
   `refs/vibe-harness/staged/<batch-id>` 后释放候选目录；不 fetch、
   不移动主检出。独立重型 verify 也不再进入队列。
2. **秒级终锁**：只有 `publish --write` 取得仓库 FIFO 队首，且只在
   finalize 段持有：基线新鲜度复查 → 显式非强制 refspec 精确推送 →
   远端 SHA 回读 → `integrated` 确认与安全 ff-only 本地同步 → 释放。
   清理在队外执行。
3. **fetch 自动对账**：publish 入口在队外 fetch 精确目标 ref 并自动
   推导结论：候选已是远端祖先 → 确认集成；全部冻结源 HEAD 已被远端
   包含 → 自动写入 `archived_integrated`；远端已前进 → 从新基线重建
   候选并增量重验（复制前候选收据、按 tree-content 复用逐检查证据），
   最多 `LAND_MAX_ATTEMPTS = 3` 次，超限返回
   `LAND_BATCH_BASELINE_CHANGED`；远端仍在 staged 基线 → 进入 FIFO
   finalize。`--supersede` 与 `--archive-integrated` 仪式删除，对账
   历史写入事务的 `reconcileHistory`。
4. **失败分类**：验证失败写入 `verifyFailure`。候选本身检查失败
   （`LAND_VERIFY_FAILED`，failureType `checks-failed`）把事务置为
   `recovery_required`，必须修源后重新 stage；环境性失败
   （`LAND_VERIFY_ENVIRONMENT_FAILED`，failureType `blocked`、
   `stale`、`snapshot-drift`、`snapshot-unknown`、`not-run`，协作取消
   产生的 `VERIFICATION_CANCELLED` 归入 `not-run`）保持同一候选可
   续跑。
5. **自动取消被取代候选**：publish 确认或自动归档后，扫描仍持有候选
   活动租约的其他事务；基线已被本次发布包含的活租约写入协作 CANCEL
   sidecar、树状终止进程并强制释放租约，结果以 `supersededCandidates`
   报告。

兼容的旧 `land` 引擎与 `verification-lock` 互斥锁删除；
`DELIVERY_QUEUE_OPERATIONS` 收敛为 `['publish']`，队列模块拒绝任何
其他操作入队。事务 schemaVersion 4 成为唯一写入版本：
`supersedeHistory` 由 `reconcileHistory` 取代，新增 `verifyFailure`
与 failureType 子类型，phase 枚举移除 `verified` 与 `local_merged`。
运行时继续读取 v1/v2/v3 事务并在下一次安全写入时升级。

## Consequences

- 队列等待从最重验证时长降为秒级 finalize 时长；无关批次的重型检查
  不再互相阻塞。
- 目标 ref 更新、push 与回读仍严格按票号串行，单机单 Git common dir
  的顺序保证不变。
- `push_uncertain` 与外部集成不再需要人工仪式：下一次 publish 的
  fetch 自动推导确认、归档或重建。
- 被取代候选的重型检查被协作取消并强制释放租约，验证算力不再被
  浪费。
- v4 事务与旧版运行时不可混用；首次 v4 写入前必须结束旧版交付进程。
- 队列不再为验证提供串行保证，依赖共享构建缓存的检查需自行保证缓存
  并发安全。

## Confirmation

集成测试覆盖：stage 队外验证与暂存、publish 仅 finalize 入队、自动
对账四种结论、重建增量重验与有界重试、失败分类与同候选续跑、CANCEL
sidecar 协作取消与租约强释放、v4 唯一写入与 v1/v2/v3 读取升级。真实
多 worktree 测试验证队首只覆盖 finalize、被取代验证被取消、任何验证
阶段都不持有队列票。

## Review Trigger

- FIFO 范围重新扩大或缩小；
- 自动对账改用非精确远端证据或新增人工恢复仪式；
- `LAND_VERIFY_FAILED` 与 `LAND_VERIFY_ENVIRONMENT_FAILED` 的分类
  边界变化；
- 事务版本兼容窗口或 `LAND_MAX_ATTEMPTS` 上限变化。

## More Information

- 操作合同见 `docs/rules/git-rules.md` 的多 Worktree 并发交付节。
- 交付生命周期见 `docs/specs/delivery-lifecycle.md`。
- 事务 Schema 见 `schemas/worktree-transaction.schema.json`；实现见
  `runtime/lib/worktree-command.mjs` 与
  `runtime/lib/worktree-delivery-queue.mjs`。
