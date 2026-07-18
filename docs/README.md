# Cognis 文档索引

本页是项目知识导航。文档角色和状态的机器真值位于 [`catalog.json`](catalog.json)；当前行为优先读取现行指南和现行规格，历史文件只用于审计。

## 现行指南

- [架构说明](architecture.md)：组件、安装数据流、profiles 和安全模型。
- [迁移指南](migration-guide.md)：从旧安装和旧治理资产迁移到当前版本。
- [Hook 场景与运行边界](hooks.md)：Codex hooks、Git hooks 和安全边界。
- [评测驱动开发](evals.md)：suite、run、reference、CI 和故障恢复。

## 现行规格

- [v0.5 中文精简治理规格](specs/cognis-v0.5-simplified-governance-spec.md)：当前治理合同。
- [Agentmemory Skill 收敛规格](specs/agentmemory-skill-consolidation-spec.md)：当前 Agentmemory 安装与升级合同。

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
