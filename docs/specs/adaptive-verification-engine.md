# Adaptive Verification Engine

状态：Implemented

## 目标

引擎把规则、项目配置、影响分析、验证计划、受控执行器、receipt、Task/CI 工作流和完成门禁串成唯一证据链：

```text
规则 → Schema → Planner → Runner → Receipt → Task/CI → Completion Gate
```

CLI 与 runtime 必须消费同一计划字段；配置只能扩大内置风险范围，不能降低 red/high 最低验证层。

## L0-L6 验证阶梯

| 层级 | 内容 | 默认时机 | 完成主张 |
| --- | --- | --- | --- |
| L0 | lint、typecheck、changed compile | 每次修改 | 不能证明行为 |
| L1 | Micro、Probe、单函数 | 实现过程中 | 仅局部不变量 |
| L2 | affected unit/component | 小步骤完成 | 轻量局部行为 |
| L3 | module/slice/contract | 子任务完成 | 模块行为 |
| L4 | affected integration | 任务完成 | 集成边界 |
| L5 | critical E2E | PR/高风险任务 | 关键用户链路 |
| L6 | full regression/matrix/eval | nightly/release | 完整回归 |

默认采用最小充分层级。禁止用低层通过掩盖高层失败，也禁止因“更保险”默认运行 L6。

## 计划与收据

Planner 至少输出 `minimumTier`、`scope`、`scopeConfidence`、`selectedMicroChecks`、`selectedChecks`、`deferredChecks`、`nextTier`、`escalation` 和成本字段。影响映射为 `complete`、`lower-bound` 或 `unknown`；后两者必须扩大验证范围。

Receipt 必须绑定工作树、计划、命令集合和环境指纹。异步深度验证使用 `queued → running → passed|failed|blocked|stale`，queued/running 不构成通过。

## 环境与回滚

CI 默认 cold。warm provider 必须声明 start/health/stop/reuseKey/ttl，并按 worktree 隔离；失败按声明回退 cold 或 blocked。灰度期间保持旧 `layer` 默认语义，Micro、warm、async 和 affected 均显式 opt-in，可回滚但不得回滚安全边界、unknown 扩大和快照稳定性检查。
