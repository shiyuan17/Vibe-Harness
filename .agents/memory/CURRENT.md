# 当前活跃上下文

本文件是跨 session 恢复的唯一入口，记录当前任务的最小恢复线索。每次结束会话前更新，恢复时从本文件开始，再按其引用读取治理记忆。

<!-- 渲染说明：此模板含 render 占位符，安装时由 template-renderer 输出，内容不与 .agents/memory/CURRENT.md 逐字对应；实时活跃上下文见 .agents/memory/CURRENT.md。占位符：Vibe-Harness。 -->

项目阶段、技术债与决策经本文件引用 `docs/memory/PROJECT_STATE.md` 读取，不在此复制其内容；本文件只记录任务级恢复线索。

- 目标: 交付工具退役批次——退役 rtk、ast-grep、codegraph、serena、probe 与 codebase-memory 的本地安装面，codebase-memory-mcp 收敛为仅分发使用规范——并按逻辑分组提交后推送到 codex/delivery-batch
- 当前状态: 本批已按 feat(runtime)! → docs(rules+readme+changelog) → test(validation) → eval(assets) 四组提交（2b9f9f5、93533a3、c3e8f5c、b3617f0），工作区干净、尚未推送；提交前修正 tests/integration/project-profile.test.js 中残留的 core 分发旧断言（core 现随 rules-core 分发 codebase-memory-mcp 规则）；工具退役批次的状态锚点为 .vibe-harness/tasks/tool-retirement.json（stage=verify）
- 已验证证据: pnpm check（lint、ESLint、typecheck、validate、tests:catalog check、unit、component 339/339）、pnpm test:integration（647 例、646 通过、1 跳过、0 失败）、pnpm eval:check、pnpm docs:audit（139 篇文档）与 git diff --check 通过；组件层的 memory-entry、memory-freshness 与 docs-projection 随本次 memory 更新复跑
- 未完成事项: 本次推送与 PR #34 复审；BL-CNAS 回灌仍被 fail-closed 拒绝（.cbmignore 与 .githooks/pre-commit、.githooks/pre-push、.codex/hooks.json 和 install-state 记录不一致，需先人工对齐受管文件）；develop → main 提升与 nightly H01–H20 背书回归；backup/governance-audit-batch 等陈旧分支清理；工具退役未改动宿主 Hook 启用状态，在线 Agent 行为未验证
- 下一步最小动作: 推送四提交后复核 PR #34 的检查与单复审者收据并推进合并；随后与 BL-CNAS 侧确认受管文件漂移的处理方式（对齐内容或在其仓库提交中重记基线），重跑 install --upgrade --write 与 validate 并补 hook 干跑
- 锚点提交: b3617f0cd7a87701d23d582dfb55d0903aca3980
- 最后更新: 2026-10-14
- 最后验证: 2026-10-14
