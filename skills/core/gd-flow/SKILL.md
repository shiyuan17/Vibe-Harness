---
name: gd-flow
description: Use only when the user explicitly invokes gd-flow or $gd-flow to deliver a task through an isolated worktree and local merge into develop; never create a PR/MR or change the default delivery profile.
---

# Git develop 本地交付

`gd-flow` / `$gd-flow` 是显式本地交付入口，不是普通提交或 `$git-deliver` 的别名。只处理本轮任务；不创建 PR/MR，不改项目默认 delivery 配置。同步归属：`docs/rules/git-rules.md` 的「显式 develop flow」，修改须同步。

写入前逐项核对：

- **授权**：核对本轮目标、范围和终点。worktree 拓扑变更使用 `vibe-harness.execution-envelope/v2`：绑定 requestId、sessionId、mode=execute、activeObjective、targetIssueIds（无 Issue 时为空）、allowedEffects、forbiddenEffects、terminalCondition 和 riskClass=high。
- **工作区**：核对 canonicalCwd、worktreeRoot、gitCommonDir、gitDir、branch、baseRef、baseSha、initialHeadSha、allowedWriteRoots；外部目标只记录类型、标识和环境，不含凭据。
- **宿主**：hostContext 只能由宿主提供，source=host，包含 filesystem、approval、process=isolated、network、observedAt。Agent 不得自造；缺授权暂停对应写入，缺宿主能力不得靠重复询问用户解除。
- **兼容**：`vibe-harness.execution-envelope/v1` 仅作 contract-only/degraded 兼容，不能授权凭据、宿主/外部写入、红区、高风险间接写入或 worktree 拓扑变化。

1. 核对授权、归属、远端和主检出：当前分支必须是干净的 `develop`，无未归属改动；确认远端允许普通推送。`git fetch origin develop` 后仅在可快进时将本地 `develop` 更新到最新 `origin/develop`。无法核实或无法快进则停止，绝不切换/清理别人的工作区。
2. 明确任务范围与分支名，从已核实的 `origin/develop` 执行 `node .agents/runtime/commands/run.mjs worktree bootstrap --project <main-repo> --base-ref origin/develop --task <task-id>:<type>/<slug> --write --json`。bootstrap 在仓库外 worktree 内创建任务分支；仅在该 worktree 为会话根且上述授权、工作区与宿主核验通过时写入。先 dry-run，不能把计划预览当成创建成功。
3. 在隔离 worktree 实现、运行与变更匹配的验证，只提交本任务改动并检查 HEAD、staged diff 和主检出/远端基线。高风险变更须满足 Independent Review Receipt；验证期间目标前进则重新建立最新基线并重验。
4. 主检出仍为干净的 `develop` 且与最新 `origin/develop` 一致时，先预览，再执行 `node .agents/runtime/commands/run.mjs worktree land --project <main-repo> --task <task-id> --base-ref develop --delivery local-land --reviewed all --write --push --json`；`--reviewed all` 仅在已逐项审定相关检查时使用，否则提供实际审定的 check ID，缺项就停止。`--base-ref` 是当前分支断言而非切换参数；land 负责 no-ff 候选合并验证、快进、推送及成功后的 worktree/本地分支清理。若任务锚点或 CLI 要求其他归因参数，以实际只读预览为准；不能跳过门禁直接手动合并。
5. 重读 `origin/develop`、主检出、land 收据和 worktree 列表，确认推送和清理后才称完成；报告 commit、merge、验证、推送和残留项。

冲突、验证失败、基线漂移、推送失败、清理失败或必需的宿主核验信息缺失时停止并保留可恢复现场；不 force push、不删除未确认合并的分支、不强制清理或自动回滚。若 land 已推送而清理失败，报告“已推送、清理未完成”，不要重放合并。
