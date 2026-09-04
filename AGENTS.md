# AGENTS.md - Vibe-Harness 贡献指南

Vibe-Harness 用来打包可复用的 AI coding 项目规则、领域 Skills、安全 Hook 和安装器。源项目只能作为只读输入；通用内容不得包含项目专有标识。

## 深入文档

- 贡献流程、变更影响矩阵、PR 与发布要求见 `CONTRIBUTING.md`。
- 当前架构、规格、参考审计与历史归档从 `docs/README.md` 进入。
- 执行内核与可选交付简表分别见 `docs/rules/governance-core.md` 和 `templates/delivery.md`。

## 命令面边界

- 所有项目命令使用 `--project <temp-project>`；`--target codex|claude|gemini` 只选择 adapter。
- 真实写入统一使用 `--write`；`--apply`、`codex-internal` 和 `codex-minimal` 已移除。
- 项目生命周期使用 `--project <temp-project>`，预览使用 `--dry-run`，真实写入使用 `--write`。
- Codex `full` 写入红区文件时仍需 `--confirm-red-zone`。

## 验证选择

本节是验证矩阵的唯一规范来源；CONTRIBUTING.md 引用本节，不再重复维护表格。

- 普通变更运行 `pnpm check` 和 `git diff --check`；项目 `vibe-harness verify --project <path>` 默认按 `auto` 风险计划执行，`--plan` 只预览，`--full` 显式执行完整矩阵。
- 按影响追加：

| 变更 | 显式验证 |
| --- | --- |
| 文档、catalog、schema | `pnpm check` 已内含文档校验；仅未运行 check 时显式运行 `pnpm docs:audit` |
| Skill 或 Eval 资产 | `pnpm skills:audit`、`pnpm eval:check`、`pnpm test:eval` 或对应 Eval 命令 |
| installer、profile、runtime、adapter、工具 | `pnpm test:integration`、`pnpm smoke:lifecycle` 或受影响的聚焦测试 |
| rules、runtime、docs/rules 内容 | `pnpm test:unit`、`pnpm eval:check`；eval reference 指纹漂移按 CONTRIBUTING 清单单独确认 |
| CI workflow | `pnpm test:eval`（eval-ci 测试断言 workflow 内容） |
| runtime tool lockfile/provision | `pnpm runtime:audit` |
| 浏览器行为 | 真实浏览器关键路径 |

TypeScript 配置、类型声明、JSDoc 类型契约，或完成主张涉及类型安全的 JS/TS 改动，追加运行 pnpm typecheck；该仓库脚本已存在，但当前未接入项目 verify 默认命令。

- 可用 `pnpm verify:focused` 把本轮变更路径映射为同一风险计划（JSON 收据包含 `riskLevel`、`impactGroups`、`selectedChecks`、`skippedChecks` 和 `fallbackUsed`）；`--run` 依序执行。`unknown` 必须回退到 high，未选检查标记为 `not_selected`。
- 只运行与变更和完成主张匹配的聚焦检查；不要自动派发 Review/Test 角色。

## 安全规则

1. 安装器不得写入全局 Agent 配置。
2. 未使用 `--force` 时不得覆盖目标项目已有文件。
3. 安装、rollback 和卸载真实写入必须使用 `--write`，且未显式确认时不得写入红区文件。
4. 项目专有示例不得进入 `rules`、`templates`、`skills/core`、`adapters`、`manifests`、`schemas` 等通用核心目录。
5. 优先用 dry-run 和命令输出作为证据，不用猜测代替验证。

## codebase-memory-mcp

若 `codebase-memory-mcp` MCP 工具可用，理解或定位代码前先检查当前仓库索引状态，并按需使用结构查询。MCP 不可用时明确说明缺少该能力，退回 `rg` 和直接文件阅读；不要修改全局 Agent 或 MCP 配置。

<!-- VIBE_HARNESS:START -->
# AGENTS.md

项目：Vibe-Harness

## 启动
1. 先读取 `docs/rules/governance-core.md`；只有出现 Skill 或专项领域信号时再读取 `docs/rules/AGENT_SKILL_ROUTING.md` 和一个命中的专项规则。
2. 仅当任务需要恢复项目状态且当前授权允许读取 Memory body 时，读取 `docs/memory/` 的治理记忆（优先 `PROJECT_STATE.md`），按其与本地记忆库的优先级合并；本地记忆库恢复入口为 `.agents/memory/CURRENT.md`。 当专项 Skill 给出更窄证据边界时，仅检查相关路径是否存在及必要元数据，不读取正文。
3. 编辑前运行 `git status --short`，保护用户未归属改动。
4. 先按问题类型选工具：纯文本、配置和日志使用 rg 与直接文件阅读。
5. 将任务归为快速、轻量或完整，并选择与主张匹配的验证。
6. 使用“获取可信事实 → 判定并执行 → 聚焦验证 → 简洁交付”的单一路径；宿主按 description 直接选择领域 Skill。
## 硬边界

- 只检查相关路径是否存在及必要元数据，不读取正文。

- 只在授权范围内行动；红区、生产、权限、凭据、外部写入和不可逆操作先获人工确认。
- 不编造事实或证据；没有本轮有效验证不得声称完成。
- 任务记录是可选的人读文档，不触发测试、Review、子 Agent 或完成门禁。

## 项目 verify 配置

- Lint: pnpm lint
- Typecheck: pnpm typecheck
- Test: pnpm test:unit
- Eval: pnpm eval:replay

`vibe-harness validate --project` 只检查安装一致性；`vibe-harness verify --project <path>` 执行项目已配置的验证命令。测试范围细则见 `docs/rules/test-rules.md`。

## 已安装表面

- 当前安装方式：自定义能力模块安装。 当前另安装 integration Skills：agentmemory；它们不计入 profile 的原生领域 Skill 数量。
- 需求澄清姿态：`balanced`（action-leaning 偏向采用最小可逆默认值直接推进；balanced 按规则判断；conservative 对跨模块或公共契约改动也倾向先确认）。

- 规则位于 `docs/rules/`。
- 工程专项规则位于 `docs/rules/`。
- 发布 / 设计 / 排障规则位于 `docs/rules/`。
- 模板位于 `docs/templates/`。
- Skills 位于 `.agents/skills/`。
- agentmemory skills 位于 `.agents/skills/`，本地记忆库位于 `.agents/memory/`。
- Codex hook 配置位于 `.codex/hooks.json`。

宿主按 Skill description 原生选择一个当前阶段所需能力；不使用 Router 或流程 Skill 链。

规则优先级：平台系统与用户本轮指令优先；目标项目明确的本地规则优先于 Vibe-Harness 默认规则；目录级规则只作用于其子树。同一层级冲突时停止并请求确认。
<!-- VIBE_HARNESS:END -->
