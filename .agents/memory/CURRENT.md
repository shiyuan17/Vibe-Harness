# 当前活跃上下文

本文件是跨 session 恢复的唯一入口，记录当前任务的最小恢复线索。每次结束会话前更新，恢复时从本文件开始，再按其引用读取治理记忆。

<!-- 渲染说明：此模板含 render 占位符，安装时由 template-renderer 输出，内容不与 .agents/memory/CURRENT.md 逐字对应；实时活跃上下文见 .agents/memory/CURRENT.md。占位符：Vibe-Harness。 -->

项目阶段、技术债与决策经本文件引用 `docs/memory/PROJECT_STATE.md` 读取，不在此复制其内容；本文件只记录任务级恢复线索。

- 目标: 实施已批准的《Vibe-Harness 与 BL-CNAS 工作流优化执行计划》W0–W5：先修 Vibe-Harness 通用机制（配置—计划—执行契约、收据复用），再做 BL-CNAS 试点，最后受控减负与对照评测
- 当前状态: 工作区未提交（Vibe-Harness 分支 codex/governance-audit-batch，BL-CNAS 分支 develop）。Vibe-Harness 已落地 W1/W2 共享模块（runtime/lib/verification-plan.mjs、runtime/lib/verification-receipt.mjs 及 .agents/runtime/lib/ 镜像）与 W4 规则单源化（scripts/lib/install-planner.js 检索入口默认单值 + 角色按需加载；docs/rules/role-routing.md、docs/rules/codebase-memory-mcp.md；AGENTS.md 受管块已重投影且 self-install conformance 通过）。BL-CNAS 已落地 W3：frontend/scripts/validation-runner.mjs（原子检查、前后端分流、Maven Wrapper、契约只读阶段、DM8 blocked）、frontend/scripts/vitest-changed.mjs（vitest related 主选择器 + 覆盖缺口拦截 + 分片 + quotepath）、frontend/scripts/fixtures/vitest-related/** 与两个测试文件、vibe-harness.config.json、frontend/package.json 新增 backend 原子入口
- 已验证证据: Vibe-Harness `pnpm check:fast` 177/177、`pnpm test:integration` 603 用例 602 pass/1 skip/0 fail、`pnpm test:component` 327 用例 322 pass（5 项失败全部为 eval 资产指纹漂移）、`node scripts/validate.js` self-install conformance 通过、`node scripts/tests-catalog.js check` clean；BL-CNAS 一次真实混合变更 `bun run --cwd frontend verify:changed` 全绿（lint 100.1s、typecheck 0.7s、test 238 文件/1650 用例 465.3s、contract-parity 0.7s、backend-test 462 用例 BUILD SUCCESS 339s）；两侧 `git diff --check` 干净
- 未完成事项: W5 的 36 次对照实验与随后 20 个真实任务被动观察尚未执行（提效未证实）；`pnpm check` 的 5 项 eval 资产指纹漂移待宿主受保护审批后按 CONTRIBUTING 清单重签；BL-CNAS 受管面（AGENTS.md 受管块、vibe-harness.config.json）迁移需 --confirm-red-zone 授权；DM8 集成缺 DM8_* 环境返回 blocked；后端聚焦映射仅覆盖 organization/iam，其余回退完整后端单测。上一批 PR #31 的独立复审收据、develop → main PR 与 nightly 模型背书回归仍未完成
- 下一步最小动作: 按 audit-reports/2026-09-28-workflow-optimization-status.md 第 8 节推进：取得受保护审批后重签 eval reference 并重跑 pnpm check；再按同一报告第 6 节的固定口径执行 W5 对照实验
- 锚点提交: d4f71f02b986f31fba8ab99e3185dbd2fc4457d8
- 最后更新: 2026-09-28
- 最后验证: 2026-09-28
