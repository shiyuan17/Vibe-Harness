# 当前活跃上下文

本文件是跨 session 恢复的唯一入口，记录当前任务的最小恢复线索。每次结束会话前更新，恢复时从本文件开始，再按其引用读取治理记忆。

<!-- 渲染说明：此模板含 render 占位符，安装时由 template-renderer 输出，内容不与 .agents/memory/CURRENT.md 逐字对应；实时活跃上下文见 .agents/memory/CURRENT.md。占位符：Vibe-Harness。 -->

项目阶段、技术债与决策经本文件引用 `docs/memory/PROJECT_STATE.md` 读取，不在此复制其内容；本文件只记录任务级恢复线索。

- 目标: 对齐本地 develop 与 origin/develop 的分叉，放开 develop 的本地 no-ff 直落与直推，放宽 hook 对 git 同步命令的封锁，并把结果回灌下游项目
- 当前状态: 交付已落地并推送：develop 先合并 origin/develop 的 6 个提交，再把任务分支 codex/git-sync-develop-policy no-ff 合并进来（ADR-0013 取代 ADR-0009；land 目标守卫收窄为 main|master|release* 并显式白名单放行 develop；hook 只读分类新增 fetch/ls-remote/stash list/submodule status，pull 仅 --ff-only 且要求工作区干净）；GitHub 默认分支已切到 develop，release-please 固定 target-branch: main，develop ruleset 24096092 保持 disabled、main ruleset 20501924 保持 active；任务 worktree 与分支已回收，端口 block 已释放
- 已验证证据: develop 门禁 pnpm check（0 error）、pnpm test:integration、pnpm validate、pnpm docs:audit（141 篇）、pnpm tests:catalog check、pnpm eval:check 与 git diff --check 全部通过；hook 干跑 18/18 通过（fetch/ls-remote/stash list/submodule status 放行；脏工作区 pull --ff-only 以 VIBE_HARNESS_SYNC_DIRTY_TREE 拒绝；裸 pull 判定为 workspaceWrite；reset --hard、clean -fd、checkout -- .、submodule update --init 仍拒绝）；land 干跑中 develop 已越过保护门（改为报无归属 worktree），main/master/release 仍报 LAND_TARGET_PROTECTED
- 未完成事项: BL-CNAS 回灌被 fail-closed 拒绝（.cbmignore 与 .githooks/pre-commit、.githooks/pre-push、.codex/hooks.json 和 install-state 记录不一致，需先人工对齐受管文件）；PR #34（codex/delivery-batch）复审发现修复与单复审者收据；develop → main 提升与 nightly 背书回归；backup/governance-audit-batch 等陈旧分支清理
- 下一步最小动作: 与 BL-CNAS 侧确认受管文件漂移的处理方式（对齐内容或在其仓库提交中重记基线）后重跑 install --upgrade --write 与 validate，再补 hook 干跑；随后回到 PR #34 闭合批次
- 锚点提交: b58a53a14ed23e4e708b9298d124b8863bd36b65
- 最后更新: 2026-10-12
- 最后验证: 2026-10-12
