# Skills 本地化与精简审计

本审计以 `manifests/skills.json` 为真值。运行 `pnpm skills:audit` 会先校验 frontmatter、依赖与 profile 闭包、fallback、metadata 和安装映射，再生成逐 skill 的数量、类型、行数、硬依赖、可选依赖和外部工具报告；本文不保存会随 manifest 变化而过期的数量快照。

router/compatibility 入口最多 30 行，其他入口最多 160 行。`minimal` 不安装 skill；core/full/internal 均通过 profile 依赖闭包校验。

## 收敛结果

| 能力簇 | 实现真值 | 保留入口 |
| --- | --- | --- |
| 调试 | `systematic-debugging` | 删除 `debugging-and-error-recovery` 兼容入口 |
| 浏览器 | `browser-verification` + 项目内 Playwright CLI | `browser-testing-with-devtools` 已退役且不再作为 fallback，自动化不可用时输出人工验收矩阵 |
| 设计 | `frontend-design` + `references/design-modes.md` | 删除 `taste-skill`、`impeccable`，触发词并入 `frontend-design` |
| 澄清 | `brainstorming` | 删除 `grill-me`，结构化追问并入主入口；删除视觉伴侣和本地服务器资产 |
| 计划与拆解 | `writing-plans`、`executing-plans` | 删除 `task-decomposition`，父子任务约束并入计划和任务模板 |
| API | `api-and-interface-design` + `rules/api-rules.md` | 删除 `api-contract-check`，契约来源和 mapper 核对并入设计入口 |
| 前端 | `frontend-design` + `rules/frontend-rules.md` | 删除 `frontend-implementation-check`，实现状态和浏览器证据并入设计入口与规则 |
| Review | `code-review-and-quality`、`adversarial-review-packet` | 删除 `requesting-code-review` 与顶层 `open-code-review`；OCR 调用并入统一审查入口，工具 runtime 保留 |
| 交接 | task/delivery 模板、AI 协作规则、full 的 `agentmemory` | 删除 `workflow-handoff` 顶层入口 |
| Skill 贡献检查 | `CONTRIBUTING.md`、`pnpm skills:audit` | 删除下发到目标项目的 `skill-authoring-check` |
| Workflow / Git / Release / Pencil | `governance-core` 与专项 rules | 删除 `code-simplification`、`documentation-and-adrs`、`worktree-mergeback-check`、`git-delivery-batcher`、`release-checklist`、`pencil-design-check` |
| Memory | `agentmemory` 外部适配 | 提交查询与保存、检索、恢复、遗忘、汇总、历史流程统一由 `agentmemory` 路由到按需 references；危险删除仍要求精确候选和再次确认 |

`writing-plans` 的 core 硬依赖已改为 `executing-plans`；full 的 `subagent-driven-development` 仅为 optional，不再产生 core 安装后无法执行的计划。

当前 manifest 共 18 个 skill：core 安装 13 个，full 在其上增加 5 个独特能力；core/full 分别安装 26/39 个 skill 文件。删除项全部登记为 retired entries，升级只退休 install-state 跟踪且未被用户修改的文件。

## 自动门禁

Pack validation 阻止以下问题：manifest/schema 不一致、source/metadata/install target 漂移、未知依赖、profile 硬依赖缺失、canonical 环、未登记跨 skill 引用、外部工具或 optional skill 无回退、嵌套 references 和入口超出行数预算。

minimal/core 的第三方集成仍以检测和回退为主；full/internal 捆绑四个固定版本的项目内 runtime，并以 `doctor` 的真实状态区分 `ready`、`pending-config` 与 `degraded`。凭据不随 LoopEngine 捆绑或写盘。
