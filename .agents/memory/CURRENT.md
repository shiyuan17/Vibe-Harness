# 当前活跃上下文

本文件是跨 session 恢复的唯一入口，记录当前任务的最小恢复线索。每次结束会话前更新，恢复时从本文件开始，再按其引用读取治理记忆。

<!-- 渲染说明：此模板含 render 占位符，安装时由 template-renderer 输出，内容不与 .agents/memory/CURRENT.md 逐字对应；实时活跃上下文见 .agents/memory/CURRENT.md。占位符：Vibe-Harness。 -->

项目阶段、技术债与决策经本文件引用 `docs/memory/PROJECT_STATE.md` 读取，不在此复制其内容；本文件只记录任务级恢复线索。

- 目标: 把 codebase-memory-mcp 使用规范对齐上游 17 工具面（已索引范围内的文本检索默认改用 search_code）并落地到 develop；批次 PR #34 已 squash 合并（bc7fe8d）
- 当前状态: PR #34（feat(runtime) 交付生命周期与工作区治理批次）已 squash 合并进 develop（bc7fe8d），合并前全部 CI job 绿（run 38581574958）；docs/cbm-tool-surface-sync 已 rebase 到该基线，四组提交（docs(rules)、test(validation)、eval(assets)、docs(changelog)）就绪并修复本条目因批次 squash 合并脱锚导致的 validate 失败（锚点提交改指 develop 上的 bc7fe8d）；工作区干净、尚未推送
- 已验证证据: pnpm check（lint、ESLint 0 error、typecheck、validate、tests:catalog check、unit、component）、pnpm test:integration、pnpm eval:check 与 pnpm eval:replay（rules/skills 指纹在 rebase 后无漂移）、pnpm docs:audit 与 git diff --check 通过；组件层的 memory-entry、memory-freshness 与 docs-projection 随本次 memory 更新复跑
- 未完成事项: 本分支推送与 PR 收尾；BL-CNAS 回灌仍被 fail-closed 拒绝（.cbmignore 与 .githooks/pre-commit、.githooks/pre-push、.codex/hooks.json 和 install-state 记录不一致，需先人工对齐受管文件）；develop → main 提升与 nightly H01–H20 背书回归；backup/governance-audit-batch 等陈旧分支清理；在线 Agent 行为未验证
- 下一步最小动作: 推送 docs/cbm-tool-surface-sync、开 PR 并复核检查与收据后合并；随后与 BL-CNAS 侧确认受管文件漂移的处理方式（对齐内容或在其仓库提交中重记基线），重跑 install --upgrade --write 与 validate 并补 hook 干跑
- 锚点提交: bc7fe8d8aefd1a9cca00471b5a177c0c72f986c7
- 最后更新: 2026-10-14
- 最后验证: 2026-10-14
