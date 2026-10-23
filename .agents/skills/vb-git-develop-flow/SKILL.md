---
name: vb-git-develop-flow
description: Use only when explicitly requested as Vb Git Develop Flow, $vb-git-develop-flow, or legacy gd-flow to deliver through an isolated worktree into develop; never create a PR/MR or change the default delivery profile.
---

# Vb Git Develop Flow

调用标识：`vb-git-develop-flow` / `$vb-git-develop-flow`；显示名：`Vb Git Develop Flow`。兼容旧触发词 gd-flow / `$gd-flow`，均选择本 Skill，不安装重复入口。

`vb-git-develop-flow` / `$vb-git-develop-flow` 是显式本地交付入口，不是普通提交或 `$vb-git-split-push` 的别名。只处理本轮任务；不创建 PR/MR，不改项目默认 delivery 配置。同步归属：`docs/rules/git-rules.md` 的「显式 develop flow」，修改须同步。

写入前逐项核对：

- **授权**：用户在本轮显式调用本 Skill 就是工作区内部动作的授权根——建立隔离 worktree、在其中实现与验证、提交归属明确的改动、回收与清理都由它覆盖。Linear 写入、PR/MR、外部系统写入与凭据使用不由此隐含，各按自身边界另行授权；缺授权时暂停对应写入。
- **工作区**：核对 canonicalCwd、worktreeRoot、gitCommonDir、gitDir、branch、baseRef、baseSha、initialHeadSha、allowedWriteRoots；外部目标只记录类型、标识和环境，不含凭据。
- **宿主**：worktree 生命周期不需要宿主核验信息。跨边界效果（hostWrite、externalWrite、credentialUse、红区与高风险间接写入）按 `vibe-harness.execution-envelope/v2` 冻结 requestId、sessionId、targetIssueIds、activeObjective、allowedEffects、forbiddenEffects、terminalCondition 与 riskClass=high，hostContext 必须由宿主提供，source=host，包含 filesystem、approval、process=isolated、network、observedAt，Agent 不得自造；缺少宿主证明只暂停依赖它的跨边界步骤，不阻塞建立 worktree、实现、聚焦验证与提交，也不得靠重复询问用户解除。
- **入口选择**：宿主提供 worktree 能力时可用宿主 worktree，从已核实的 `origin/develop` 基线创建并让宿主把会话根切到该 worktree；但本地 `land` 只能回收 `worktree bootstrap` 已登记的仓库外 worktree，宿主 worktree 必须提供等价登记、归属和回收证明，否则应改用 bootstrap 或走任务分支交付路径。只有项目声明了 `worktree.mirrors`、`worktree.ports` 或 `worktree.provision`（需要治理面投影、端口分段或逐包依赖链接）时才强制用 `worktree bootstrap`。
- **兼容**：`vibe-harness.execution-envelope/v1` 仅作 contract-only/degraded 兼容，不能授权凭据、宿主/外部写入、红区或高风险间接写入。

1. 核对授权、归属、远端和主检出：主检出当前分支必须是干净的 `develop`，且没有归属不明的改动；确认远端允许普通推送。`git fetch origin develop` 后仅在可快进时将本地 `develop` 更新到最新 `origin/develop`，并记录被冻结的基线 SHA。无法核实或无法快进则停止，绝不切换或清理别人的工作区。远端落地模式（`--target-mode remote`）不更新主检出，因此主检出允许已有改动，但仍要求本地 `develop` 没有未推送提交或分叉。
2. 建立隔离工作区并让会话根等于它：会话根已经是一个宿主 worktree 时，只有它具备可核对的登记、归属和回收合同才直接继续；否则宿主提供 worktree 能力时从冻结的 `origin/develop` 基线创建并核对基线，再由宿主把会话根切到它。若要使用 local-land 且宿主 worktree 没有等价登记，执行 `node .agents/runtime/commands/run.mjs worktree bootstrap --project <main-repo> --base-ref origin/develop --task <task-id>:<type>/<slug> --write --json`（先 dry-run）建立仓库外 worktree，并让宿主把会话根切过去。写入只在会话根就是该 worktree 时进行，不能把计划预览当成创建成功。
3. 在隔离 worktree 内创建或确认任务分支，实现并运行与变更匹配的聚焦验证，只提交本任务改动并检查 HEAD、staged diff 与主检出/远端基线。独立审查可记录观察结果，不是普通 land 的必需收据；目标前进时重建最终候选，仅重跑因输入变化失效的必要检查。来自带改动主检出的工作只逐组显式复制/应用到任务 worktree，同一文件混有无关改动时按片段选取，冲突停止且不修改主检出原件。
4. 回收：已登记的 worktree 用 `node .agents/runtime/commands/run.mjs worktree land --project <main-repo> --task <task-id> --base-ref develop --delivery local-land --write --push --json`（主检出仍为干净的 `develop` 且与最新 `origin/develop` 一致时先预览再执行）。宿主 worktree 仅在具备安全登记、归属和回收证明时进入 local-land；否则走任务分支交付。`--reviewed` 是可选观察声明，不构成完成门禁，不伪造审阅结论。候选树上选中检查必须实测通过且输入稳定；deferred 检查不代表已经完成。`--base-ref` 是当前分支断言而非切换参数。需要直接推送远端 `develop` 且不更新主检出时加 `--target-mode remote`：候选在已核实的远端基线上 no-ff 合并并验证，以非强制 refspec 推送，远端 SHA 等于候选后才清理任务树与分支；主检出与原改动保持原状。
5. 重读 `origin/develop`、主检出、land 收据或 PR/MR 状态与 worktree 列表，确认推送、合并和清理事实后才称完成；报告 commit、merge、验证、推送和残留项。

冲突、验证失败、基线漂移、推送失败或清理失败时停止受影响步骤并保留可恢复现场；不 force push、不删除未确认合并的分支、不强制清理或自动回滚。缺少宿主核验信息不是本 flow 的停止理由，它只影响正在进行的跨边界步骤；worktree 的清理由创建它的那一侧负责，宿主 worktree 由宿主移除。若 land 已推送而清理失败，报告“已推送、清理未完成”，不要重放合并。
