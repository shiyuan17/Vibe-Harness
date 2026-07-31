# AGENTS.md - Cognis 贡献指南

Cognis 用来打包可复用的 AI coding 项目规则、领域 Skills、安全 Hook 和安装器。源项目只能作为只读输入；通用内容不得包含项目专有标识。

## 深入文档

- 贡献流程、变更影响矩阵、PR 与发布要求见 `CONTRIBUTING.md`。
- 当前架构、规格、参考审计与历史归档从 `docs/README.md` 进入。
- 执行内核与可选交付简表分别见 `rules/governance-core.md` 和 `templates/delivery.md`。

## 命令面边界

- 所有项目命令使用 `--project <temp-project>`；`--target codex|claude|gemini` 只选择 adapter。
- 真实写入统一使用 `--write`；`--apply`、`codex-internal` 和 `codex-minimal` 已移除。
- 项目生命周期使用 `--project <temp-project>`，预览使用 `--dry-run`，真实写入使用 `--write`。
- Codex `full` 写入红区文件时仍需 `--confirm-red-zone`。

## 验证选择

- `pnpm check`
- 文档、catalog 或 schema 变更额外运行 `pnpm docs:audit`
- installer、profile、runtime 或工具变更额外运行 `pnpm test:integration` 和 `pnpm smoke:lifecycle`
- 只运行与变更和完成主张匹配的聚焦检查；不要自动派发 Review/Test 角色。

## 安全规则

1. 安装器不得写入全局 Agent 配置。
2. 未使用 `--force` 时不得覆盖目标项目已有文件。
3. 安装、rollback 和卸载真实写入必须使用 `--write`，且未显式确认时不得写入红区文件。
4. 项目专有示例不得进入 `rules`、`templates`、`skills/core`、`adapters`、`manifests`、`schemas` 等通用核心目录。
5. 优先用 dry-run 和命令输出作为证据，不用猜测代替验证。

## codebase-memory-mcp

若 `codebase-memory-mcp` MCP 工具可用，理解或定位代码前先检查当前仓库索引状态，并按需使用结构查询。MCP 不可用时明确说明缺少该能力，退回 `rg` 和直接文件阅读；不要修改全局 Agent 或 MCP 配置。

<!-- COGNIS:START -->
# AGENTS.md

项目：Cognis

## 启动

1. 阅读 `docs/rules/governance-core.md`、`docs/rules/AGENT_SKILL_ROUTING.md` 和命中场景的专项规则。
2. 编辑前运行 `git status --short`，保护用户未归属改动。
3. 使用仓库搜索和已安装规则定位相关代码；需要结构化索引时先确认目标项目已有能力。
4. 将任务归为快速、轻量或完整，并选择与主张匹配的验证。
5. 使用“获取事实 → 直接执行 → 聚焦验证 → 简洁交付”的单一路径；宿主按 description 直接选择领域 Skill。

## 硬边界摘要

- 只在授权范围内行动；红区、生产、权限、凭据、外部写入和不可逆操作先获人工确认。
- 不编造事实或证据；没有本轮有效验证时缩小完成主张。
- 任务记录是可选的人读文档，不触发测试、Review、子 Agent 或完成门禁。

## 默认验证命令

- Lint: pnpm lint
- Typecheck: 未配置
- Test: pnpm test:unit

`cognis validate --project` 只检查安装一致性；`cognis verify --project <path>` 执行项目已配置的验证命令。

## 已安装表面

- Skill 分类：下述八个领域 Skills 是 full profile 的八个原生领域 Skills；当前另安装 browser-verification integration Skill，它不计入该数量。

- 当前安装方式：完整能力安装（包含八个领域 Skills、可选 Eval 和 Codex 安全 Hook；memory 与外部工具仅通过 `--plugin` 显式启用）。

- 规则位于 `docs/rules/`。
- 工程专项规则位于 `docs/rules/`。
- 发布 / 设计 / 排障规则位于 `docs/rules/`。
- 模板位于 `docs/templates/`。
- Skills 位于 `.agents/skills/`。
- Codex hook 配置位于 `.codex/hooks.json`。

宿主按 Skill description 原生选择一个当前阶段所需能力；不使用 Router 或流程 Skill 链。

规则优先级：平台系统与用户本轮指令优先；目标项目明确的本地规则优先于 Cognis 默认规则；目录级规则只作用于其子树。同一层级冲突时停止并请求确认。
<!-- COGNIS:END -->
