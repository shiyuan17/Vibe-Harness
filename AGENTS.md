# AGENTS.md - Cognis 贡献指南

Cognis 用来打包可复用的 AI coding governance 资产。源项目只能作为只读输入；通用核心内容不得包含项目专有标识；声称完成前必须验证安装器和校验器行为。

## 深入文档

- 贡献流程、变更影响矩阵、PR 与发布要求见 `CONTRIBUTING.md`。
- 当前架构、规格、参考审计与历史归档从 `docs/README.md` 进入。
- 通用治理内核与交付合同分别见 `rules/governance-core.md` 和 `templates/delivery.md`。

## 命令面边界

- 所有项目命令使用 `--project <temp-project>`；`--target codex|claude|gemini` 只选择 adapter。
- 真实写入统一使用 `--write`；`--apply`、`codex-internal` 和 `codex-minimal` 已移除。
- Codex `full` 写入红区文件时仍需 `--confirm-red-zone`。

## 必跑检查

- `pnpm check`
- 文档、catalog 或 schema 变更额外运行 `pnpm docs:audit`
- installer、profile、runtime 或工具变更额外运行 `pnpm test:integration` 和 `pnpm smoke:lifecycle`
- `pnpm cognis init --project <temp-project>`
- `pnpm cognis install --project <temp-project> --target codex --profile core --dry-run`
- `pnpm cognis install --project <temp-project> --target codex --profile core --write`
- `pnpm cognis validate --project <temp-project>`
- `pnpm cognis init --project <full-temp-project> --profile full`
- `pnpm cognis install --project <full-temp-project> --target codex --profile full --dry-run`
- `pnpm cognis install --project <full-temp-project> --target codex --profile full --write --confirm-red-zone`
- `pnpm cognis validate --project <full-temp-project>`
- `pnpm cognis doctor --project <full-temp-project>`

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
4. 将任务归为快速、轻量或完整，并确定验证方式。
5. 当前运行 Workflow 为 `adaptive`；adaptive 默认直接执行结果优先主循环，strict 保留完整生命周期。已安装 Skills 由宿主按 description 原生选择，不使用 Router 或流程 Skill 链。

## 硬边界摘要

- 只在授权范围内行动；红区、不可逆操作和范围扩大先获人工确认。
- 不编造事实或证据，没有本轮验证证据不声称完成；详细门禁以治理内核为唯一真值。
- adaptive 不要求通用任务确认或固定 11 字段交付；strict 的轻量反证及完整任务的任务确认、审查和交付字段以治理内核与模板为准。

## 默认验证命令

- Lint: pnpm lint
- Typecheck: 未配置
- Governance: node .agents/cognis/governance/validate.mjs。`cognis validate --project` 只检查安装一致性；执行项目命令使用 `cognis verify --project <path>`；manual 和测试范围细则见治理内核及 `docs/rules/test-rules.md`。

## 已安装表面

- 当前安装方式：完整治理安装（包含七个原生 Skills 和 Codex hooks；memory 与外部工具仅通过 `--plugin` 显式启用）。

- 规则位于 `docs/rules/`。
- 工程专项规则位于 `docs/rules/`。
- 发布 / 设计 / 排障规则位于 `docs/rules/`。
- 模板位于 `docs/templates/`。
- Skills 位于 `.agents/skills/`。
- Codex full 已安装 `cognis_tester` 与 `cognis_reviewer`。轻量行为改动在冻结变更集后派发 Tester；完整或高风险任务并行派发 Tester 与 Reviewer，等待两者回传并写入同一任务 Markdown 的 Handoff。核验期间主 Agent 不得修改变更集；任何后续 Git 可见实现改动都要求重新派发。父 Agent 必须检查实际 diff，并在 fan-in 后重跑集成验证。

- Codex hook 配置位于 `.codex/hooks.json`。

宿主按 Skill description 原生选择一个当前阶段所需能力；不使用 Router 或流程 Skill 链。

规则优先级：平台系统与用户本轮指令优先；目标项目明确的本地规则优先于 Cognis 默认规则；目录级规则只作用于其子树。同一层级冲突时停止并请求确认。
<!-- COGNIS:END -->
