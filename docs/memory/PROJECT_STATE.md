# 项目状态

<!-- 渲染说明：此模板含 render 占位符，安装时由 template-renderer 输出，内容不与 docs/memory/PROJECT_STATE.md 逐字对应；实时项目状态见 docs/memory/PROJECT_STATE.md。占位符：Vibe-Harness。 -->

- 最后更新: 2026-09-14
- 当前阶段: 第一性原理审查结论落地（第 1–4 项与建议项 A、B 的 4a、C 已完成；建议项 B 的 3b 待排期）
- 当前重点: 证据基础设施修复已完成——自安装一致性门禁（scripts/lib/self-install-check.js）、install 重放不再退役既有模块、Eval 资产指纹与结账形态解耦（scripts/lib/eval-assets.js 的 canonicalAssetBytes）、四个 adapter 的启动纪律收敛到单一生成源、i18n 断言改为结构化契约、已安装表面带规则索引（scripts/lib/rules-index.js）
- 下一步动作: 建议项 B 的 3b（把 tests/rules-depth、tests/linear-workflow、tests/execution-simplification 共约 231 处措辞锁收敛为共享常量加结构性断言）与 R-04（真实压缩恢复 case）
- 恢复提示: 先读 docs/inventory/harness-superpowers-comparison.md 的「处置状态（2026-09-14）」确认哪些 Finding 已关闭；仍未关闭的项在 docs/memory/TECH_DEBT.md；活跃上下文与最后验证日期见 .agents/memory/CURRENT.md
