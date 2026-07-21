# Cognis 文档索引

本页是项目知识导航。文档角色和状态的机器真值位于 [`catalog.json`](catalog.json)；当前行为优先读取现行指南和现行规格，历史文件只用于审计。

## 现行指南

- [架构说明](architecture.md)：组件、安装数据流、profiles 和安全模型。
- [迁移指南](migration-guide.md)：从旧安装和旧治理资产迁移到当前版本。
- [Hook 场景与运行边界](hooks.md)：Codex hooks、Git hooks 和安全边界。
- [评测驱动开发](evals.md)：suite、run、reference、CI 和故障恢复。

## 现行规格

- [v0.7 自适应单/多 Agent 编排规格](specs/cognis-v0.7-adaptive-orchestration-spec.md)：当前三阶段路由、v2 父子任务合同、Prompt Cache 上下文边界与能力降级规则。
- [Agentmemory Skill 收敛规格](specs/agentmemory-skill-consolidation-spec.md)：当前 Agentmemory 安装与升级合同。
- [显式工具插件规格](specs/cognis-tooling-modules-spec.md)：7 个项目内工具的选择、版本校验、状态、规则和降级合同。

## 实施记录

- [COGNIS-MA-001 父子任务多 Agent 治理闭环](tasks/COGNIS-MA-001.md)：v0.6 合同、运行时、安装 surface 与验证记录。
- [COGNIS-MA-001 Red Team 审查包](reviews/COGNIS-MA-001-red-team.md)：独立核验结论、反例和剩余风险。
- [COGNIS-AO-001 自适应单/多 Agent 路由治理](tasks/COGNIS-AO-001.md)：v0.7 路由规则、评测和集成验证记录。
- [COGNIS-AO-001 Red Team 审查包](reviews/COGNIS-AO-001-red-team.md)：最终实际 diff、反例修复、独立核验结论与剩余风险。
- [COGNIS-AO-001 测试 child](tasks/COGNIS-AO-001-TESTS.md) / [测试 Red Team](reviews/COGNIS-AO-001-TESTS-red-team.md)：聚焦合同测试及 RED 证据。
- [COGNIS-AO-001 规范 child](tasks/COGNIS-AO-001-POLICY.md) / [规范 Red Team](reviews/COGNIS-AO-001-POLICY-red-team.md)：规则、Skill 和 v0.7 规格的限定实现与审查记录。

## 参考审计

- [源规则映射](inventory/source-rules-mapping.md)
- [源资产盘点](inventory/source-assets.md)
- [Skills 本地化与精简审计](inventory/skills-optimization-zh.md)
- [脱敏映射](inventory/redaction-map.md)
- [治理参考审计](inventory/governance-reference-analysis.md)

## 历史归档

- [归档索引](archive/README.md)：被取代的规格、已完成计划和历史发布清单。

## 根级入口

- [中文使用说明](../README.zh-CN.md) / [English README](../README.md)
- [贡献指南](../CONTRIBUTING.md)
- [Agent 规则](../AGENTS.md)
- [更新日志](../CHANGELOG.md)
