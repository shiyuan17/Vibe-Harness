# Skills 本地化与精简审计

本审计以 `manifests/skills.json` 为真值。运行 `pnpm skills:audit` 可实时生成逐 skill 的类型、行数、硬依赖、可选依赖和外部工具报告。

## 当前快照

- 总数：45。
- `native`：28；`integration`：11；`router`：4；`compatibility`：2。
- router/compatibility 入口最多 30 行，其他入口最多 80 行。
- 当前最长入口为 `api-and-interface-design`，低于 80 行。
- `minimal` 不安装 skill；core/full/internal 均通过 profile 依赖闭包校验。

## 收敛结果

| 能力簇 | 实现真值 | 保留入口 |
| --- | --- | --- |
| 调试 | `systematic-debugging` | `debugging-and-error-recovery` 为兼容路由 |
| 浏览器 | `browser-verification` | `browser-testing-with-devtools` 为兼容路由 |
| 设计 | `frontend-design` + 单层 reference | `taste-skill`、`impeccable` 按场景路由 |
| Review | `code-review-and-quality` | 请求、OCR、Packet、对抗审查各自只承担一个阶段 |
| Workflow | `governance-core` + `using-loopengine` | 五步内核常驻，handoff、release、Pencil、worktree 按触发加载 |
| Memory | agentmemory 外部适配 | 八个子入口因调用和破坏性不同继续独立 |

`writing-plans` 的 core 硬依赖已改为 `executing-plans`；full 的 `subagent-driven-development` 仅为 optional，不再产生 core 安装后无法执行的计划。

## 自动门禁

Pack validation 阻止以下问题：manifest/schema 不一致、source/metadata/install target 漂移、未知依赖、profile 硬依赖缺失、canonical 环、未登记跨 skill 引用、外部工具或 optional skill 无回退、嵌套 references 和入口超出行数预算。

第三方 CLI、MCP、凭据和服务不随 LoopEngine 捆绑。仓库只提供检测、调用、失败回退与验证协议，避免把“说明已安装”误当成“运行时可用”。
