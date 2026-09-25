# AGENTS.md - Vibe-Harness 贡献指南

Vibe-Harness 用来打包可复用的 AI coding 项目规则、领域 Skills、安全 Hook 和安装器。源项目只能作为只读输入；通用内容不得包含项目专有标识。

## 深入文档

- 贡献流程、变更影响矩阵、PR 与发布要求见 `CONTRIBUTING.md`。
- 当前架构、规格、参考审计与历史归档从 `docs/README.md` 进入。
- 执行内核与可选交付简表分别见 `docs/rules/governance-core.md` 和 `templates/delivery.md`。

## 命令与安全边界

- 所有项目命令使用 `--project <path>`；`--target` 只选择 adapter；真实写入统一用 `--write`，Codex `full` 写红区文件仍需 `--confirm-red-zone`。
- 安装器不得写入全局 Agent 配置；未使用 `--force` 时不得覆盖目标项目已有文件；未显式确认时不得写入红区文件。
- 项目专有示例不得进入 `rules`、`templates`、`skills/core`、`adapters`、`manifests`、`schemas` 等通用核心目录。
- 优先用 dry-run 和命令输出作为证据，不用猜测代替验证。
- 完整命令边界、`task-dag check` 派发前校验入口与已移除的旧参数见 `CONTRIBUTING.md`。

## 验证选择

验证命令与成本层的单一真值源是 `vibe-harness.config.json` 的 `validationCommands`；`pnpm verify:focused` 用同一分类器把变更路径映射为聚焦计划，`unknown` 一律回退 high。本节只保留默认门槛和计划外的治理性追加，不复制层命令清单与已由受管块描述的 `verify` 语义。

- 普通变更运行 `pnpm check:fast` 和 `git diff --check`（语法/资产扫描、typecheck、单元测试）；`pnpm check` 在其上追加 ESLint、结构校验、测试台账校验与组件测试，升级到阶段收尾、合并前或高风险边界运行。
- 按影响追加时优先用 `pnpm verify:focused --run`（或 `--tier quick|standard|deep`）让计划按变更路径自动选择；未选检查标记为 `not_selected`。计划覆盖不到的治理性追加：

| 变更 | 显式验证 |
| --- | --- |
| 文档、catalog、schema | `pnpm check` 已内含文档校验；仅未运行 check 时显式运行 `pnpm docs:audit` |
| Skill 或 Eval 资产 | `pnpm skills:audit`、`pnpm eval:check`、`pnpm test:component`（资产与契约用例）或对应 Eval 命令 |
| rules、runtime、docs/rules 内容 | `pnpm test:unit`、`pnpm test:component`、`pnpm eval:check`；eval reference 指纹漂移按 CONTRIBUTING 清单单独确认 |
| installer、profile、runtime、adapter、工具 | `pnpm test:integration`、`pnpm smoke:lifecycle` 或受影响的聚焦测试（scripts/runtime/adapters 路径已由计划自动选择） |
| CI workflow | `pnpm test:integration`（eval-ci 用例断言 workflow 内容） |
| 测试分层脚本或测试目录 | 受影响层：`pnpm test:unit\|component\|integration\|e2e\|matrix`；台账改动追加 `pnpm tests:catalog check` |
| runtime tool lockfile/provision | `pnpm runtime:audit` |
| 浏览器行为 | 真实浏览器关键路径 |

TypeScript 配置、类型声明、JSDoc 类型契约，或完成主张涉及类型安全的 JS/TS 改动，追加运行 `pnpm typecheck`（已并入 `pnpm check` 与项目 verify 默认命令）。

- 只运行与变更和完成主张匹配的聚焦检查；不要自动派发 Review/Test 角色。

## codebase-memory-mcp

若 `codebase-memory-mcp` 可用，理解或定位代码前先检查当前仓库索引状态（`node .agents/runtime/commands/run.mjs codebase-memory status --project . --json`），并按需使用结构查询；不可用时明确说明缺少该能力并退回 `rg` 和直接文件阅读。规则全文见 `docs/rules/codebase-memory-mcp.md`。

<!-- VIBE_HARNESS:START -->
# AGENTS.md

项目：Vibe-Harness

## 启动
1. 先读取 `docs/rules/governance-core.md` 顶部的 Fast Path 卡片；仅当任务超出快速档或命中升级触发时读取全文。只有出现 Skill 或专项领域信号时再读取 `docs/rules/agent-skill-routing.md` 和一个命中的专项规则。
2. 长任务（预计执行超过 60 分钟，或发生第一次上下文压缩）先用 `node .agents/runtime/commands/run.mjs task init --project <path> --write` 建立状态锚点（收据在 `.vibe-harness/tasks/`，复验用 `run.mjs verify --reuse`）；再次压缩前必须先更新锚点；命中 Skill 触发场景时先读该 Skill 的 `SKILL.md` 再行动。
3. 仅当需要恢复项目状态且已获授权时读 Memory body，从 `.agents/memory/CURRENT.md` 唯一入口恢复；治理真值按它引用的 `docs/memory/PROJECT_STATE.md` 读取，不复制其内容。 专项 Skill 限制 Memory 证据边界时，只确认路径存在与元数据，不读正文。
4. 编辑前运行 `git status --short`，保护用户未归属改动。
5. 先按问题类型选工具：单文件文本、配置和日志使用 rg 与直接文件阅读。 按 docs/rules/role-routing.md 先识别动作，再选一个能力匹配的角色并只读其角色文件；阶段变化重选。
6. 将任务归为快速、轻量或完整，并选择与主张匹配的验证。
7. 使用“获取可信事实 → 判定并执行 → 聚焦验证 → 简洁交付”的单一路径；宿主按 description 直接选择领域 Skill。
## 硬边界
- 授权范围内行动；红区、凭据、生产、外部写入与不可逆操作按 governance-core 的授权与批准规则执行，缺授权人工确认。
- 无本轮验证不声称完成；不编造证据。
- 任务记录不触发测试、Review、子 Agent 或门禁。

## 项目 verify 配置
- Lint: pnpm lint
- Typecheck: pnpm typecheck
- Test: pnpm test:unit
- Eval: pnpm eval:replay

`vibe-harness verify --project <path>` 默认只执行快速层（pnpm lint、pnpm typecheck、pnpm test:unit，失败阻塞当前实施单元）；中等层 `--tier standard`（pnpm test:component、pnpm test:integration）与深度层 `--tier deep`（pnpm eval:replay、pnpm test:e2e、pnpm test:matrix、pnpm smoke:lifecycle）须显式升级，`--full` 运行完整矩阵；未取得被延迟层证据前不得宣称集成、发布或整体完成。`vibe-harness validate --project` 只检查安装一致性；测试范围细则见 `docs/rules/test-rules.md`。

## 已安装表面

- 当前安装方式：自定义能力模块安装。 当前另安装 integration Skills：agentmemory；它们不计入 profile 的原生领域 Skill 数量。
- 需求澄清姿态：`balanced`（action-leaning 偏向采用最小可逆默认值直接推进；balanced 按规则判断；conservative 对尚未解决的高影响分歧更谨慎）。
- 表达模式位于 `docs/rules/response-modes.md`：按任务类型自动选择，或消息内显式 `/模式名` 并可组合；模式只控制思考深度、表达方式与输出粒度，不改变任务目标、验证范围或安全边界。
- 规则位于 `docs/rules/`。命中索引（⚡ 先读该规则顶部的 Fast Path 卡片）：治理 governance-core（Vibe-Harness 执行内核）⚡、agent-skill-routing（Skill 编写与路由规则）、eval-driven-development（评测驱动开发）、role-routing（多角色路由规则）、git-rules（Git 规则）⚡、test-rules（测试规则）⚡、ai-collab-rules（AI 协作规则）⚡、review-report（审查报告规则）、response-modes（表达模式规则）；工程 api-rules（API 规则）、coding-rules（编码规则）、frontend-rules（前端规则）、log-management（可观测性与日志管理规则）、project-directory（项目目录规则）、project-specific-rules（项目专属规则）、db-rules（DB 规则）；发布与排障 release-rules（发布规则）、troubleshooting（排障规则）。 多角色索引位于 .agents/roles/index.md。
- 模板位于 `docs/templates/`。
- Skills 位于 `.agents/skills/`。
- Codex hook 配置位于 `.codex/hooks.json`。
- 项目级确定性脚本：`node .agents/runtime/commands/run.mjs <env|context|changes|verify|worktree|slice|patch|task|codebase-memory> --project . --json`。
宿主按 Skill description 选择当前所需能力，按需补充互补 Skill；不使用 Router 或流程 Skill 链。

规则优先级：平台与用户本轮指令 > 项目本地规则 > Vibe-Harness 默认规则 > 任务记录、记忆与插件输出；低层只能收紧，不得让渡 governance-core 硬边界中的授权、红区与证据标准；目录级规则只作用于其子树。统一优先级矩阵见 `docs/rules/governance-core.md` 的硬边界节。Micro 验证专项规范位于 `docs/rules/micro-verification.md`，架构契约位于 `docs/specs/adaptive-verification-engine.md`；普通 REPL 仅用于探索，不得作为正式完成证据。统一 L0-L6 为 L0 static、L1 Micro、L2 affected unit/component、L3 slice/contract、L4 integration、L5 critical E2E、L6 full regression/matrix。unknown/lower-bound 必须扩大验证，queued/running/stale 不得判定为通过。
<!-- VIBE_HARNESS:END -->
