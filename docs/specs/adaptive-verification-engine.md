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

CI 与发布默认 cold，warm 必须由项目在 `verification.environment` 显式声明（mode、provider、start、health、stop、reuseKey、ttlMs、fallback），并按 worktree 隔离；失败按声明回退 cold 或 blocked。

本地任务与会话内默认复用已就绪的环境、服务进程、缓存、索引与容器，不重复冷启动。复用契约：隔离键由 worktree、配置与 fixture、reuseKey 组成，同一键只保留一个实例，并发写入者不共享实例；健康检查通过且未超过 TTL 才可复用，配置、依赖、fixture、镜像、工具链或工作树身份变化、健康检查失败或 TTL 到期即失效并按声明回退。容器按会话或任务级托管回收，用例级临时资源仍在用例结束时清理。

运行器当前只消费上述声明并记录 `environment` 状态，不代为执行 start/health/stop；生命周期执行由项目或宿主提供的 provider 承担，未接线时不得宣称运行器已具备自动起停。

灰度期间保持旧 `layer` 默认语义，Micro、warm、async 和 affected 均显式 opt-in，可回滚但不得回滚安全边界、unknown 扩大和快照稳定性检查。
