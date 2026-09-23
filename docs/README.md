# Vibe-Harness 文档索引

本页索引当前文档。机器真值位于 [`catalog.json`](catalog.json)；[`archive/`](archive/) 只用于历史追溯。

## 当前产品

- [架构](architecture.md)
- [角色系统](roles.md)
- [ADR 指南](adr/README.md)
- [ADR 索引](adr/catalog.json)
- [ADR-0001：Linear 显式执行身份与原生 DAG 契约](adr/ADR-0001-linear-explicit-execution-and-dag.md)
- [ADR-0002：Linear Execution Envelope、恢复与交付边界](adr/ADR-0002-linear-execution-envelope-and-recovery.md)
- [ADR-0003：开发集成与发布提升的轻量 GitFlow](adr/ADR-0003-lightweight-gitflow.md)
- [ADR-0004：任务拆分治理与 DAG 状态一致性](adr/ADR-0004-task-decomposition-governance.md)
- [ADR-0005：规则治理：SSOT、排版与本地化](adr/ADR-0005-rules-governance.md)
- [ADR-0006：发布边界门禁与 Writer 落地 develop 合并](adr/ADR-0006-release-gated-ci-writer-landed-merges.md)
- [DAG result 引入 unverified](adr/ADR-0007-dag-result-unverified.md)
- [ADR Schema](schemas/adr.schema.json)
- [Execution Envelope v1 Schema](schemas/execution-envelope.schema.json)
- [Execution Envelope v2 Schema](schemas/execution-envelope-v2.schema.json)
- [Project Verification Receipt Schema](schemas/project-verification.schema.json)
- [Project Config Schema](schemas/project-config.schema.json)
- [ADR 模板](../templates/adr/adr-template.md)
- [ADR 源 Schema](../schemas/adr.schema.json)
- [Execution Envelope v1 源 Schema](../schemas/execution-envelope.schema.json)
- [Execution Envelope v2 源 Schema](../schemas/execution-envelope-v2.schema.json)
- [Project Verification Receipt 源 Schema](../schemas/project-verification.schema.json)
- [Project Config 源 Schema](../schemas/project-config.schema.json)
- [迁移指南](migration-guide.md)
- [Hook 安全策略](hooks.md)
- [Hook 运行时诊断规格](specs/hook-runtime-diagnostics-spec.md)
- [Eval](evals.md)
- [Harness Evals 统一架构](specs/harness-evals-framework.md)
- [项目审计](audits.md)
- [GitHub 可靠交付配置](github-delivery.md)
- [Agentmemory Skill 规格](specs/agentmemory-skill-consolidation-spec.md)
- [显式工具插件规格](specs/vibe-harness-tooling-modules-spec.md)
- [Linear 多 Agent 工作流规格](specs/linear-multi-agent-workflow-spec.md)

## 规则

分组与 `scripts/lib/rules-index.js` 的 RULE_GROUPS 一致，与 AGENTS.md 托管块生成的命中索引同构。

### 治理

- [执行内核](rules/governance-core.md)
- [Skill 编写与路由](rules/agent-skill-routing.md)
- [Eval](rules/eval-driven-development.md)
- [角色路由](rules/role-routing.md)
- [Git](rules/git-rules.md)
- [测试](rules/test-rules.md)
- [AI 协作](rules/ai-collab-rules.md)
- [审查报告规则](rules/review-report.md)
- [表达模式规则](rules/response-modes.md)

### 工程

- [编码](rules/coding-rules.md)
- [前端](rules/frontend-rules.md)
- [API](rules/api-rules.md)
- [数据库](rules/db-rules.md)
- [可观测性与日志](rules/log-management.md)
- [项目目录](rules/project-directory.md)
- [项目专项](rules/project-specific-rules.md)

### 工具与集成

- [codebase-memory-mcp](rules/codebase-memory-mcp.md)
- [Chrome DevTools MCP](rules/chrome-devtools-mcp.md)
- [Linear 工作流](rules/linear-workflow.md)
- [RTK](rules/rtk.md)
- [ast-grep](rules/ast-grep.md)
- [codegraph 仓库索引探索规则](rules/codegraph.md)
- [serena 语义符号导航规则](rules/serena.md)
- [probe 轻量代码检索规则](rules/probe.md)

### 发布与排障

- [发布](rules/release-rules.md)
- [排障](rules/troubleshooting.md)

## Schema

- [角色包 Schema](schemas/role-pack.schema.json)
- [Harness Eval Scenario v3](schemas/harness-eval-scenario.schema.json)
- [Harness Eval Fixture](schemas/harness-eval-fixture.schema.json)
- [Harness Eval Result v3](schemas/harness-eval-result.schema.json)

## 模板与记忆

- [可选任务记录](templates/task.md)
- [简洁交付记录](templates/delivery.md)
- [全生命周期工作流](templates/workflow.md)
- [<主题> 审查报告](templates/finding-report.md)
- [跨层一致性审查（find-question）](templates/find-question.md)
- [项目状态](memory/PROJECT_STATE.md)
- [架构记忆](memory/ARCHITECTURE.md)
- [决策](memory/DECISIONS.md)
- [故障学习](memory/FAILURE_LEARNINGS.md)
- [已知问题](memory/KNOWN_BUGS.md)
- [技术债](memory/TECH_DEBT.md)
- [改进候选](memory/IMPROVEMENTS.json)

## 审计参考

inventory 快照规则：含计数口径的条目必须标注快照日期与再生成方式；计数被取代的快照移入 [`archive/`](archive/)，原文不回溯改写。

- [源规则映射](inventory/source-rules-mapping.md)
- [源资产](inventory/source-assets.md)
- [Skills 精简](inventory/skills-optimization-zh.md)
- [脱敏映射](inventory/redaction-map.md)
- [参考分析](inventory/governance-reference-analysis.md)
- [工作流与澄清能力审查](inventory/workflow-clarification-review.md)
- [Pre-existing 测试失败处理方案](inventory/preexisting-test-failures-remediation.md)
- [AI 专属 Eval 体系调查报告](inventory/ai-eval-investigation.md)
- [Vibe-Harness 与 Superpowers 系统审查](inventory/harness-superpowers-comparison.md)
- [表达模式层调研](inventory/response-mode-investigation.md)
- [治理规范与工作流审计（2026-09）](inventory/governance-audit-2026-09.md)

## 历史

- [归档索引](archive/README.md)

## 根级入口

- [中文 README](../README.md)
- [English README](../README.en.md)
- [贡献指南](../CONTRIBUTING.md)
- [Agent 规则](../AGENTS.md)
- [更新日志](../CHANGELOG.md)
