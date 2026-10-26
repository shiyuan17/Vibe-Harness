---
name: vb-git-develop-flow
description: Use only when explicitly requested as Vb Git Develop Flow, $vb-git-develop-flow, or gd-flow to land an isolated worktree into local develop; excludes PR/MR.
---

# Vb Git Develop Flow

调用标识：`vb-git-develop-flow` / `$vb-git-develop-flow`；显示名：Vb Git Develop Flow。旧触发词 gd-flow / `$gd-flow` 指向同一入口。

这是显式 local-land 入口，不是普通提交、普通推送或分组提交入口的别名。常驻合同见 `docs/rules/git-rules.md`；修改须同步。用户在本轮显式调用、具体任务和已核对的会话根才进入流程。

## 执行顺序

1. 核对授权、canonicalCwd、allowedWriteRoots、任务分支和 HEAD。普通本地实现、验证与提交由本轮调用直接授权；`allowedEffects` 之外的 Linear、PR/MR、凭据和外部写入不隐含。缺授权只暂停对应动作。worktree 生命周期按 Git 事实核验，不需要宿主证明。优先接收宿主或当前会话创建的隔离树并用 `--task <task-id>:<branch>` 精确归因；没有可用树时用 `worktree bootstrap` 创建仓库外 worktree。
2. 主检出无需为 stage 处于干净状态；其无关改动只影响 publish 后的本地同步，不得 stash、覆盖或提交。先在任务树实现、验证并提交本任务改动；独立审查可选，项目明确的 Hook、审批和分支保护继续生效。
3. 运行 `worktree stage --project <main-repo> --task <task-id>:<branch> --base-ref develop --delivery local-land --write --json`。该命令只看本地 `develop` 快照，不 fetch、不移动主检出或远端；no-ff 合并并验证后返回 `local_staged` 和可恢复的 `batchId`。
4. 准备发布时运行 `worktree publish --project <main-repo> --batch <batchId> --delivery local-land --write --json`。publish 先 fetch 自动对账：候选已含于远端则直接确认集成；冻结源已全部集成则自动归档；远端前进时从新基线重建、复制收据增量重验；基线未动才进入秒级 FIFO 终锁，以显式非强制 refspec 精确推送并重读远端 SHA；候选等于远端 HEAD 或仍是其祖先都算集成，后续远端提交不回退为分叉。
5. 推送确认即代码集成完成。主检出在目标分支且干净时只做安全 ff-only 本地同步；否则报告 `deferred` 或 `diverged` 并保留用户改动。清理由 publish 在锁外执行并使用独立有限时限；清理失败返回 `integrated_cleanup_pending`，报告残留且继续占用资源，重试只清理。

`--target-mode primary` 是 `stage` 专属的意图断言，新流程不需要；`--target-mode remote` 已退役，任何写入前拒绝。`--reviewed` 只是元数据，不是交付门禁。跨边界效果需要真实 hostContext（source=host、process=isolated、observedAt 等）时，Agent 不得自造；旧 v1 Envelope 仅作 contract-only/degraded 兼容。

## 停止与恢复

冲突、真实验证失败、基线漂移、推送失败或结果不明时停止受影响步骤并保留现场。候选检查失败置 `recovery_required`，修复源提交后重新 stage；环境性失败（blocked/stale/协作取消）保持同候选可续跑。已暂存事务的远端状态由下一次 publish 的 fetch 自动对账推导，不需要 supersede 或归档仪式。用 `worktree status --batch <id>` 只读恢复；已确认未发布事务可用 `worktree discard --batch <id> --write` 回收，推送结果不明时不得丢弃，已发布事务只重试清理。先核对与精确远端；推送不明不得清理或宣称完成，远端分叉不自动 reset、rebase、force push。`recover --write` 必须带 `--task <id>`，只有显式 `--all` 才允许全局恢复。
