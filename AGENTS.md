# AGENTS.md - LoopEngine 贡献指南

LoopEngine 用来打包可复用的 AI coding governance 资产。源项目只能作为只读输入；通用核心内容不得包含项目专有标识；声称完成前必须验证安装器和校验器行为。

## 深入文档

- 贡献流程、变更影响矩阵、PR 与发布要求见 `CONTRIBUTING.md`。
- 当前架构、规格、参考审计与历史归档从 `docs/README.md` 进入。

## 命令面边界

- 所有项目命令使用 `--project <temp-project>`；`--target codex|claude|gemini` 只选择 adapter。
- 真实写入统一使用 `--write`；`--apply`、`codex-internal` 和 `codex-minimal` 已移除。
- Codex `full` 写入红区文件时仍需 `--confirm-red-zone`。

## 必跑检查

- `pnpm check`
- 文档、catalog 或 schema 变更额外运行 `pnpm docs:audit`
- installer、profile、runtime 或工具变更额外运行 `pnpm test:integration` 和 `pnpm smoke:lifecycle`
- `pnpm loopengine init --project <temp-project>`
- `pnpm loopengine install --project <temp-project> --target codex --profile core --dry-run`
- `pnpm loopengine install --project <temp-project> --target codex --profile core --write`
- `pnpm loopengine validate --project <temp-project>`
- `pnpm loopengine init --project <full-temp-project> --profile full`
- `pnpm loopengine install --project <full-temp-project> --target codex --profile full --dry-run`
- `pnpm loopengine install --project <full-temp-project> --target codex --profile full --write --confirm-red-zone`
- `pnpm loopengine validate --project <full-temp-project>`
- `pnpm loopengine doctor --project <full-temp-project>`

## 安全规则

1. 安装器不得写入全局 Agent 配置。
2. 未使用 `--force` 时不得覆盖目标项目已有文件。
3. 安装、rollback 和卸载真实写入必须使用 `--write`，且未显式确认时不得写入红区文件。
4. 项目专有示例不得进入 `rules`、`templates`、`skills/core`、`adapters`、`manifests`、`schemas` 等通用核心目录。
5. 优先用 dry-run 和命令输出作为证据，不用猜测代替验证。

## codebase-memory-mcp

若 `codebase-memory-mcp` MCP 工具可用，理解或定位代码前先检查当前仓库索引状态，并按需使用结构查询。MCP 不可用时明确说明缺少该能力，退回 `rg` 和直接文件阅读；不要修改全局 Agent 或 MCP 配置。
