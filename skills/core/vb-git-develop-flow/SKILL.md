---
name: vb-git-develop-flow
description: Use only when explicitly requested as Vb Git Develop Flow, $vb-git-develop-flow, or gd-flow to land an isolated worktree into local develop; excludes PR/MR.
---

# Vb Git Develop Flow

调用标识：`vb-git-develop-flow` / `$vb-git-develop-flow`；显示名：Vb Git Develop Flow。旧触发词 gd-flow / `$gd-flow` 指向同一入口。

这是显式 local-land 入口，不是普通提交、普通推送或分组提交入口的别名。常驻合同见 `docs/rules/git-rules.md`；修改须同步。用户在本轮显式调用、具体任务和已核对的会话根才进入流程。

## 执行顺序

1. 核对授权、canonicalCwd、allowedWriteRoots、任务分支和 HEAD。普通本地实现、验证与提交由本轮调用直接授权；`allowedEffects` 之外的 Linear、PR/MR、凭据和外部写入不隐含。缺授权只暂停对应动作。worktree 生命周期按 Git 事实核验，不需要宿主证明；当前不提供宿主 worktree 导入，固定使用 `worktree bootstrap` 登记的仓库外 worktree。
2. 主检出必须在 `develop` 且干净。先 dry-run，再运行 `worktree bootstrap --project <main-repo> --base-ref origin/develop --task <task-id>:<type>/<slug> --write --json`。主检出脏只阻止 land，保留任务树和用户改动，不自动 checkout、暂存或删除。
3. 只在该任务树实现、验证并提交本任务改动。独立审查可选；项目明确的 Hook、审批和分支保护继续生效。
4. 运行 `worktree land --project <main-repo> --task <task-id> --base-ref develop --delivery local-land --write --push --json`。候选 no-ff 合并并验证后，在目标锁内先 ff-only 更新主检出本地 `develop`，再以显式非强制 refspec 精确推送冻结 SHA 到唯一实际 `origin/develop`，重读远端确认后立即释锁。
5. 推送确认即代码集成完成。清理由 land 在锁外执行并使用独立有限时限；清理失败返回 `integrated_cleanup_pending`，报告残留且继续占用资源，重试只清理。

`--target-mode primary` 是唯一模式；`--target-mode remote` 已退役，任何写入前拒绝。`--reviewed` 只是元数据，不是 land 门禁。跨边界效果需要真实 hostContext（source=host、process=isolated、observedAt 等）时，Agent 不得自造；旧 v1 Envelope 仅作 contract-only/degraded 兼容。

## 停止与恢复

冲突、真实验证失败、基线漂移、推送失败或结果不明时停止受影响步骤并保留现场。先核对本地与精确远端；推送不明不得清理或宣称完成，远端分叉不自动 reset、rebase、force push。`recover --write` 必须带 `--task <id>`，只有显式 `--all` 才允许全局恢复。
