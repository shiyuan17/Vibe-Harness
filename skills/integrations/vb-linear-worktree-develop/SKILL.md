---
name: vb-linear-worktree-develop
description: Use only when explicitly requested as Vb Linear Worktree Develop or legacy lwflow to execute the current authorized plan through isolated worktrees into local develop.
---

# Vb Linear Worktree Develop

调用标识：`vb-linear-worktree-develop` / `$vb-linear-worktree-develop`；显示名 Vb Linear Worktree Develop。旧触发词 lwflow / `$lwflow` 指向同一入口。

常驻合同见 `docs/rules/linear-workflow.md` 与 `docs/rules/git-rules.md`；修改须同步。只处理当前授权计划，不扫描或认领队列外任务，同一 Issue 不允许重复并行执行。

Linear MCP 不可用时回退到用户提供的 Issue 上下文，并明确标记未同步；不伪造写入结果。

1. 核对授权、canonicalCwd、allowedWriteRoots、Issue 和必要原生依赖；缺授权只暂停对应动作。跨边界效果需要真实 hostContext（source=host、process=isolated、observedAt），Agent 不得自造；旧 v1 Envelope 仅作 contract-only/degraded 兼容。
2. 只执行本轮已确认 ID 的封闭集合，计划内可按依赖接续。显式执行不要求 Claim 或 Start/Terminal Receipt；历史活动记录仍参与冲突检查。
3. 普通 write 从最新 `origin/develop` 用 `worktree bootstrap` 建立已登记仓库外 worktree；worktree 生命周期按 Git 事实核验，当前不提供宿主 worktree 导入。普通单 Agent 不创建 DAG 或墙钟估算，普通 Issue 不要求 Parent；已有 Linear DAG 必须遵循。
4. local-land 先在候选 no-ff 合并并验证，再 ff-only 更新干净主检出的本地 `develop`，随后精确推送到唯一实际 `origin/develop` 并重读 SHA。`--target-mode primary` 是唯一模式；`--target-mode remote` 已退役，任何写入前拒绝。
5. 推送确认后标记 Done / succeeded；清理失败记录 `integrated_cleanup_pending`，不阻塞后继但保留资源占用，重试只清理。Linear 尚未尝试写入且上下文充分时可继续并标记未同步；写入结果不明时停止受影响节点。没有既有 DAG 时保持 single，需要拆分能力不可用时也退化 single。

不创建 PR/MR、不改默认 delivery、不操作 main，不 force push 或重放已确认的合并与推送。普通 PR/MR 继续保留 In Review 与 closing 合并证据；独立审查可选，项目明确门禁继续生效。
