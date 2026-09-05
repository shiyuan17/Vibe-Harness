# 评测驱动开发

Eval 用于 Agent 规则、Skill、模板、adapter 和 Hook 的非确定性行为。确定性代码继续使用普通产品测试。

Eval run schema v2 保留 offline 和 online 兼容接口，并区分 contract-replay、stub-behavioral、online-canary 三种 proof。第一种只证明 suite、fixture、oracle、scoring 与 reference 一致；第二种加载当前规则、Skill、Hook 和配置并执行变异检查；第三种才证明指定模型、宿主和版本的多轮行为。v1 资产继续可读，写入器只生成 v2。

## 合同

- suite：版本化场景、oracle、critical 断言和权重。
- run：一次 offline 或 online 执行的逐案例结果、分数和 fingerprint。
- reference：人工批准的比较基准，不包含对话、凭据或绝对路径。

core suite 覆盖安装、安全 Hook、浏览器和显式工具能力。

确定性 replay 只验证 suite、oracle、scoring、schema 和签入结果能够重复生成；它不执行当前 Agent 规则、Skill 或 Hook，不能单独作为在线行为修复证据。

## 生命周期

```bash
pnpm vibe-harness eval check --project ../some-project
pnpm vibe-harness eval run --project ../some-project --mode offline
pnpm vibe-harness eval run --project ../some-project --mode offline --write
pnpm vibe-harness eval reference --project ../some-project --from .vibe-harness/evals/runs/<run>.json --write --confirm-reference-update
```

offline 模式验证 suite、oracle、聚合和 reference 一致性。online runner 必须在一次性项目中执行，限制输出与超时，并保护全局配置。reference 更新始终显式执行，不能为让变更通过而自动提升。behavioral 命令同时变异规则、Skill、Hook 和配置，变异后必须失败。run fingerprint 分别记录 config、hooks、rules、skills 分类哈希与聚合哈希；资产漂移、缺 reference 或 degraded run 不计为通过。

`pnpm eval:check`、`pnpm eval:replay` 和在线 canary 都是显式命令，不属于 `pnpm check` 的默认快速路径。

## 多轮与 pass@k / pass^k 报告

online run 对每个 case 按 `repetitions`（1..3）独立运行多轮，每轮在独立的一次性工作区与隔离 `CODEX_HOME`/`HOME` 中执行，避免试验间状态泄漏。run 输出新增 `trialSummaries`：每个 case 给出 `passAt1`（首轮是否通过）、`passAtK`（≥1 轮通过）、`passCaretK`（k 轮全过）、`passedTrials`、`meanScore` 与逐轮明细。

逐轮明细可选记录 critical failure 数、失败断言类型、工具类型/状态、命令数量、错误分类和 Token 汇总。明细不保存原始 transcript、命令文本、命令输出或凭据；`pass^k` 波动只进入可靠性诊断，不新增隐式门禁。报告中的稳定通过率只统计 `repetitions > 1` 的 case，并同时显示其占全部 case 的稳定性覆盖率；单轮 Execution case 不再被解释为稳定样本。

- `pass@k` 衡量"至少一次成功"的能力上限，`pass^k` 衡量"多次全过"的可靠性，二者讲述不同故事。
- 当前 `trialSummaries` 仅作报告指标，不新增阈值门禁；现有 `criticalPassRate` 与 `overallScore` 阈值语义不变。
- offline 是确定性 replay（`repetitions` 退化为单次），不输出 `trialSummaries`，保持确定性可复现。

## Online runtime

### GitHub Actions third-party provider

The scheduled canary uses the env runtime source and an OpenAI-compatible third-party provider. Configure it in repository Settings > Secrets and variables > Actions. Variables must not contain credentials.

| Type | Name | Required | Description |
| --- | --- | --- | --- |
| Variable | CODEX_CLI_VERSION | Yes | Version of the Codex CLI package to install. |
| Variable | CODEX_MODEL | Yes | Public model or deployment identifier at the provider. |
| Variable | OPENAI_BASE_URL | Yes | HTTP or HTTPS root URL of the compatible API. |
| Secret | OPENAI_API_KEY | Yes | API key dedicated to evaluation use. |
| Variable | CODEX_REASONING_EFFORT | No | low, medium, high, or xhigh. Default: medium. |
| Variable | VIBE_HARNESS_EVAL_PROVIDER_NAME | No | Provider identifier using only letters, digits, hyphens, and underscores. Default: vibe-harness-env. |
| Variable | VIBE_HARNESS_EVAL_PROVIDER_WIRE_API | No | Codex wire API identifier using only letters, digits, hyphens, and underscores. Default: responses. |
| Variable | VIBE_HARNESS_EVAL_ENFORCE | No | Set to 1 to treat invalid evaluations as failures. Default: advisory. |

When OPENAI_BASE_URL is missing, the scheduled canary fails configuration validation instead of falling back to the official endpoint. The selected wire API must be compatible with both the provider and installed Codex CLI.

`VIBE_HARNESS_EVAL_RUNTIME_SOURCE=auto|codex|env` 选择 runtime 来源。`auto` 优先从本机 Codex `config.toml`/`auth.json` 原子读取 model、provider、base URL、wire API、reasoning、CLI 路径和对应 auth；只提取这些白名单字段，不继承 hooks、plugins、MCP、notify 或项目信任状态。显式 `CODEX_MODEL` 可覆盖配置中的 model，但仍复用同一 provider/auth；Codex 配置不存在时回退 `CODEX_MODEL`、`CODEX_REASONING_EFFORT`、`OPENAI_API_KEY` 与可选 `OPENAI_BASE_URL`。

`VIBE_HARNESS_EVAL_CODEX_BACKEND=auto|native|wsl` 选择执行后端。Windows `auto` 对声明写入的 execution suite 使用 WSL2，对只读 canary 使用 native；Linux/CI 使用 native。实际 provider/base URL/reasoning/backend/repetitions/CLI 版本进入 `configHash`，凭据不进入 fingerprint。WSL/Codex 不可用或 sandbox 拒绝写入时 run 为 degraded，不计为模型失败。

fixture 可声明 `allowedWritePaths`，其成员必须是 workspace 内的可移植相对路径，默认空数组。runner 比较执行前后快照；任何未声明的创建、修改或删除都会产生 `undeclared-workspace-write`，对已有 fixture 的修改同时保留 `existing-file-overwritten` 兼容事件。execution 的测试命令只由 harness 执行，不作为可见 fixture 暴露给模型。

EVAL-SPLIT 用例的 AGENTS.md fixture 文本是独立的英文评测契约，覆盖硬触发、任务拆分和授权边界；它不再要求与治理规则逐字同步，避免将评测文案变成运行时规则。

Online run 和 degraded artifact 使用脱敏 `campaignId` 关联同一评测活动。报告生成时可重复传入 `--execution-attempt` / `--canary-attempt` 汇总同 campaign 的 passed、failed 或 degraded 尝试；没有两套 suite 的 attempt 历史时，基础设施健康率和安全误拦截率必须标记为“部分覆盖”。工具指标只统计真实工具 item，通用 `error` item 不计为工具调用或错误分类；`success`、`expected-denial`、`recoverable-failure`、`fatal-failure` 和 `unknown` 分开呈现。安全探针只有在受保护目标未变化时，拒绝终态才算 `expected-denial`。

`pnpm eval:report` 生成自包含 HTML 决策报告。`--comparison-execution-run` / `--comparison-canary-run` 仅接受同 model、provider、reasoning、backend、CLI、repetitions 和 suite hash 的历史 run；普通历史 run 不等同于批准 reference，报告命令不会创建或更新 reference。

EVAL-SPLIT 同时断言完成的 Plan 输出人读 execution disposition，并声明该判定不授权 workspace 写入、提交、推送或外部副作用。EVAL-FACT-001..004 分别覆盖权威当前事实可直接行动、静态结论不能替代运行时证据、冲突来源必须解析，以及高风险证据不足时停止或标记未验证。

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

case 可声明 `flaky: true` 以保留抖动诊断信息，但它不改变通过门槛：critical 失败仍计入聚合指标，run `status` 仍必须由所有 case 的 `passed` 决定。重试或降级只能作为诊断证据，不能掩盖关键失败。

## case kind 分类

case 可声明 `kind` 元数据标签，枚举 `standard` / `variation` / `edge` / `adversarial`：

- `standard`：常规正向能力验证。
- `variation`：同一能力的输入变体。
- `edge`：边界、降级、回退场景。
- `adversarial`：对抗性场景（安全边界、禁止行为）。

kind 是可选字段，当前不加计数门禁，仅作案例治理标签，便于识别覆盖盲区。

## Harness Evals 统一入口

新体系位于 `harness-evals/`，架构契约见 [Harness Evals Framework](specs/harness-evals-framework.md)，场景规范见 [`harness-evals/docs/scenario-authoring.md`](../harness-evals/docs/scenario-authoring.md)。旧 `evals/` 继续作为兼容资产来源，不复制到新目录。

```bash
pnpm eval:harness check
pnpm eval:harness plan --tier fast
pnpm eval:harness plan --tier fast --changed docs/rules/test-rules.md
pnpm eval:harness run --tier fast --scenario H04 --attempts 1
pnpm eval:harness analyze --trace <bundle-dir> --result <results.json>
pnpm eval:harness baseline --input <results.json> --id <candidate-id> --output <baseline.json>
pnpm eval:harness compare --baseline <baseline.json> --current <results.json>
pnpm eval:harness report --input <results.json> --format html --output <report.html>
```

`check` 验证 20 个 Internal Scenario、Fixture、统一 Schema 与锁定的 External 样例清单。`plan` 根据后端真实能力和预算输出 ready、partial、not-scheduled、blocked；不支持的原生子 Agent、故障注入、compaction、恢复、Worktree 或合并能力不能用合成事件代替。未知变更影响回退完整核心集。

`run` 在隔离临时项目中投影当前 Harness，隐藏 oracle 与证据目录位于 Agent 写入范围之外。每次 attempt 使用独立 Fixture，结果保存为 Result v3，并生成 JSON、Markdown、HTML 与脱敏 ATIF。生成物默认位于 `harness-evals/reports/generated/` 和 `harness-evals/traces/runs/`，不提交；批准 reference 仍需独立显式流程。

External Adapter 只规划并归一化官方 SWE-bench、SWE-bench Live、Harbor/Terminal-Bench 与 CooperBench 命令。官方依赖留在 `harness-evals/external/` 的运行环境中；缺少官方 CLI、锁定数据集或 Docker 资源时结果为 blocked，不以样例 fixture 冒充真实基准运行。
