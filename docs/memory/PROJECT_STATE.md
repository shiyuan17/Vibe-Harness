# 项目状态

<!-- 渲染说明：此模板含 render 占位符，安装时由 template-renderer 输出，内容不与 docs/memory/PROJECT_STATE.md 逐字对应；实时项目状态见 docs/memory/PROJECT_STATE.md。占位符：Vibe-Harness。 -->

- 最后更新: 2026-09-15
- 当前阶段: 第一性原理审查结论落地（第 1–4 项与建议项 A、B 的 3b、4a、C 以及 R-04 已完成；剩余 R-05/R-06/R-07 未排期）
- 当前重点: 证据基础设施修复、规范可维护性收敛与真实压缩恢复证据均已完成——自安装一致性门禁（scripts/lib/self-install-check.js）、install 重放不再退役既有模块、Eval 资产指纹与结账形态解耦（scripts/lib/eval-assets.js 的 canonicalAssetBytes）、四个 adapter 的启动纪律收敛到单一生成源、i18n 断言改为结构化契约、已安装表面带规则索引（scripts/lib/rules-index.js）、规则措辞锚点收进单一合同表（scripts/lib/pack-validation.js 的 CONTENT_QUALITY_CHECKS 与 SHARED_RULE_PHRASES）、宿主可控真实压缩用例（runtime/evals/codex-runner.mjs 的 compaction 预算与 session store 证据 + EVAL-EXEC-COMPACT-001）
- 下一步动作: 建议项剩余部分 R-05（review-feedback 压力 case）或 R-06/R-07；docs/memory/IMPROVEMENTS.json 仍为空队列（ID 由 mergeImprovementCandidates 从 receipt 派生，不得手工伪造）
- 恢复提示: 先读 docs/inventory/harness-superpowers-comparison.md 的「处置状态（2026-09-14）」确认哪些 Finding 已关闭，未关闭项见 docs/memory/TECH_DEBT.md 的技术债清单；活跃上下文与最后验证日期见 .agents/memory/CURRENT.md
