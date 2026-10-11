# 项目状态

<!-- 渲染说明：此模板含 render 占位符，安装时由 template-renderer 输出，内容不与 docs/memory/PROJECT_STATE.md 逐字对应；实时项目状态见 docs/memory/PROJECT_STATE.md。占位符：Vibe-Harness。 -->

- 最后更新: 2026-10-12
- 当前阶段: develop 已允许本地 no-ff 直落与直推（ADR-0013 取代 ADR-0009：不再把稳定 fast gate 作为服务器端 required gate，develop 移出人工审批与受保护分支清单，main、master、release* 的发布边界门禁不变）；hook 同步边界放宽（fetch、ls-remote、stash list、submodule status 只读，pull 仅 --ff-only 且要求工作区干净）；高风险变更的单复审者评审契约（ADR-0012）继续生效；GitHub 默认分支已是 develop，develop ruleset 24096092 保持 disabled、main ruleset 20501924 保持 active
- 当前重点: 下游 BL-CNAS 的回灌被受管文件漂移阻塞（.cbmignore、.githooks/pre-commit、.githooks/pre-push、.codex/hooks.json 与 install-state 记录不一致），需要人工决策后再推；随后回到 codex/delivery-batch 闭合 PR #34
- 下一步动作: 先在 BL-CNAS 侧对齐漂移的受管文件，再重跑 install --upgrade --write 与 validate 并补 hook 干跑；把 develop 合入 codex/delivery-batch 闭合 PR #34；再安排 develop → main 提升、backup/governance-audit-batch 等历史引用清理与 nightly H01–H20 模型背书回归
- 恢复提示: 恢复唯一入口是 .agents/memory/CURRENT.md；本文件是被它引用的治理状态源。上一轮 P0–P2 架构审查批次的处置状态见 docs/inventory/harness-superpowers-comparison.md 的「处置状态（2026-09-14）」，未关闭项见 docs/memory/TECH_DEBT.md 的技术债清单；2026-09-22 优化范围见 audit-reports/2026-09-22-optimization-plan.md
