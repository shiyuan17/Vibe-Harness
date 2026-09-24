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
2. 长任务（预计执行超过 60 分钟，或发生第一次上下文压缩）先用 `node .agents/runtime/commands/run.mjs task init --project <path> --write` 建立状态锚点（锚点与收据位于 `.vibe-harness/tasks/`；阶段推进用 `task update`，重复验证用 `run.mjs verify --reuse`；已建锚点后再次压缩必须先更新锚点再继续写入）；命中 Skill 触发场景时先读该 Skill 的 `SKILL.md` 再行动。
3. 仅当任务需要恢复项目状态且当前授权允许读取 Memory body 时，从 `.agents/memory/CURRENT.md` 唯一入口恢复上下文：本地恢复线索以它为准，治理真值按它对 `docs/memory/PROJECT_STATE.md` 的引用读取，不复制其内容。 当专项 Skill 限制 Memory 证据边界时，仅检查相关 Memory 路径是否存在及必要元数据、不读取其正文；不限制任务相关源码阅读。
4. 编辑前运行 `git status --short`，保护用户未归属改动。
5. 先按问题类型选工具：单文件文本、配置和日志使用 rg 与直接文件阅读。 按 docs/rules/role-routing.md 先识别动作，再在有效且能力匹配的角色中选择一个角色，并只读取 .agents/roles/ 中对应角色文件；阶段变化时重新选择。
6. 将任务归为快速、轻量或完整，并选择与主张匹配的验证。
7. 使用“获取可信事实 → 判定并执行 → 聚焦验证 → 简洁交付”的单一路径；宿主按 description 直接选择领域 Skill。
## 硬边界

- 只在授权范围内行动；红区、生产、权限、凭据、外部写入和不可逆操作按 governance-core 的授权与批准规则执行；缺少覆盖授权时人工确认，已有覆盖授权不重复确认。
- 不编造事实或证据；没有本轮有效验证不得声称完成。
- 任务记录是可选的人读文档，不触发测试、Review、子 Agent 或完成门禁。

## 项目 verify 配置

- Lint: pnpm lint
- Typecheck: pnpm typecheck
- Test: pnpm test:unit
- Eval: pnpm eval:replay

`vibe-harness validate --project` 只检查安装一致性；`vibe-harness verify --project <path>` 默认只执行快速层（开发中同步，失败阻塞当前实施单元）pnpm lint、pnpm typecheck、pnpm test:unit；中等层（阶段或合并前，pnpm test:component、pnpm test:integration）与深度层（异步或发布边界，pnpm eval:replay、pnpm test:e2e、pnpm test:matrix、pnpm smoke:lifecycle）必须显式升级 `--tier standard|deep`，`--full` 运行完整矩阵。快速层通过时收据标注部分范围并给出下一层入口，未取得被延迟层的证据前不得宣称集成、发布或整体完成；深度层可由项目 CI 或独立 worktree 异步完成。测试范围细则见 `docs/rules/test-rules.md`。

## 已安装表面

- 当前安装方式：自定义能力模块安装。 当前另安装 integration Skills：agentmemory；它们不计入 profile 的原生领域 Skill 数量。
- 需求澄清姿态：`balanced`（action-leaning 偏向采用最小可逆默认值直接推进；balanced 按规则判断；conservative 对尚未解决的高影响分歧更谨慎）。
- 表达模式位于 `docs/rules/response-modes.md`：按任务类型自动选择，或消息内显式 `/模式名` 并可组合；模式只控制思考深度、表达方式与输出粒度，不改变任务目标、验证范围或安全边界。
- 规则位于 `docs/rules/`。命中索引：治理 governance-core（Vibe-Harness 执行内核）、agent-skill-routing（Skill 编写与路由规则）、eval-driven-development（评测驱动开发）、role-routing（多角色路由规则）、git-rules（Git 规则）、test-rules（测试规则）、ai-collab-rules（AI 协作规则）、review-report（审查报告规则）、response-modes（表达模式规则）；工程 api-rules（API 规则）、coding-rules（编码规则）、frontend-rules（前端规则）、log-management（可观测性与日志管理规则）、project-directory（项目目录规则）、project-specific-rules（项目专属规则）、db-rules（DB 规则）；发布与排障 release-rules（发布规则）、troubleshooting（排障规则）。 多角色索引位于 .agents/roles/index.md。
- 模板位于 `docs/templates/`。
- Skills 位于 `.agents/skills/`。
- agentmemory skills 位于 `.agents/skills/`，本地记忆库位于 `.agents/memory/`。
- Codex hook 配置位于 `.codex/hooks.json`。
- 项目级确定性脚本：`node .agents/runtime/commands/run.mjs <env|context|changes|verify|worktree|slice|patch|task|codebase-memory> --project . --json`。
宿主按 Skill description 选择当前所需能力，按需补充互补 Skill；不使用 Router 或流程 Skill 链。

规则优先级：平台系统与用户本轮指令优先；目标项目明确的本地规则优先于 Vibe-Harness 默认规则，但不得让渡 governance-core 硬边界中的授权规则、红区与证据标准（本地规则只能收紧，不能放宽或取代）；目录级规则只作用于其子树。先按优先级、适用范围和当前明确指令解析冲突；仅对仍影响结果且无法解决的实质冲突请求澄清。统一优先级矩阵见 `docs/rules/governance-core.md` 的硬边界节。
<!-- VIBE_HARNESS:END -->
