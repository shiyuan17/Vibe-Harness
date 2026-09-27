# <任务编号> <标题>

> 这是可交接的执行计划。读者只拥有当前仓库和本文件，不依赖原会话历史。
> 计划文件必须位于 `docs/plans/<task-id>.md`，并在实质偏离时先更新本文件再继续实施。

## 目标

说明用户可观察到的结果、为什么需要它，以及如何看到结果生效。

## 非目标

明确本次不改变的行为、接口、目录或发布边界。

## 当前事实与边界

- 相关入口、模块和配置：
- 允许修改范围：
- 受保护资产：
- 环境与授权前提：

## 已定方案

记录实现方式、兼容性、回滚方式和关键取舍。不得留下会改变实施顺序的未决选择。

## 实施顺序

按可独立验证的增量描述目标、修改位置、依赖和产物。每个增量必须在进入下一个依赖增量前完成验证。

## 墙钟与 Agent 编排

Parent 计划必须先估算单 Agent 与受限并行的墙钟时间，再决定执行模式。规划必须区分 active work、external wait/block、coordination/fan-in 和 verification；墙钟预算是规划证据，不是完成授权或时间承诺。

```linear-plan
{
  "schema": "vibe-harness.linear-plan/v1",
  "executionMode": "auto",
  "wallClock": {
    "budgetMinutes": 600,
    "sharedPreparationMinutes": 30,
    "externalWaitBlockMinutes": 15,
    "activeWorkMinutes": 390,
    "verificationMinutes": 90,
    "singleAgentMinutes": 585,
    "parallelAgentMinutes": 432,
    "coordinationMinutes": 30,
    "fanInMinutes": 45,
    "finalIntegrationMinutes": 60,
    "uncertaintyBufferRatio": 0.2,
    "units": [
      { "id": "U1", "activeMinutes": 120, "verificationMinutes": 30 },
      { "id": "U3", "activeMinutes": 150, "verificationMinutes": 30 },
      { "id": "U5", "activeMinutes": 120, "verificationMinutes": 30 }
    ],
    "criticalPath": ["U3"],
    "confidence": "medium"
  },
  "agentPlan": {
    "maxWriteAgents": 2,
    "maxReadAgents": 4,
    "fanInOwner": "parent-agent"
  }
}
```

`auto` 只有在至少两个 ready 单元、共享契约已有唯一 owner、writeScope 与 Resource Lock 完全隔离、真实 Agent/workspace 容量可用且预计净节省至少 45 分钟和 25% 时才选择 `parallel`，否则降级为 `single`。默认最多 2 个并行写 Agent、4 个只读 Agent；共享契约、数据库迁移、公共模板和最终集成只由一个 owner 写入。

### 早期探查（存在实质不确定性时选填）

- 待回答问题（入口、数据或环境）：
- 方法与预计分钟数（普通 REPL / 已声明的受管 Micro / 其他只读探查）：
- 退出条件与未解决时的风险：
- 后续正式检查：

探查只计入共享准备或单元 active work 一次，不抵扣 verification/fan-in；首轮规划默认限时 30 分钟，未解决时记录风险并重新估算。普通 REPL、临时脚本和人工观察不是完成收据；已声明的受管 Micro 仅提供 L1 局部证据，不能替代聚焦测试或最终集成。

## 验收方式

为每项验收提供唯一 ID、实际命令或人工判据、预期结果和所需证据。

| 验收 ID | 判据 | 命令或操作 | 预期结果 | 证据 |
|---|---|---|---|---|
| A-001 |  |  |  |  |

## 实施单元

下面的机器可读执行块是交接与派发的契约：评审者、CI 与 `task plan-check` 只读这一段，就能判断“允许改什么、先做什么、每步由哪条验收兜底”。
`allowedScope` 是本次允许写入的边界，`protectedAssets` 是绝不允许写入的资产；`units[].files` 越界或命中受保护资产、`dependsOn` 指向不存在的单元或成环、`acceptance` 引用了验收表里没有的 ID，`plan-check` 都会拒绝，并按 `VIBE_HARNESS_PLAN_SCOPE_VIOLATION` / `VIBE_HARNESS_PLAN_DEPENDENCY_INVALID` / `VIBE_HARNESS_PLAN_ACCEPTANCE_UNBOUND` 报告原因。
旧计划可以暂时不含该执行块（只记为 `VIBE_HARNESS_PLAN_UNITS_MISSING` 警告），但新增计划必须填写。

```plan-units
{
  "allowedScope": ["docs/**", "runtime/**"],
  "protectedAssets": ["evals/**"],
  "units": [
    {
      "id": "U1",
      "title": "可独立验证的增量",
      "files": ["runtime/commands/run.mjs"],
      "dependsOn": [],
      "acceptance": ["A-001"]
    }
  ]
}
```

## 计划漂移记录

发生目标、范围、接口、依赖、验收或回滚方案变化时，先暂停受影响实施，记录原因与影响，更新本计划，再继续。

| 修订 | 时间 | 偏离与原因 | 影响 | 采取的行动 |
|---|---|---|---|---|
| 1 |  | 初始计划 |  |  |

## 进度与恢复

- 当前阶段：plan / implement / verify
- 已完成增量：
- 当前增量：
- 阻塞项：
- 下一步动作：

## 决策记录

| 决策 | 原因 | 时间 |
|---|---|---|
|  |  |  |

## 证据与回滚

记录实际验证命令、退出码、摘要、代码基线/计划摘要，以及必要的截图、HTTP 响应、构建输出或 Diff 引用。说明如何安全回滚或重试。

## 计划修订说明

每次修改计划时，在此追加“改了什么、为什么改、哪些验收或实施单元受到影响”。
