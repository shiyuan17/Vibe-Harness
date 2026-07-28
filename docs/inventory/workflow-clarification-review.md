# 工作流与需求澄清能力审查

审查日期：2026-07-28。范围：Cognis 规范与工作流，重点为需求澄清能力提升与不必要流程裁剪。本审查结合业界最佳实践（GitHub spec-kit、Anthropic、Cognition、AWS Kiro、MCP Elicitation）给出改进方案并记录已落地变更。

## 前提

本仓库已完成一次去仪式化重构：v0.4–v0.9 治理规格全部归档为 Superseded；强制规划门、Tester/Reviewer/Handoff 角色派发、交付文本门禁、fan-in 集成验证、自适应基准均已破坏性移除并由 `tests/skill-closure.test.js` 守护。`COGNIS_OBSOLETE_GOVERNANCE_CONFIG` 主动拒绝旧配置。因此本审查主线是补强澄清能力 + 清理重构残留，而非再砍流程。

## 现状工作流

单一路径：`获取事实 -> 直接执行 -> 聚焦验证 -> 简洁交付`。无强制规划/Review/任务记录阶段。风险档位（快速/轻量/完整）只影响验证强度与审批，非状态机。Skill 由宿主按 description 直接选择，不使用 Router 或流程链。clarify-requirements 与 define-goal 是按需插入的条件能力，非默认阶段。

## 澄清能力评估

`clarify-requirements` Skill 已高度对齐 2024–2026 共识：三分类（安全审批/阻塞产品决定/可逆实现选择）、"什么会改变我的行动"测试、options-with-tradeoffs、单轮 ≤3 上限、禁止问实现细节。识别出五处空缺并已落地前三项：

1. **Impact×Uncertainty 筛选器**（已落地）：候选超过三个时按影响×不确定性排序丢弃低分项，直接打击 over-asking。
2. **可配置自治姿态**（已落地）：`clarification.posture`（action-leaning/balanced/conservative），影响阻塞阈值。
3. **轻量规格中间档**（已落地）：扩展显式需求发现分支，非平凡特性可输出自包含单页规格，小任务跳过。
4. clarify↔define-goal 触发边界（已落地）：当轮解阻 vs 跨任务持久目标。
5. few-shot 对照示例（已落地）：`references/examples.md`。

## 已落地变更

### P0 澄清能力补强

- `skills/core/clarify-requirements/SKILL.md`：加 Impact×Uncertainty 筛选器、轻量规格档、自治姿态读取、few-shot 引用；同步安装副本。
- `skills/core/clarify-requirements/references/examples.md`：新增 few-shot 对照示例（好澄清/坏澄清/依赖型）。
- `skills/core/clarify-requirements/metadata.json`：triggers 加"需求规格"，outputs 加"单页规格"。
- `adapters/codex/install-map.json`：加 clarify-requirements/references/examples.md 安装映射。
- `scripts/lib/project-config.js`：`defaultProjectConfig` 加 `clarification.posture: 'balanced'`；`validateProjectConfig` 加 posture 校验。
- `scripts/lib/install-planner.js`：`createInstalledSurface` 加 `clarificationPostureLine`（仅安装 clarify-requirements 时输出）；两处调用点传入 posture。
- `scripts/lib/template-renderer.js`：`defaultTemplateData.installedSurface` 加 `clarificationPostureLine` 默认空串。
- `adapters/codex/AGENTS.template.md`：已安装表面段加 `{{installedSurface.clarificationPostureLine}}`。
- `cognis.config.json`：加 `clarification.posture: "balanced"`。

### P1 工作流微调

- `rules/agent-skill-routing.md` + `docs/rules/AGENT_SKILL_ROUTING.md`：明确 clarify（当轮解阻）↔ define-goal（跨任务持久目标）触发边界。
- `rules/governance-core.md` + `docs/rules/governance-core.md`：加显式规划阈值——一句话能描述的 diff 直接执行，仅在方向未定/跨多文件/不熟悉代码时先规划。

### P2 重构残留清理

- `rules/test-rules.md` → `docs/rules/test-rules.md`：同步 2 行验证记录说明的模板→渲染漂移。
- `adapters/codex/install-map.json`：补全 10 个 retired 流程 skill 的 retiredEntries（修复 pre-existing 的 skill-closure 测试失败）。
- `.agents/skills/systematic-debugging/`：删除孤儿引用文件（root-cause-tracing.md、condition-based-waiting.md、defense-in-depth.md、condition-based-waiting-example.ts），与源一致。
- `rules/eval-driven-development.md` + `docs/rules/eval-driven-development.md` + `skills/core/eval-driven-development/SKILL.md` + 安装副本：规则↔Skill 加交叉引用防漂移。
- `docs/architecture.md`：标注 `rules/`（模板源）与 `docs/rules/`（渲染产物）关系。

## 未引入（避免重新仪式化）

以下有业界讨论但未引入，因其与研究证据冲突或与去仪式化方向相悖：强制多角色并行派发（Cognition 证明净负向）、planner/executor 拆分（易错）、长会话累积纠错（clean session 更优）。可选的"独立上下文复审"子 Agent（Cognition 唯一推荐的多 Agent 模式）留作 P3 待评估。

## 验证

- `pnpm eval:clarification`：24 cases 通过。
- `tests/skill-closure.test.js`：7/7 通过（含修复的 retirement catalog 测试）。
- `pnpm test:unit`：20/20 通过。
- config 校验：三姿态合法值通过，非法值拒绝。
- AGENTS 模板渲染：posture 行正确出现在已安装表面段。
