# 评测驱动开发

Eval 用于 Agent 规则、Skill、模板、adapter 和 Hook 的非确定性行为。确定性代码继续使用普通产品测试。

## 合同

- suite：版本化场景、oracle、critical 断言和权重。
- run：一次 offline 或 online 执行的逐案例结果、分数和 fingerprint。
- reference：人工批准的比较基准，不包含对话、凭据或绝对路径。

core suite 覆盖安装、安全 Hook、浏览器和显式工具能力。

## 生命周期

```bash
pnpm cognis eval check --project ../some-project
pnpm cognis eval run --project ../some-project --mode offline
pnpm cognis eval run --project ../some-project --mode offline --write
pnpm cognis eval reference --project ../some-project --from .cognis/evals/runs/<run>.json --write --confirm-reference-update
```

offline 模式验证 suite、oracle、聚合和 reference 一致性。online runner 必须在一次性项目中执行，限制输出与超时，并保护全局配置。reference 更新始终显式执行，不能为让变更通过而自动提升。

`pnpm eval:check`、`pnpm eval:offline` 和在线 canary 都是显式命令，不属于 `pnpm check` 的默认快速路径。

## 多轮与 pass@k / pass^k 报告

online run 对每个 case 按 `repetitions`（1..3）独立运行多轮，每轮在独立的一次性工作区与隔离 `CODEX_HOME`/`HOME` 中执行，避免试验间状态泄漏。run 输出新增 `trialSummaries`：每个 case 给出 `passAt1`（首轮是否通过）、`passAtK`（≥1 轮通过）、`passCaretK`（k 轮全过）、`passedTrials`、`meanScore` 与逐轮明细。

- `pass@k` 衡量"至少一次成功"的能力上限，`pass^k` 衡量"多次全过"的可靠性，二者讲述不同故事。
- 当前 `trialSummaries` 仅作报告指标，不新增阈值门禁；现有 `criticalPassRate` 与 `overallScore` 阈值语义不变。
- offline 是确定性 replay（`repetitions` 退化为单次），不输出 `trialSummaries`，保持确定性可复现。
