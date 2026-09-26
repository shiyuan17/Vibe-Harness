# Vibe-Harness 事实基线清单（2026-09-25，v2）

正式逐文件清单见同目录 `2026-09-25-file-inventory.md`：866 个实际文件；文件级状态为已实现 3、部分实现 6、仅规范定义 502、无法确认 355、缺失 0。**这些计数衡量取证覆盖，不是产品能力得分。** 本文件下面的能力面表格是导航，不替代逐文件状态；表中测试路径仅证明测试资产存在，不证明执行通过。未经源码确认的能力不得引用表格判为已实现。

另有 `2026-09-25-local-inventory.md` 逐项记录 1229 个本地/忽略文件（安装备份、索引、缓存、会话、日志与生成评测等）的路径和字节数，状态均为“无法确认”，不读取敏感正文、不作为当前行为证据。两表共 2095 个文件；不展开第三方依赖/Git 对象/符号链接目标。基线完整性检查对 866 个 Git 跟踪文件逐项核对，无磁盘缺失、无清单漏项。

## Phase 0 交付与审查所有权

- HEAD：`98a9d52585e8cfe4692e8f81810b075cd8643dc6`；起始 Git 工作区干净。仅新增本次审查文档，不修改被审产品。
- 不把历史报告、计划中的完成记录和既有 Eval 结果作为当前行为验证。Memory 仅记录元数据，不读取正文。
- 原始摘要早于逐文件清单；发现这一差距后暂停首轮，v2 完成后重新启动正式审查。三个子 Agent 并发槽位限制导致六个独立审查分两波，不伪称六路同时运行。
- 六方共用本基线，不阅读彼此输出。允许引用共同契约；**深读所有权按下表划分，跨域疑点只报边界线索，由对抗轮补查**。

| 审查域 | 独占深读/问题所有权 |
|---|---|
| 结构与规则 | roles/manifest/adapter 角色与规则投影、规则/技能路由、普通工程规则、catalog 与源/镜像组织；不审验证、调度、持久化实现 |
| 工作流 | governance-core/ai-collab/git/linear/response-modes 的任务流程；Task DAG；plan/task/workflow 模板；define-goal/task-decomposition；runtime 中 plan-check/task-check/dispatch 的调度语义，不审收据可信性或存储一致性 |
| 成本 | package/config 验证命令；validation-tiers/verification-plan/verify-focused 的选择与重复执行成本；CI 矩阵与 setup；不审通过判定与收据可信性 |
| 可靠性 | worktree/port/transaction/install-state、Hook/bootstrap/envelope 的失败/隔离/重试/宿主边界；不审 Anchor 的内容与恢复语义 |
| 验证 | test/micro/review 规则；收据/Review/merge gate/Eval/verifier/完成判定；CI 门禁条件，不审矩阵成本 |
| 上下文 | Memory/Session/Handoff、索引工具和渐进上下文；runtime Anchor init/update/status/reuse/plan 恢复关联；不审 worktree 事务与调度 ready 判定 |

每方 ≤10 条、必须有路径:行号及原文；建议控制在 3–5 条根因，优先删除/合并而非新增规则。每个关键机制用五问表；无法确认的能力不计正式问题。可执行代码的“已实现”只作源级结论；运行层完成必须有本轮命令结果。

## 口径

- 本清单只记录仓库中实际存在的文件、脚本、配置与测试；不把文件名或规范文字当作运行时能力。
- “已实现”仅用于已读源码能直接证明的具体机制，不是测试通过标签；“部分实现”表示仅确认部分链路或依赖外部宿主/工具；“仅规范定义”表示文档或声明本身不证明执行；“缺失”表示被引用对象经查不存在；“无法确认”包括尚未逐函数取证或无法核实的外部行为。
- `codebase-memory status` 本轮返回 `runtime-not-installed`；因此外部 MCP 是否可用不作为“已实现”结论。

## 资产枚举与实现状态

| 资产面 | 实际路径/数量 | 状态 | 文件证据 |
|---|---|---|---|
| 项目配置 | `vibe-harness.config.json` | 部分实现 | `vibe-harness.config.json:64`：`"onlineRunner": null`；`scripts/verify-focused.js:105`：`const config = await readProjectConfig(process.cwd());` |
| 规则 | `docs/rules/` 27 个 Markdown；`manifests/rules.json` 27 项 | 部分实现 | `manifests/rules.json:3-30` 只登记来源；执行内核另在 `scripts/`、`runtime/` |
| 核心规则 | `docs/rules/governance-core.md`、`test-rules.md`、`ai-collab-rules.md` 等 | 仅规范定义（除被脚本/Hooks映射的条款） | `docs/rules/governance-core.md:1-8` 将自身定义为合同，但需下方执行入口 |
| 技能源 | `skills/core/`、`skills/integrations/` 共 15 个技能、约 70 个文件 | 部分实现 | `manifests/skills.json:3-18` 登记技能及外部工具依赖 |
| 已安装技能投影 | `.agents/skills/` | 仅规范定义（技能正文）；生成链路待分域取证 | 目录中的真实路径逐项列入清单；`adapters/install-map.json` 的声明不能替代运行结果 |
| 角色源与提示词 | `roles/base.md`、`roles/prompts/` 7 个提示词 | 部分实现 | `manifests/roles.json:3-18` 声明路由与权限预设；`tests/integration/role-projection.test.js` 覆盖投影 |
| 角色宿主投影 | `.agents/roles/`、`.codex/agents/*.toml` | 部分实现 | `.codex/agents/` 存在宿主定义；宿主是否实际加载无法由仓库证明 |
| Hook 运行时 | `runtime/hooks/codex-hook.mjs`、`git-hook.mjs` 及 `runtime/hooks/lib/` 8 个模块 | 部分实现（具体只读快速路径已确认） | `runtime/hooks/codex-hook.mjs:126`：`if (isReadOnlyToolName(String(input.toolName ?? '')) && commandFrom(input) === '') {`；其他策略交可靠性域 |
| Hook 宿主配置 | `.codex/hooks.json`、各 `adapters/*/hooks.template.json` | 部分实现 | `.codex/hooks.json` 配置 `PermissionRequest`/`PreToolUse`；`scripts/lib/runtime-diagnostics.js:30-34` 明确仓库文件不能证明宿主已加载 |
| CLI 命令 | `scripts/vibe-harness.js` 及 scripts 树 132 文件 | 部分实现（入口绑定存在）；各子命令按逐项状态 | `package.json:43`：`"vibe-harness": "node ./scripts/vibe-harness.js"`；绑定不证明全部子命令正常 |
| 运行时命令 | `runtime/commands/run.mjs`；安装投影 `.agents/runtime/commands/run.mjs` | 部分实现 | `runtime/commands/run.mjs:3362`：`if (args.write) writeTaskAnchor(read.filePath, anchor);`；源/投影哈希一致不证明整个运行时正确 |
| 安装器/回滚/事务 | `scripts/lib/install-planner.js`、`install-state.js`、`file-transaction.js` 等 | 无法确认（Phase0 未逐函数取证） | 已枚举代码与测试资产；可靠性域对照真实分支再判定 |
| Task DAG / Worktree | `scripts/task-dag.js`、`scripts/worktree.js`、`scripts/lib/task-dag.js`、`runtime/lib/worktree-*` | 部分实现（DAG 校验已确认；其他待审） | `scripts/task-dag.js:84`：`const analysis = validateTaskDag(await readDag(options));`；不等于自动调度或隔离 |
| 验证与收据 | `scripts/verify-focused.js`、`verification-plan.js`、`verification-queue.js`、`receipt.js`、`schemas/*verification*` | 部分实现（变更收集已确认；证据链待审） | `scripts/verify-focused.js:97`：`const paths = await collectChangedPaths({ base });` |
| Eval | `evals/` 套件、reference、结果；`harness-evals/` 场景/runner/verifier | 无法确认完整性（资产存在；online 未配置） | `vibe-harness.config.json:64`：`"onlineRunner": null`；历史 reference/结果不算本轮验证 |
| Memory | `memory/` 文档、`.agents/memory/` 投影、`runtime/tools/codebase-memory-mcp/` 包装器 | 部分实现/外部依赖 | `vibe-harness.config.json:106-108`；`runtime/tools/codebase-memory-mcp/run.mjs:32-34` 依赖运行时安装包 |
| 适配器 | `adapters/` 21 个文件，`adapters/install-map.json` | 仅规范定义（模板与声明）；投影机制待审 | 清单逐项记录配置和模板正文；矩阵测试存在不证明宿主可用 |
| Manifest/Schema | `manifests/` 9 个 JSON；`schemas/` 29 个 JSON Schema | 仅规范定义（声明文件）；校验消费待审 | JSON 内容和路径已枚举，不能从 schema 存在推断每个入口强制校验 |
| 模板/文档 | `templates/` 19 个文件，`docs/` 目录及 catalog | 部分实现（生成/同步由脚本执行） | `scripts/docs-sync.js`、`scripts/docs-audit.js`；`tests/component/documentation.test.js` |
| Git/CI 工作流 | `.githooks/`、`.husky/`、`.github/workflows/` 3 个 workflow | 部分实现（CI 有条件门禁；宿主本地 Hook 依赖安装） | `.github/workflows/ci.yml:18-52` 先生成 change plan；`:97-148` 按输出选择检查 |
| 测试资产 | `tests/unit`、`component`、`integration`、`e2e`、`matrix` | 部分实现（入口已配置，行为覆盖待审） | `package.json:84`：`"check:fast": "node ./scripts/lint.js && pnpm typecheck && pnpm test:unit"` |

## 待核实线索（不是问题结论）

1. 规则是否存在无法执行的条款必须逐项对照消费者，不能凭文件数量推断。
2. Hook 代码能 fail-closed，但仓库明确承认不能证明宿主加载/信任；宿主侧安全效果只能标为“无法确认”。
3. Memory/MCP、Linear、浏览器等集成依赖外部工具；本仓库只能证明包装器、投影与降级路径。
4. `profile=full`、多层验证与多份投影的默认成本是否仍符合“最低必要成本”，需由成本/工作流审查量化。
5. 多 Agent 的 DAG、Worktree、handoff、resume 既有脚本与场景，但要验证失败隔离、幂等与长期连续性是否真正闭环。
