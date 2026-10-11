# 当前活跃上下文

本文件是跨 session 恢复的唯一入口，记录当前任务的最小恢复线索。每次结束会话前更新，恢复时从本文件开始，再按其引用读取治理记忆。

<!-- 渲染说明：此模板含 render 占位符，安装时由 template-renderer 输出，内容不与 .agents/memory/CURRENT.md 逐字对应；实时活跃上下文见 .agents/memory/CURRENT.md。占位符：Vibe-Harness。 -->

项目阶段、技术债与决策经本文件引用 `docs/memory/PROJECT_STATE.md` 读取，不在此复制其内容；本文件只记录任务级恢复线索。

- 目标: 把交付与治理演进批次合入 develop（PR #34）并闭合 develop required gate，随后推进 develop → main
- 当前状态: PR #31 已 squash 合入 develop（991bc1b）；develop 上的高风险评审契约已放宽为单复审者（ADR-0012：schemas/review-receipt.schema.json 的 reviewers.minItems 由 2 降为 1，scripts/lib/review-audit.js 只拒 contextIndependence=unavailable），develop ruleset 24096092 仍为 enforcement=disabled，本轮不自动恢复。交付与治理演进批次（7 个提交）加本轮 Hook 安全回归（3 个提交）位于 codex/delivery-batch；本轮把 origin/develop 的 6 个提交（5f5b26d）合入该分支以解除 PR #34 的 CONFLICTING，冲突只落在 eval 指纹产物、docs 目录文件与两个 memory 文件
- 已验证证据: 合入后 pnpm docs:sync --write 与只读复核均 passed（140 篇、0 fixable、0 manual），pnpm docs:audit 140 篇通过；eval 指纹按正规入口重签（eval run --write → VIBE_HARNESS_PROTECTED_APPROVAL=1 eval reference --from <run> --write --confirm-reference-update --force → eval:sync --write → eval:replay --write → eval:behavioral --write），pnpm eval:check 通过、pnpm eval:sync drift 0、behavioral 6 场景 passed；drift 只涉及 config 与 rules 两组，来源是 schemas/review-receipt.schema.json 与 docs/rules/governance-core.md
- 未完成事项: PR #34 的合并与 codex/delivery-batch 删除；develop ruleset 24096092 恢复 enforcement=active；本地 develop（483d0e8，ahead 309）与 backup/governance-audit-batch、origin/codex/governance-audit-batch 等历史引用清理；develop → main 提升；nightly H01–H20 模型背书回归仍待安排
- 下一步最小动作: 推送分支并 squash 合并 PR #34 到 develop，删除分支后恢复 develop ruleset，再开 develop → main
- 锚点提交: 5f5b26d0c5a5e5283dbae49b204647809bd676d6
- 最后更新: 2026-10-11
- 最后验证: 2026-10-11
