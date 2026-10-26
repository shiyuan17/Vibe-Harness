---
id: ADR-0022
title: 仓库级 FIFO 串行化受管 Worktree 交付
status: superseded
date: 2026-10-25
review-date: 2027-04-25
owner: vibe-harness-maintainers
decision-makers: [vibe-harness-maintainers]
consulted: [vibe-harness-contributors]
informed: [linear-workflow-users]
supersedes: [ADR-0021]
superseded-by: ADR-0024
---

# 仓库级 FIFO 串行化受管 Worktree 交付

## Context and Problem Statement

ADR-0021 假设候选合并与验证可以跨 worktree 并行，只在最终目标 ref
更新和 push 时短暂串行。实际并发交付中，重型检查、共享构建状态、候选
重建和远端基线判断互相影响：多个候选可以同时运行本应独占的检查，或在
验证期间基于已变化的远端基线继续推进，最终仍依赖 push 抢锁的先后顺序。
自建 `repo-heavy` 检查还可能绕过旧 `deep` 锁，验证等待也可能快速失败，
脏主检出则可能错误阻塞远端发布。

## Decision Drivers

- 同一仓库内的受管 merge、候选验证、共享 ref 更新、push 与本地同步必须
  对等待者表现为一个确定顺序。
- `stage`、`publish` 与兼容 `land` 的两阶段语义和 CLI 入口需要保持稳定。
- 队列不得自动合批、抢占、插队或跨机器宣称原子性。
- 失败必须记录现场并尽快释放队列，人工检查不能阻塞后续请求。
- 等待、崩溃恢复和进度输出必须可观察、可恢复，不能依赖易失效的文件锁。

## Considered Options

- 保持候选并行、最终 push 抢锁：拒绝，重型验证与基线判断仍会并发。
- 全流程单一静态全局锁：拒绝，无法表达排队位置、心跳、超时和可恢复票据。
- Git common dir 下的持久化单调票 FIFO，仅队首持有运行租约：采纳。

## Decision Outcome

选定方案：**所有由 Vibe-Harness 管理的交付进入仓库级 FIFO**。参数校验、
任务/分支检查、变更范围和远端地址解析可在排队期间并行；从创建候选与
第一个受管 merge 开始，到候选验证、目标 ref 更新、push 回读和安全本地
ff-only 同步结束，只由队首执行。非关键清理在释放队列后执行。

队列元数据位于 Git common dir 的 `vibe-harness-delivery-queue/`。短时
互斥只分配单调序号，票文件采用 `%012d-<uuid>.json`，状态限定为
`queued`、`running`、`completed`、`cancelled`、`expired`。等待者持续
心跳并输出 `queue-wait`、`queue-ready`、`queue-released`，报告位置、
前方数量和持有者。默认等待 30 分钟，超时返回
`WORKTREE_QUEUE_TIMEOUT` 并保留现场；旧
`VIBE_HARNESS_LAND_LOCK_TIMEOUT_MS` 继续作为兼容别名。

`stage` 在写入 `refs/vibe-harness/staged/<batch-id>`、返回
`local_staged` 后释放队列。`publish` 作为新请求重新排队，在队首读取最新
远端，必要时从新基线重建并重验，再推送和回读 SHA。`land --push` 复用
同一最终发布器；脏主检出只把本地同步记为 `deferred`。不带 `--push` 的
本地 checkout merge 也进入队列，并继续要求主检出干净。

事务新写入使用 v3，增加 `queue`、`publishing` 和
`recovery_required` 等恢复字段；v1/v2 继续可读并在下一次安全写入时升级。
`recover` 只读列出队列票、事务、lease、staged ref 与候选目录；
`recover --all --write` 只回收心跳过期票、死进程 lease、已结束事务的
干净候选与私有 ref。活跃或无法判定的租约、脏候选、`push_uncertain`、
用户分支和非事务目录一律保留并报告。

`deep`、显式 `validationCommands.checks[].resourceClass: "repo-heavy"` 和
兼容识别的 `mvn/gradle` 检查进入同一仓库 FIFO。独立重型 `verify` 自己
排队；交付事务内的验证通过内部租约上下文借用当前队首，避免重复排队和
死锁。保留 `acquireVerificationLock` 导出并改为等待轮次的兼容包装。

## Consequences

- 同一仓库的受管交付不再并发执行 merge、候选验证、ref 更新、push 或
  本地同步，结果由票号顺序决定。
- 等待重型交付可能更久，但等待状态、持有者和前方数量可观测，超时不会
  留下无人负责的锁。
- 远端在队列等待或验证期间前进时，仅 publish 队首重建并重验最新基线，
  不把旧候选直接发布。
- 队列只在单机、单个 Git common dir 内协调；直接执行的原生 `git merge`
  和远端平台并发仍由其他事实约束。
- 旧版进程不能读取 v3 事务，升级和首次 v3 写入前需要结束现有旧版交付。

## Confirmation

真实多 worktree、独立进程测试覆盖严格票序、无并发 merge/验证、等待进度、
超时、死亡进程、心跳续期、过期票回收与 `repo-heavy` 验证。Worktree
集成测试覆盖 stage/publish/land 共用 FIFO、脏主检出下远端发布与本地同步
延迟、远端前进重建、v1/v2 读取、v3 写入及恢复对象保护。

## Review Trigger

- 交付队列改为跨机器协调、自动合批、抢占或优先级；
- `stage`/`publish`/`land` 的公开语义、事务 schema 或兼容窗口变化；
- 远端采用强制 merge queue，或本地同步策略变化；
- 重型检查分类、队列超时、票保留策略或恢复删除条件变化。

## More Information

- 操作合同见 `docs/rules/git-rules.md` 的多 Worktree 并发交付节。
- 交付生命周期见 `docs/specs/delivery-lifecycle.md`。
- 队列实现见 `runtime/lib/worktree-delivery-queue.mjs`，事务与命令实现见
  `runtime/lib/worktree-command.mjs`，Schema 见
  `schemas/worktree-transaction.schema.json`。
