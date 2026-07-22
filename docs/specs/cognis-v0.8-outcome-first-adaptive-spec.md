# Cognis v0.8 结果优先自适应执行路径

状态：Implemented（在线 40×3 对照结果由 nightly/release runner 生成，不在源码中预填）。

## 目标与兼容性

新项目默认 `governance.workflow: adaptive`，运行 `获取事实 → 直接执行 → 聚焦验证 → 简洁交付`。`governance.mode` 仍只表示 `off/basic/full` 的安装与校验深度。缺少 workflow 的既有配置按 `strict` 解析；显式 `install --upgrade` 会写入 `strict`，避免静默改变旧项目行为。Codex、Claude 与 Gemini 共享规则语义，只有 Codex 安装 Hook。

## Adaptive Runtime 合同

- 清晰、已授权、可逆的本地读写、测试和修复直接推进，不要求工具前任务确认、计划批准或任务文档。
- 用户输入只用于无法由事实确定的产品分支、外部/生产/权限/凭据/红区/不可逆动作、实质扩 scope、active task 归属冲突，或同一失败三次无进展。
- 独立产品决定同轮批量询问；实现细节、仓库事实和验证命令由 Agent 负责。
- 计划、TDD、调试、审查、Eval 与领域 Skill 按失败或风险信号触发；普通任务不加载 Skill 链。
- 完整任务继续使用 v1/v2 控制块和 Red Team 门禁，不新增 v3 schema。

## Codex Hook 合同

Adaptive 只安装 `SessionStart`、`PostCompact`、`PreToolUse`、`SubagentStart`、`SubagentStop`、`Stop`。恢复事件只在有 active task 时注入有界上下文；`PreToolUse` 只承担高置信破坏性命令、项目外/全局 Agent 配置和红区防线；普通 Stop 不运行 Eval，只检查结果、实际变更和本轮验证。存在 active 完整任务时，Stop 继续运行治理门禁。Strict 安装原有 10 事件集合和完整 11 字段交付合同。

## 对照评测合同

`evals/workflow-benchmark/cases.json` 固定 40 个一次性项目案例：18 个本地实现、8 个产品歧义、6 个本地跨模块、4 个恢复/Agent、4 个安全场景；smoke 固定 12 个，完整运行每路径每案例 3 次。run 必须记录 pass、Token、墙钟、阻塞交互、工具调用、无动作轮次、范围违规、错误完成声明和 trajectory 标签。

发布比较使用同模型、reasoning effort、工具、预算和超时：配对 pass@1 的按任务 bootstrap 95% 下界不低于 `-2pp`；critical 安全为零失败；双方均成功尝试中，阻塞交互、墙钟和 Token 中位数分别至少下降 40%、30% 和 35%。报告必须同时包含全部尝试的每成功任务 Token 与墙钟成本，不能只报告共同成功子集。

PR 运行 12 案例 smoke 或在 runner 不可用时降级为合同检查；nightly 与 release 执行 40×3 对照。Release reference 不得因 runner 不可用而批准，reference 更新继续独立审查。

## 方法依据

- [Comet 0.4.0-beta.8](https://github.com/rpamis/comet/tree/0.4.0-beta.8)：吸收 Runtime 状态、证据、恢复与自动推进思路，不引入依赖，也不复用其只统计双方成功样本的效率结论。
- [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model)：删除重复指令，明确紧凑授权边界。
- [OpenAI Running Codex safely](https://openai.com/index/running-codex-safely/)：按风险分层审批，低风险本地动作自动继续。
- [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)：恢复上下文只保留高信号状态。
- [SkillsBench](https://arxiv.org/abs/2602.12670)：聚焦 Skill，避免无关 Skill 降低表现。
- [Harness-Bench](https://arxiv.org/abs/2605.27922)：以“模型 + Harness”整体测量完成率与成本。

“保证完成率”在本规格中表示统计非劣与 critical 零回退，不表示不可验证的绝对保证。
