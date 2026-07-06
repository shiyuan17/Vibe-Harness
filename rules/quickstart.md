# Quickstart

使用足以安全完成任务的最小阅读路径。

## 三层阅读

| 层级 | 何时阅读 | 内容 |
| --- | --- | --- |
| 入口层 | 每次续接 | `AGENTS.md`、项目状态、架构概览、quickstart |
| 任务层 | 实现前 | 命中的 workflow、task、API、UI、test 或 review 规则 |
| 底座层 | 跨层或红区任务 | coding、git、workflow、review、release、security 等规则 |

## 场景映射

| 信号 | 最小工作流 | 最小验证 |
| --- | --- | --- |
| 纯文档或只读 | Fast Path | markdown/governance 检查 |
| 页面、组件、布局 | UI | lint、typecheck、聚焦 UI/browser 检查 |
| API client、mapper、mock | API | mapper/service 测试；必要时后端契约核对 |
| 共享架构或构建脚本 | Architecture | lint、typecheck、循环依赖/依赖检查 |
| 权限、敏感数据、审计、发布 | Full | 测试、独立审查和 Red Team 证据 |
| 显式 loop | Loop | Loop Packet 和 ledger 证据 |
