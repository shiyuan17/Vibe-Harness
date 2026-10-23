---
name: vb-git-develop-flow
description: Use only when explicitly requested as Vb Git Develop Flow, $vb-git-develop-flow, or legacy gd-flow to deliver through an isolated worktree into develop; never create a PR/MR or change the default delivery profile.
---

# Vb Git Develop Flow

调用标识：`vb-git-develop-flow` / `$vb-git-develop-flow`；显示名：`Vb Git Develop Flow`。兼容旧触发词 gd-flow / `$gd-flow`，均选择本 Skill，不安装重复入口。

`vb-git-develop-flow` / `$vb-git-develop-flow` 是显式本地交付入口，不是普通提交或 `$vb-git-split-push` 的别名。只处理本轮任务；不创建 PR/MR，不改项目默认 delivery 配置。同步归属：`docs/rules/git-rules.md` 的「显式 develop flow」，修改须同步。

写入前逐项核对（会话根与实际写入根须一致）：
- **授权**：用户在本轮显式调用本 Skill 就是工作区内部动作的授权根——建立隔离 worktree、在其中实现与验证、提交归属明确的改动、回收与清理都由它覆盖。Linear 写入、PR/MR、外部系统写入与凭据使用不由此隐含，各按自身边界另行授权；缺授权时暂停对应写入。
- **工作区**：核对 canonicalCwd、worktreeRoot、gitCommonDir、gitDir、branch、baseRef、baseSha、initialHeadSha、allowedWriteRoots；外部目标只记录类型、标识和环境，不含凭据。
- **宿主**：worktree 生命周期不需要宿主核验信息。跨边界效果（hostWrite、externalWrite、credentialUse、红区与高风险间接写入）按 `vibe-harness.execution-envelope/v2` 冻结 requestId、sessionId、targetIssueIds、activeObjective、allowedEffects、forbiddenEffects、terminalCondition 与 riskClass=high，hostContext 必须由宿主提供，source=host，包含 filesystem、approval、process=isolated、network、observedAt，Agent 不得自造；缺少宿主证明只暂停依赖它的跨边界步骤，不阻塞建立 worktree、实现、聚焦验证与提交，也不得靠重复询问用户解除。
- **入口选择**：local-land 默认使用 `worktree bootstrap` 已登记的仓库外 worktree；当前不提供宿主 worktree 导入登记。核对会话写入根与任务工作区一致后执行。
- **兼容**：`vibe-harness.execution-envelope/v1` 仅作 contract-only/degraded 兼容，不能授权凭据、宿主/外部写入、红区或高风险间接写入。

1. 核对授权、工作区归属和精确推送目标。主检出须在 develop 且干净；有无关改动保留任务树并暂停落地。目标固定为 `origin/develop`，冻结唯一 origin 实际 push URL 与 `refs/heads/develop`，拒绝多地址、mirror、目标保护不明；从该目标获取最新基线，仅快进同步本地 develop，不夹带未归属提交。
2. 先 dry-run，再用 `node .agents/runtime/commands/run.mjs worktree bootstrap --project <main-repo> --base-ref origin/develop --task <task-id>:<type>/<slug> --write --json` 创建隔离树并核对冻结基线。只在该任务树实现，明确归属的改动按片段复制，不修改主检出原件。
3. 实现、聚焦验证、提交本任务改动；独立审查可选，项目明确的审查与分支保护继续生效。验证针对最终候选，目标前进仅重跑输入失效的检查。
4. 先预览再执行 `node .agents/runtime/commands/run.mjs worktree land --project <main-repo> --task <task-id> --base-ref develop --delivery local-land --write --push --json`。候选 no-ff 合并并验证，取得目标锁复核事实，先 ff-only 更新主检出本地 develop 并确认 HEAD，再显式推送候选 SHA 到被冻结精确远端 ref 并重读确认。单任务与 batch 顺序相同。`--target-mode remote` 已退役，在任何写入前拒绝；使用 primary。`--reviewed` 不替代真实验证；项目明确要求时遵守。
5. 推送确认即完成代码集成；安全清理失败标记 `integrated_cleanup_pending`，报告残留与仍占用的资源。Git common dir 阶段记录用于恢复；本地已合并推送失败重试原候选，推送不明先读远端，远端分叉停止并保留现场。已确认推送的重试只清理，不重复合并或推送。

冲突、验证失败、基线漂移、推送失败或清理失败时停止受影响步骤并保留可恢复现场；不 force push、不删除未确认合并的分支、不强制清理或自动回滚。缺少宿主核验信息不是本 flow 的停止理由，它只影响正在进行的跨边界步骤；worktree 的清理由创建它的那一侧负责，宿主 worktree 由宿主移除。若 land 已推送而清理失败，报告“已推送、清理未完成”，不要重放合并。
