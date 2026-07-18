# AGENTS.md - Cognis 贡献指南

Cognis 用来打包可复用的 AI coding governance 资产。源项目只能作为只读输入；通用核心内容不得包含项目专有标识；声称完成前必须验证安装器和校验器行为。

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
5. 已安装 Skills 时先使用 `using-cognis` 路由；Skills 未安装时按路由规则和治理内核 fallback 执行。

## 五条硬约束

1. 只在授权范围内行动，不覆盖无关改动。
2. 红区、不可逆操作和范围扩大必须先获得人工确认。
3. 不编造 API、字段、权限、数据、验证证据或发布结果。
4. 没有本轮新鲜证据，不声称完成、修复或通过。
5. 完整或高风险任务必须由独立核验者审查。

新任务或范围实质变化时，首次使用工具前按治理内核输出“任务确认”；普通追问不重复输出。轻量反证记录“主张 → 证据 → 反例 → 剩余风险”。红区确认和 `docs/templates/delivery.md` 会话交付字段不得省略；任务需要持久化时使用中文 `docs/templates/task.md`。

## 默认验证命令

- Lint: pnpm lint
- Typecheck: 未配置
- Governance: node .agents/cognis/governance/validate.mjs

`cognis validate --project` 只检查安装一致性；实际执行配置命令使用 `cognis verify --project <path>`。manual 命令只有检查内容后才使用 `--allow-manual`。

## 已安装表面

- 当前安装方式：自定义能力模块安装。








- Codex hook 配置位于 `.codex/hooks.json`。


当前 profile 未安装 Skills；仅按已安装规则和模板执行，不引用未安装的 skill。

规则优先级：平台系统与用户本轮指令优先；目标项目明确的本地规则优先于 Cognis 默认规则；目录级规则只作用于其子树。同一层级冲突时停止并请求确认。
<!-- COGNIS:END -->
