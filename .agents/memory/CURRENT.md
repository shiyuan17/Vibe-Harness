# 当前活跃上下文

本文件是跨 session 恢复的唯一入口，记录当前任务的最小恢复线索。每次结束会话前更新，恢复时从本文件开始，再按其引用读取治理记忆。

<!-- 渲染说明：此模板含 render 占位符，安装时由 template-renderer 输出，内容不与 .agents/memory/CURRENT.md 逐字对应；实时活跃上下文见 .agents/memory/CURRENT.md。占位符：Vibe-Harness。 -->

项目阶段、技术债与决策经本文件引用 `docs/memory/PROJECT_STATE.md` 读取，不在此复制其内容；本文件只记录任务级恢复线索。

- 目标: 把治理批次按 git 规范分批提交推送，先开 PR 合并到 develop（PR #31），再按正常策略经 develop → main 合并到 main
- 当前状态: 已建 develop 分支（基于 main 17fb8f3）并推送；PR #31 head=codex/governance-audit-batch、base 已改为 develop；本批 6 个提交已推送（db02a2a 墙钟规划契约、9c32cac v3 回执与运营指标、8ef5a50 develop required gate 规则、ea4f93b develop CI required gate、ef3dbc6 规划/回执/计划校验用例、79ccf5c 离线 reference 与运行指纹刷新）；ruleset 已收敛（main 20501924 只留 product+merge-gate，develop 24096092 新建 required merge-gate）
- 已验证证据: 79ccf5c 之前于 ef3dbc6 上 `pnpm check:fast` passed（lint 285 文件、typecheck、unit 175/175）、`pnpm test:integration` 575 用例 574 pass/1 skip/0 fail、`pnpm skills:audit`、`pnpm docs:audit`、`pnpm tests:catalog check` 通过；本轮 eval run 后按 CONTRIBUTING 清单提升 reference（漂移分组 config/rules/skills，aggregate 54f97ffd、config e9e6e5eb/42、rules bbc138c2/50、skills 1ea95470/128），旧文件备份在 .vibe-harness/backups/，随后 eval:sync --write（drift 0）、eval:replay --write、eval:behavioral --write、eval:check passed
- 未完成事项: 独立复审收据（independent review 已 required）须由独立审查者产出，尚未指定审查者；PR #31 的 merge-gate 需新 push 触发才能读到新正文；develop → main 的 PR 尚未开；nightly 模型背书回归（H01/H04/H06/H09）仍未取得证据
- 下一步最小动作: 推送本批后核对 origin/codex/governance-audit-batch 与本地一致，`gh pr checks 31` 观察 branch policy 与 merge-gate；取得独立复审收据后合并至 develop，再开 develop → main
- 锚点提交: 79ccf5c8c8c23cf7a0a73284e867dc423d0f04e9
- 最后更新: 2026-09-28
- 最后验证: 2026-09-28
