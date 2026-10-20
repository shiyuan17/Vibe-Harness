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

行为修改同时说明用户可观察结果、保留行为和关键例子；复用已给出的要求，不重新确认。验收 ID 表示用户要求，不是检查 ID：一个检查可覆盖多个要求，必须说明对应关系。交付沿用本表 ID，关联实施单元与当前证据；不能只用“所有选中检查通过”替代原始需求完整性。

| 验收 ID | 判据 | 命令或操作 | 预期结果 | 证据 |
|---|---|---|---|---|
| A-001 |  |  |  |  |

## 实施单元

下面的机器可读执行块是交接与派发的契约：评审者、CI 与 `task plan-check` 只读这一段，就能判断“允许改什么、先做什么、每步由哪条验收兜底”。
`allowedScope` 是本次允许写入的边界，`protectedAssets` 是绝不允许写入的资产；`units[].files` 越界或命中受保护资产、`dependsOn` 指向不存在的单元或成环、`acceptance` 引用了验收表里没有的 ID，`plan-check` 都会拒绝，并按 `VIBE_HARNESS_PLAN_SCOPE_VIOLATION` / `VIBE_HARNESS_PLAN_DEPENDENCY_INVALID` / `VIBE_HARNESS_PLAN_ACCEPTANCE_UNBOUND` 报告原因。
旧计划可以暂时不含该执行块（只记为 `VIBE_HARNESS_PLAN_UNITS_MISSING` 警告），但新增计划必须填写。

`task plan-check` / `task check` 的 `acceptanceCoverage` 是告警型覆盖诊断，不新增门禁：规划阶段只检查声明映射，完成检查补充单元与证据缺口；`--unit` 只代表该单元范围。缺失旧执行块或仅有人工判据时明确无法机械核对，不能把映射完整解释为行为通过，也不自动迁移旧计划。

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

## 完整示例

下面是一份填好的例子，用来说明每个字段写到什么程度才算可交接。它是人读样例，不参与机器校验；机器契约仍是上方唯一的 `plan-units` 块，示例中的验收 ID 也刻意与上面的表格区分开。

**输入**：目标项目报「`normalize()` 对空数组返回 `undefined`，调用方随后抛 TypeError」，仓库里已有失败用例 `tests/unit/normalize.test.js`，`src/normalize.mjs` 是唯一实现点。

**输出**：`src/normalize.mjs` 对空数组返回 `[]`；回归用例固定在 `tests/unit/normalize.test.js`；计划文件补上基线与验证收据，改动的文件、理由和验证命令都在其中。

**接口**：`normalize(value: unknown): unknown[]` 的签名不变，但空数组输入与 `null` 输入的返回值从 `undefined` 变成 `[]`；这是可观察的行为变更，必须在「非目标」之外显式声明，并同步 `docs/api/normalize.md` 的示例。

**失败情况**：

- 修复后 `tests/unit/normalize.test.js` 仍失败：停止扩张改动，回到根因（例如调用方还有一条传入 `null` 的路径未覆盖），而不是继续改调用点。
- `tests/component/api-contract.test.js` 报空数组语义漂移：停止并把它升级为需要确认的行为变更，不静默更新契约快照。
- 验证命令超时，或验证期间工作树发生变化：收据记为未验证并重跑，不解释成通过。

**验证命令与预期结果**：

| 验收 ID | 命令 | 预期结果 |
|---|---|---|
| A-101 | `pnpm test:unit` | 退出码 0，新增的空数组与 `null` 回归用例通过 |
| A-102 | `pnpm test:component` | 退出码 0，契约用例无漂移 |

**停止条件**：A-101 与 A-102 都在最后一次改动之后通过即停止，不追加未被要求的重构；任一失败、任一必需证据缺失或出现需要授权的行为变更时，停止扩张并报告缺口与下一步。

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
