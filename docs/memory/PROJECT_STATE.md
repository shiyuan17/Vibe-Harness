# 项目状态

<!-- 渲染说明：此模板含 render 占位符，安装时由 template-renderer 输出，内容不与 docs/memory/PROJECT_STATE.md 逐字对应；实时项目状态见 docs/memory/PROJECT_STATE.md。占位符：Vibe-Harness。 -->

- 最后更新: 2026-09-26
- 当前阶段: 常驻指令面 token 效率审查批次已推送；新一批规则与验证改进已在分支 codex/governance-audit-batch 落地（codegraph 证据复用与降级边界、warm 环境复用契约、L0-L6 层级表述统一、十二层责任地图、GC 覆盖 docs/rules、离线 reference 指纹刷新），验证通过后按分批提交推送
- 当前重点: 让规则与验证口径可判定——codegraph 已返回的当前源码不重复取证、图关系不替代行为证据；已就绪环境按 reuse key 复用且失效即回退；证据层级、成本档与运行范围保持三个独立维度；GC 只产出待复核候选
- 下一步动作: 核对远端分支同步后安排 nightly H01–H20 模型背书回归（已中断的 H01/H04/H06/H09 尚未取得证据）
- 恢复提示: 恢复唯一入口是 .agents/memory/CURRENT.md；本文件是被它引用的治理状态源。上一轮 P0–P2 架构审查批次的处置状态见 docs/inventory/harness-superpowers-comparison.md 的「处置状态（2026-09-14）」，未关闭项见 docs/memory/TECH_DEBT.md 的技术债清单；2026-09-22 优化范围见 audit-reports/2026-09-22-optimization-plan.md
