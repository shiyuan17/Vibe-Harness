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

## 断言类型

oracle 支持八类断言。前七类是确定性的，由 observation 直接判定：

1. `required-event` / `forbidden-event`：`observation.events` 是否包含。
2. `required-output-fragment` / `forbidden-output-fragment`：`observation.output` 是否包含。
3. `required-artifact` / `forbidden-artifact`：`observation.artifacts` 是否包含。
4. `exit-code`：`observation.exitCode` 严格相等。

第八类 `llm-rubric` 是语义断言，由 LLM-as-judge 评分：

- 仅 online：judge 调用是非确定性的，offline suite 禁止包含 `llmRubrics`（契约校验拦截）。
- 每项含 `rubric`（判定准则）、可选 `judgeModel`（默认复用配置）、可选 `threshold`（默认 0.8）。
- scoring 阶段构造 prompt（scenario + observation.output + rubric）调用 judge，返回 `score`（0..1）与 `rationale`，落盘前脱敏。
- judge 不可用（缺凭据、网络错误、响应不可解析）按 fail-closed 转 degraded，不静默通过。

## flaky 标记

case 可声明 `flaky: true`。flaky case 的 critical 失败记录但不阻断：

- `passed` 仍为 `false`，`flakyFailure` 标记为 `true`，`score` / `meanScore` 照常记录。
- `criticalPassRate` 计算时排除 flaky case 的 critical 断言与失败，flaky 失败不触发门禁。
- run `status` 判定忽略 flaky 失败（`passed || flakyFailure`）。

适用于阈值附近抖动的 case：记分不阻断，避免 CI 噪音（对齐 DeepEval flaky 语义）。

## case kind 分类

case 可声明 `kind` 元数据标签，枚举 `standard` / `variation` / `edge` / `adversarial`：

- `standard`：常规正向能力验证。
- `variation`：同一能力的输入变体。
- `edge`：边界、降级、回退场景。
- `adversarial`：对抗性场景（安全边界、禁止行为）。

kind 是可选字段，当前不加计数门禁，仅作案例治理标签，便于识别覆盖盲区。
