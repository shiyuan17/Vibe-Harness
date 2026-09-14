# 当前活跃上下文

本文件是跨 session 恢复的首选入口，记录当前任务的最小恢复线索。每次结束会话前更新，恢复时优先读取。

<!-- 渲染说明：此模板含 render 占位符，安装时由 template-renderer 输出，内容不与 .agents/memory/CURRENT.md 逐字对应；实时活跃上下文见 .agents/memory/CURRENT.md。占位符：Vibe-Harness。 -->

- 目标: 完成 harness 规范与工作流第一性原理审查结论的落地（第 1–4 项与建议项 A–D）
- 当前状态: 第 1–4 项、建议项 A（Eval 指纹与结账形态解耦并再生成 reference）、4a（已安装表面规则索引）、C（审查台账与 TECH_DEBT 记账）已完成；建议项 3b（措辞锁收敛）与 R-04 未开工
- 已验证证据: pnpm check 301/301；pnpm eval:check 与 pnpm eval:replay 通过；pnpm test:eval 206 pass 0 fail 1 既有跳过；node --test tests/tooling-modules.test.js 30/30；vibe-harness validate --project . 为 ready；eval run 的资产诊断为 0 且 reference.status 为 matched；git diff --check 干净
- 未完成事项: 建议项 3b（三份测试共约 231 处措辞锁）、R-04；docs/memory/IMPROVEMENTS.json 仍为空队列（ID 由 mergeImprovementCandidates 从 receipt 派生，不得手工伪造）
- 下一步最小动作: 抽出规范措辞共享常量表并把三份测试的措辞断言改为结构性断言
- 最后更新: 2026-09-14
- 最后验证: 2026-09-14
