# 当前活跃上下文

本文件是跨 session 恢复的首选入口，记录当前任务的最小恢复线索。每次结束会话前更新，恢复时优先读取。

<!-- 渲染说明：此模板含 render 占位符，安装时由 template-renderer 输出，内容不与 .agents/memory/CURRENT.md 逐字对应；实时活跃上下文见 .agents/memory/CURRENT.md。占位符：Vibe-Harness。 -->

- 目标: 完成 harness 规范与工作流第一性原理审查结论的落地（第 1–4 项与建议项 A–D）
- 当前状态: 第 1–4 项、建议项 A（Eval 指纹与结账形态解耦并再生成 reference）、3b（措辞锚点收敛到单一合同表）、4a（已安装表面规则索引）、C（审查台账与 TECH_DEBT 记账）、R-04（宿主可控真实压缩恢复 case）均已完成；本轮审查结论的落地项全部关闭
- 已验证证据: pnpm eval:check 与 pnpm eval:replay 通过；pnpm eval:replay --write 在真实仓库报 status=current、reference=matched（签入 run 就是确定性重放输出）；eval run 的资产诊断为 0 且 reference.status 为 matched；R-04 本机实测 EVAL-EXEC-COMPACT-001：records=1、HEAD 不变、score 1；offline reference 于 2026-09-14 10:18Z 按正规入口再生成（漂移组 config+rules，依据见 CHANGELOG）；git diff --check 干净
- 未完成事项: docs/memory/IMPROVEMENTS.json 仍为空队列（ID 由 mergeImprovementCandidates 从 receipt 派生，不得手工伪造）；剩余建议项 R-05、R-06、R-07 未排期；签入 replay 产物已由 `pnpm eval:replay --write` 提供正规生成入口（TD-2026-09-14-3 关闭）
- 下一步最小动作: 若要继续审查建议项，按 P1→P2 顺序做 R-05（review-feedback 压力 case）或决定其排期
- 最后更新: 2026-09-14
- 最后验证: 2026-09-14
