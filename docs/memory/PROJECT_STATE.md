# 项目状态

<!-- 渲染说明：此模板含 render 占位符，安装时由 template-renderer 输出，内容不与 docs/memory/PROJECT_STATE.md 逐字对应；实时项目状态见 docs/memory/PROJECT_STATE.md。占位符：Vibe-Harness。 -->

- 最后更新: 2026-09-24
- 当前阶段: 常驻指令面 token 效率审查批次已完成（分支 codex/governance-audit-batch）；P1 受管指令段落单源化、P2 常驻段瘦身、P3 大规则 Fast Path 卡片均已落地
- 当前重点: 常驻文本单源化后按实测 token 收敛长度，同时保留被用例钉住的行为不变量与三层档位命令渲染；按需读取的大规则改为「先读顶部卡片、超出卡片或命中升级触发再读全文」
- 下一步动作: 本批无遗留项；nightly H01–H20 模型背书回归仍需单独安排（已中断的 H01/H04/H06/H09 尚未取得证据）
- 恢复提示: 恢复唯一入口是 .agents/memory/CURRENT.md；本文件是被它引用的治理状态源。上一轮 P0–P2 架构审查批次的处置状态见 docs/inventory/harness-superpowers-comparison.md 的「处置状态（2026-09-14）」，未关闭项见 docs/memory/TECH_DEBT.md 的技术债清单；2026-09-22 优化范围见 audit-reports/2026-09-22-optimization-plan.md
