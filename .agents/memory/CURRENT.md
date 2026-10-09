# 当前活跃上下文

本文件是跨 session 恢复的唯一入口，记录当前任务的最小恢复线索。每次结束会话前更新，恢复时从本文件开始，再按其引用读取治理记忆。

<!-- 渲染说明：此模板含 render 占位符，安装时由 template-renderer 输出，内容不与 .agents/memory/CURRENT.md 逐字对应；实时活跃上下文见 .agents/memory/CURRENT.md。占位符：Vibe-Harness。 -->

项目阶段、技术债与决策经本文件引用 `docs/memory/PROJECT_STATE.md` 读取，不在此复制其内容；本文件只记录任务级恢复线索。

- 目标: 把治理审计批次 codex/governance-audit-batch 合并进 develop（PR #31），闭合 develop required fast gate 的证据链后再开 develop → main
- 当前状态: 工作区在分支 codex/governance-audit-batch 上修 PR #31 的 CI 阻塞项：`runtime/tools/rtk` 的 undici 由 7.29.0 升至 7.29.1（清掉 supply-chain 的 blocking）并刷新本文件与 docs/memory/PROJECT_STATE.md 的 memory 新鲜度（原先落后 HEAD 11 天）。合并路径已核实为 PR #31：develop ruleset 24096092 无 bypass 角色、禁止删除与强推、要求 `merge-gate`，直推会被 GH013 拒绝
- 已验证证据: 本轮 `pnpm runtime:audit`（`blocking: []`、`ok: true`，rtk high 由 1 降为 0）、`pnpm check:fast`（lint/typecheck/unit 177/177）、`node scripts/validate.js`（memory 新鲜度与自安装一致性通过）、`git diff --check`；PR #31 当前 head a29e9c6 的失败面为 full gate（memory 新鲜度）、supply-chain（rtk undici）与 independent review（缺 v2 收据）
- 未完成事项: PR #31 的 independent review 要求 v2 收据且 `contextIndependence=verified`，而 manifests/adapters.json 中 Codex 的 freshContext.evidence 仍是 configured-unverified，实现方无法自证 verified；develop → main PR 与 nightly H01–H20 模型背书回归仍未完成
- 下一步最小动作: 取得独立复审收据（需要宿主真实 fresh-context 证据或独立复审者）后重跑 PR #31 的 CI 并合并到 develop，再开 develop → main
- 锚点提交: a29e9c6a69e70e9ffb4c56abbe6f283033768595
- 最后更新: 2026-10-09
- 最后验证: 2026-10-09
