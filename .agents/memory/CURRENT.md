# 当前活跃上下文

本文件是跨 session 恢复的唯一入口，记录当前任务的最小恢复线索。每次结束会话前更新，恢复时从本文件开始，再按其引用读取治理记忆。

<!-- 渲染说明：此模板含 render 占位符，安装时由 template-renderer 输出，内容不与 .agents/memory/CURRENT.md 逐字对应；实时活跃上下文见 .agents/memory/CURRENT.md。占位符：Vibe-Harness。 -->

项目阶段、技术债与决策经本文件引用 `docs/memory/PROJECT_STATE.md` 读取，不在此复制其内容；本文件只记录任务级恢复线索。

- 目标: 修复 gd-flow／lwflow 引入的 eval reference 漂移（config／rules／skills 三组），并补齐这两个显式 develop flow 的交付记录（ADR-0015、CHANGELOG 与恢复锚点），完成 codex/delivery-batch 的 PR #34 收尾批次
- 当前状态: 本批已按序落地：先用官方入口五步再生成 eval reference 与行为产物（run status passed、overallScore 1、criticalPassRate 1、skills 文件数 135→144），再新增 ADR-0015 与四个投影、CHANGELOG Unreleased 条目与恢复锚点；按 chore(eval) → docs(adr+changelog) → docs(memory) 三批提交并推送到 codex/delivery-batch（PR #34 已有 upstream），尚未合并，也未改动规则、Skill 与 runtime 行为
- 已验证证据: pnpm eval:check（ok true、errors 空）、pnpm eval:replay（passed）、pnpm eval:behavioral（passed）、pnpm eval:sync（drift 0）、pnpm check 全绿（含 eval-contract、adr-validation、memory-entry、memory-freshness、docs-projection）、pnpm docs:audit（143 篇）、pnpm docs:sync、pnpm pack:contract 与 git diff --check 全部通过；reference 旧文件备份于 .vibe-harness/backups/2026-10-12T11-31-32-131Z/ 与 2026-10-12T11-31-39-420Z/、2026-10-12T11-31-42-192Z/
- 未完成事项: PR #34（codex/delivery-batch）推送后的复审、单复审者收据与合并；BL-CNAS 回灌仍被 fail-closed 拒绝（.cbmignore 与 .githooks/pre-commit、.githooks/pre-push、.codex/hooks.json 和 install-state 记录不一致，需先人工对齐受管文件）；develop → main 提升与 nightly H01–H20 背书回归；backup/governance-audit-batch 等陈旧分支清理
- 下一步最小动作: 推送本批三提交后复核 PR #34 的检查与单复审者收据并推进合并；随后与 BL-CNAS 侧确认受管文件漂移的处理方式（对齐内容或在其仓库提交中重记基线），重跑 install --upgrade --write 与 validate 并补 hook 干跑
- 锚点提交: 755750d6d4ac05f12faa66710f87bda3d3949f32
- 最后更新: 2026-10-12
- 最后验证: 2026-10-12
