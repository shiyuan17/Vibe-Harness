# AI 专属 Eval 体系调查报告

> 状态:调查报告(非门禁文档)
> 日期:2026-07-30
> 范围:审视 Vibe-Harness 当前 AI 专属 Eval 体系,对照 2024–2026 业界最佳实践,给出是否需要调整的结论与建议。
> 方法:全仓库勘察(规则/脚本/suite/CI/产物)+ 网络权威来源调研(框架官方文档与论文)。所有项目侧关键事实已用命令亲自核实,标注于 §3。

---

## 1. 结论先行(TL;DR)

> **2026-07-30 更新**:P1a(LLM-as-judge)、P1b(flaky 标记)、P2(golden kind 分类)已实施完成。P0(让 online eval 真正跑起来)与 P2 的 cost/trace 闭环仍待后续。实施细节见 §6 各项的"实施状态"标注。

Vibe-Harness 的 AI 专属 Eval 体系在**架构与契约层面已处于业界前列**——它独立实现了业界主流框架(Inspect AI / Promptfoo / DeepEval / LangSmith / Braintrust)的核心概念,且在几个点上做得更严格。无需推倒重来。但存在三类需要调整的问题:

1. **"能力已建好但从未真正跑起来"**:online eval(多轮、trialSummaries、pass@k/pass^k)的代码、schema、CI 全部就绪,但两个 online reference 文件缺失,历史 canary run 全部因缺 `CODEX_MODEL` 退化为 degraded,导致 trialSummaries **从未产出过任何实际样本**。可靠性报告机制是"纸上能力"。
2. **指标体系偏单薄,且缺少 LLM-as-judge**:当前 oracle 全部是确定性断言(7 类:required/forbidden events、output fragments、artifacts、exitCode),没有语义/主观质量评判能力。业界共识是 hybrid(deterministic + llm-rubric)。
3. **golden 维护机制薄弱**:无案例分类分级标准(standard/edge/adversarial)、无防过拟合的对抗输入再生、无 flaky 标记(阈值附近抖动 case 会污染 CI)。

**建议优先级**:先让 online eval 真正跑起来并冻结 reference(P0)→ 补充 LLM-as-judge 与 flaky 标记(P1)→ 完善案例集治理与 trace 闭环(P2)。详见 §6。

---

## 2. 调查背景与目标

用户需求:建立维护一套或多套固定案例,每次模型/提示词/Hook/Skill/工作流变化时跑一次回归评测,给出评测指标;结合项目现状与网络最佳实践,判断是否需要调整,产出调查报告。

本报告回答三个问题:
- Vibe-Harness 现在的 Eval 体系是什么样?(§3)
- 与业界最佳实践相比,差距和优势在哪?(§4)
- 是否需要调整?如何调整?(§5–§6)

---

## 3. 现状清单(已核实)

### 3.1 契约与规则

| 文件 | 作用 |
|---|---|
| docs/rules/eval-driven-development.md | 唯一常驻契约。8 条核心条款:修改非确定性 Agent 行为前须定义可观察失败场景;改前冻结同模型/runner/预算/指纹的参考结果;改后同条件重跑对比;critical 必须全过;reference 更新须单独审查;真实评测只在一次性项目跑;baseline ≠ evaluation reference;online 按 repetitions 多轮产出 trialSummaries(仅报告,不加阈值门禁) |
| `.agents/skills/eval-driven-development/SKILL.md` | 按需展开的 5 步执行流程,描述同一门禁。含 degraded 上报规则、禁自动更新 reference |
| `docs/evals.md` | 评测总览:suite/run/reference 三合同、生命周期命令、pass@k(至少一次成功,能力上限)vs pass^k(多次全过,可靠性)定义 |

> 契约本身设计严谨,明确区分了"能力上限"(pass@k)与"可靠性下限"(pass^k),这与业界三件套(pass@1 典型 / pass@k 上限 / pass_k 下限)完全对齐。

### 3.2 运行器与脚本(全链路已实现)

**CLI 命令**(`package.json`):
```
eval:check         契约+schema+observer 覆盖校验
eval:replay       确定性 replay,与 checked-in reference 深度相等
eval:online        online 多轮运行(thresholds + repetitions:3)
eval:health        健康状态机(连续 degraded≥3 失败)
eval:clarification / eval:goal   专项 catalog 校验
smoke:lifecycle    含"安装后离线 eval 自检"步骤
test:eval          8 个 eval 专项单测
```

**核心 lib 模块**(`scripts/lib/`):
- `eval-runner.js` — online case 执行器:临时 workspace、fixture 写入、spawn runner 子进程、observation 校验、10min 超时、1MiB 输出上限、凭据检测、环境变量白名单、degraded 上报
- `eval-scoring.js` — scorer:7 类断言评估 + capability 加权聚合 + 5 字段指纹比对 + 脱敏(secret 正则、绝对路径替换 `<path>`、4096 截断)
- `eval-trials.js` — 多轮聚合:`summarizeTrials` 产出 passAt1/passAtK/passCaretK/passedTrials/meanScore/perTrial
- `eval-contract.js` — 契约校验:repetitions 1..3、权重 0..10、observer 覆盖、三件套交叉校验
- `eval-replay.js` — offline 确定性 replay(固定指纹 `offline-replay@1`)
- `project-evaluation.js` — 项目级编排:configHash(19 个配置路径递归哈希)、阈值门禁、reference 冻结(须 `--force`+`--confirm-reference-update`)、防 symlink/路径逃逸

**运行时 runner**(`runtime/evals/`):
- `codex-runner.mjs`(268 行) — Codex CLI 适配:隔离 CODEX_HOME/HOME、provisionAuthentication、受保护配置快照、`codex exec --sandbox workspace-write --ephemeral`、transcript 解析(events/commands/errorCategories/hookReasonCodes/toolCalls/totalTokens)、fixture 完整性检测、hidden tests 执行、受保护配置变更检测
- `run.mjs`(119 行) — 独立离线 runtime,供安装后自检
- `lib/hidden-tests.mjs` — FAIL_TO_PASS 隐藏测试执行器(全过→`hidden-tests-passed`,失败/超时→`hidden-tests-failed`,fail-closed)
- `lib/protected-config.mjs` — 7 类全局配置文件变更检测

### 3.3 现有固定案例集(已核实数量)

| suite 文件 | 版本 | case 数 | repetitions | 覆盖 |
|---|---|---|---|---|
| `evals/suites/vibe-harness-core.json` | v2.0.0 | **18**(已核实:install-lifecycle 6 / skill-routing 7 / safety-isolation 5) | 1(offline) | 安装生命周期、Skill 路由(RTK/ast-grep/browser)、安全隔离(hook/受保护配置) |
| `evals/suites/vibe-harness-online-canary.json` | v2.0.0 | 6(全部 critical) | 3 | 真实 fixture(AGENTS.md/protected.txt/.env/SKILL.md),在线行为 |
| `evals/suites/vibe-harness-online-execution.json` | v1.0.0 | 5 | 1 | FAIL_TO_PASS 执行类(含 fixture.files + fixture.tests 隐藏测试) |
| `evals/clarification-cases.json` | schema v2 | 24 | 3 | 5 类:independent(8)/dependent(4)/mixed(4)/discovery(4)/near-miss(4) |
| `evals/goal-definition-cases.json` + `trials.json` | schema v1 | 12 | 3 | 4 类:execution(4)/exploration(3)/activation(3)/near-miss(2) |

> 注:调研中 subagent 曾报告 core suite 为 17 个 case 且与测试断言不一致,经亲自核实为**误报**——实际 18 个 case,分布 6/7/5,与 `tests/eval-contract.test.js:29` 断言完全一致。

### 3.4 Reference 与产物(已核实缺失项)

| 资产 | 状态 |
|---|---|
| `evals/references/vibe-harness-core.offline.json` | ✅ 存在(approvedAt 2026-07-28,overallScore 1.0,criticalPassRate 1.0) |
| `evals/references/vibe-harness-online-canary.json` | ❌ **缺失**(被 `eval-online.js:18` 引用) |
| `evals/references/vibe-harness-online-execution.json` | ❌ **缺失**(被 `eval-online.js:19` 引用) |
| `.vibe-harness/evals/runs/` 历史产物 | 12 个 offline run + 2 个 degraded run;**0 个 online run** |
| 含 `trialSummaries` 的产物 | ❌ **不存在**(online 多轮机制从未产出实际样本) |
| degraded 诊断(已核实) | `EVAL-ONLINE-007: Codex evaluation runner unavailable: CODEX_MODEL is required` |
| `.vibe-harness/evals/history/` | ❌ 不存在(eval-health 读取它做连续 degraded 计数) |

### 3.5 门禁与 CI

**CI 硬门禁**(`.github/workflows/ci.yml`,PR/push 到 main):
```
pnpm check → eval:check → eval:replay → test:eval → test:integration → runtime:audit → smoke:lifecycle → git diff --check
```
offline eval 是硬门禁(阻断)。

**Online canary CI**(`.github/workflows/evals.yml`):
- 触发:**仅 schedule(每天 02:17 UTC)+ workflow_dispatch**,不在 PR/push 触发(有测试断言)
- preflight 检查 `CODEX_CLI_VERSION`/`CODEX_MODEL`/`OPENAI_API_KEY` → 缺失则写 degraded.json 并 ready=false
- `VIBE_HARNESS_EVAL_ENFORCE` 控制 invalid 是否真正非零退出(advisory vs enforce)

**Git hooks**:`pre-commit`/`pre-push` 调用 `git-hook.mjs`,只做 diff/secret/red-zone/test-marker 拦截,**不触发 eval**。eval 门禁完全由 CI 承担。

**Codex hooks**(`.codex/hooks.json`):注册 PermissionRequest/PreToolUse,是安全策略 hook,**非 eval 触发**。

### 3.6 配置

`vibe-harness.config.json`:
```json
"evaluations": {
  "enabled": true,
  "suites": ["evals/suites/vibe-harness-core.json"],   // 仅 core
  "reference": "evals/references/vibe-harness-core.offline.json",
  "thresholds": { "criticalPassRate": 1, "overallScore": 0.9, "maxCapabilityRegression": 0.05 },
  "onlineRunner": null,                          // 项目配置未启用 online runner
  "repetitions": 3
}
```

### 3.7 schema 与脱敏

- `schemas/eval-suite.schema.json`(draft 2020-12):defaultRepetitions 1..3、7 类断言(dimension∈4 类 + critical)、weights 4 维 0..10、fixture.tests 可选
- `schemas/eval-run.schema.json`:status(passed/failed/degraded)、fingerprint 5 字段、trialSummaries、caseRepetitions、capabilities
- `schemas/eval-reference.schema.json`:精简聚合(无 cases/assertions/对话/凭据)
- 脱敏:`eval-scoring.js` 的 `sanitizeEvalValue` 在所有 observation/diagnostics 写入前脱敏,符合"不保存凭据/绝对路径"契约

---

## 4. 业界最佳实践对照

### 4.1 框架能力对照表

| 能力维度 | 业界代表 | Vibe-Harness 现状 | 评价 |
|---|---|---|---|
| 框架形态 | Inspect AI(Task=Dataset+Solver+Scorer)、Promptfoo(YAML 声明式)、DeepEval(pytest-native) | 自研 JS runner + JSON suite + schema | ✅ 等价,且与项目语言一致 |
| pass@k / pass^k | Inspect AI `pass_at_{k}`/`pass_k_{k}`(arXiv:2107.03374, arXiv:2406.12045) | passAt1/passAtK/passCaretK(`eval-trials.js`) | ✅ 概念对齐;但 **passCaretK 命名非业界标准**,疑似内部命名(公开检索无此术语,可能对应 Inspect 的 pass_k_{k}) |
| LLM-as-judge | Promptfoo `llm-rubric`/`select-best`、OpenAI `score_model`、DeepEval G-Eval/DAG/QAG | ❌ 无,7 类断言全确定性 | ⚠️ **缺口** |
| 混合断言(hybrid) | OpenAI Agent Improvement Loop:deterministic + llm-rubric | ❌ 无 hybrid 模式 | ⚠️ 缺口 |
| 轨迹(trajectory)评测 | LangSmith Agent Trajectory evaluator、Promptfoo `trajectory-goal-success`、Inspect `react()`+AgentState | 部分:transcript 解析产出 toolCalls/events,但断言仍是事件级而非"路径正确性" | 🟡 有数据无轨迹级断言 |
| FAIL_TO_PASS | SWE-bench(arXiv:2310.06770)、SWE-agent(arXiv:2405.15793) | ✅ `hidden-tests.mjs` 完整实现 | ✅ 业界黄金标准,已落地 |
| 沙箱隔离 | Inspect Docker/K8s、Codex `--sandbox workspace-write` | ✅ 临时 workspace + `--ephemeral` + CODEX_HOME 隔离 + 受保护配置快照 | ✅ 做得更严(含全局配置变更检测) |
| reference 冻结 | LangSmith dataset tag+版本只读、DeepEval `--official`、Braintrust experiment 不可变 | ✅ `writeProjectEvaluationReference` + `--force` + `--confirm-reference-update` + 三方 hash 一致 | ✅ 等价 |
| 分层门禁 | LangSmith(离线阻断/在线报告)、Promptfoo `--fail-on-error`、Braintrust PR smoke→全量 | ✅ CI offline 阻断 + canary 仅 schedule 报告 | ✅ 对齐业界共识 |
| flaky 标记 | DeepEval `flaky=True`(记分不阻断) | ❌ 无 | ⚠️ 缺口 |
| 预算护栏 | Inspect cost_limit、LangSmith spend limit、Promptfoo maxEvalTimeMs | 部分:case 级 10min 超时、1MiB 输出上限;**无 cost_limit / token 预算** | 🟡 有超时无成本预算 |
| 缓存 | Promptfoo(14 天 TTL, success-only)、Langsmith pytest cache | ❌ 无 | 🟡 缺口(但 offline 是 replay 不需要) |
| 防过拟合 | DeepEval 四类 golden(standard/variation/edge/adversarial)、Promptfoo 定期重生成红队 | ❌ 无分类标准、无对抗输入再生 | ⚠️ 缺口 |
| trace 闭环 | OpenAI Agent Improvement Loop(trace→反馈→eval→CI→golden)、Macro Evals | ❌ 无 trace 回流机制 | 🟡 缺口(但有 transcript 数据基础) |

### 4.2 Vibe-Harness 相对业界的优势

1. **安全边界更严**:受保护配置快照 + fixture 完整性检测 + 全局配置变更检测 + 脱敏,比多数框架的纯沙箱更贴近"红区保护"场景。
2. **契约即代码**:规则文档 + Skill + schema + 契约校验脚本四重一致,且有 `eval:check` 强制校验,避免文档与实现漂移。
3. **FAIL_TO_PASS 已落地**:SWE-bench 黄金标准已在 `online-execution` suite 实现。
4. **reference 冻结有显式确认**:需 `--confirm-reference-update` + `--force`,防止误覆盖。

### 4.3 Vibe-Harness 相对业界的缺口

见 §4.1 标 ⚠️/🟡 的行,归纳为:
- **A. LLM-as-judge / hybrid 断言缺失**(Promptfoo/OpenAI/DeepEval 共识项)
- **B. flaky 标记缺失**(DeepEval 关键实践)
- **C. 预算护栏不全**(无 cost_limit,Inspect/LangSmith 共识项)
- **D. golden 治理薄弱**(无分类、无对抗再生,DeepEval/Promptfoo 共识项)
- **E. trace 闭环缺失**(OpenAI 飞轮)
- **F. passCaretK 命名非标准**(可能引起外部沟通歧义)
- **G. online eval 从未实际运行**(见 §3.4,这是最紧急的)

---

## 5. 是否需要调整:逐项裁决

| # | 问题 | 严重度 | 裁决 | 理由 |
|---|---|---|---|---|
| G | online eval 从未产出真实样本,trialSummaries 是纸上能力 | **P0** | **必须调整** | 整套 online 机制(多轮、pass@k、可靠性报告)是为"模型/提示变化回归"而建,但 reference 缺失+canary 恒 degraded 导致它从未跑起来。用户的核心诉求(变化时跑回归)在 online 维度落空 |
| A | 无 LLM-as-judge | **P1** | 建议调整 | 当前只能判"硬约束是否满足",无法判"输出质量/语义意图"。Skill 路由、clarification 这类语义行为靠纯确定性断言覆盖率有天花板 |
| B | 无 flaky 标记 | **P1** | 建议调整 | online 引入后,阈值附近抖动 case 会反复红绿,污染 CI 信号。DeepEval 的 flaky 是业界标配解法 |
| D | golden 治理薄弱 | **P2** | 建议调整 | 案例集会随时间过拟合;无对抗输入无法发现新失败模式 |
| C | 无 cost 预算 | **P2** | 可选调整 | online 引入后 agent 失控烧钱风险存在;但当前 case 量小、有超时,短期可忍 |
| E | 无 trace 闭环 | **P2** | 可选调整 | 有 transcript 数据基础,可后续做;非阻断 |
| F | passCaretK 命名 | **P3** | 可选调整 | 内部命名,不影响功能;若要对外沟通可对齐为 pass_k_{k} |

---

## 6. 调整建议(按优先级)

### P0:让 online eval 真正跑起来并冻结 reference

这是用户诉求落地的关键。当前"每次变化跑一次回归"在 online 维度是空转的。

1. **补齐 online reference 文件**(或显式声明为"待首次批准"):
   - 当前 `eval-online.js` 引用的两个 reference 缺失,运行时判 `missing`→degraded。
   - 方案:在能提供 `CODEX_MODEL`/`OPENAI_API_KEY` 的环境跑一次 `pnpm eval:online --suite vibe-harness-online-canary`,产出 run 后用 `vibe-harness eval reference --from <run> --write --confirm-reference-update` 冻结。
   - 若暂时无法跑,应在契约中显式记录"online reference 处于 pending 状态",而非静默 degraded。

2. **修复 canary CI 的凭据供给**:
   - 历史 degraded 诊断均为 `CODEX_MODEL is required`。需在 `evals.yml` 的 schedule 作业配置所需 secret(`CODEX_MODEL`/`OPENAI_API_KEY`/`CODEX_CLI_VERSION`)。
   - 决定 `VIBE_HARNESS_EVAL_ENFORCE` 策略:建议 canary 初期保持 advisory(enforce=0),连续 3 次 degraded 后再升级——这与 `eval-health` 的"连续≥3"逻辑天然契合。

3. **补建 `.vibe-harness/evals/history/`**:eval-health 依赖它做连续 degraded 计数,当前目录不存在会导致健康判断失真。

4. **验证 trialSummaries 端到端产出**:跑通后确认 run 产物含 `trialSummaries`(passAt1/passAtK/passCaretK/perTrial),这是"给出评测指标"诉求的直接交付物。

### P1a:引入 LLM-as-judge(hybrid 断言)

> **实施状态:已实施(2026-07-30)**。schema 新增 `oracle.llmRubrics` 数组;`scripts/lib/eval-judge.js` 提供 OpenAI 兼容 judge 客户端(fail-closed);`eval-scoring.js` 的 `evaluateOracle`/`scoreCase` 改为 async 并增加第 8 断言分支;offline 路径由 `eval-contract.js` 拦截含 `llmRubrics` 的 suite,保留 offline 确定性 replay 契约。

在现有 7 类确定性断言之外,新增第 8 类 `llm-rubric` 断言:

- schema(`eval-suite.schema.json`)增加 assertion type `llm-rubric`,字段:`rubric`(判定准则文本)、`judgeModel`(可选,默认复用被测模型或指定独立 judge)、`threshold`(0..1)。
- scoring(`eval-scoring.js`)增加 judge 调用路径:构造 prompt(含 scenario + observation + rubric)→ 调用 judge 模型 → 解析分数与理由 → 脱敏后写入 assertion result。
- 适用场景:Skill 路由是否选对(clarification 类)、输出是否达成语义意图、错误处理是否合理。
- 借鉴:OpenAI Agent Improvement Loop 的 hybrid 模式(deterministic 校验硬约束 + llm-rubric 校验意图),Promptfoo `llm-rubric` 的 `rubricPrompt` 可定制。
- 注意 LLM-as-judge 三类偏差(Zheng et al., NeurIPS 2023, arXiv:2306.05685):position bias / verbosity bias / self-enhancement bias——judge prompt 需做顺序打乱或 pairwise 双向校验。

### P1b:引入 flaky 标记

> **实施状态:已实施(2026-07-30)**。case 级新增可选 `flaky` 布尔;`scoreCase` 返回 `flakyFailure`(`definition.flaky && criticalFailures > 0`);`aggregateCaseScores` 的 `criticalPassRate` 与 `buildOfflineRun`/`buildOnlineRun` 的 status 判定均排除 flaky 失败,实现"记分不阻断"语义。`.agents/runtime/evals/run.mjs` 同步该逻辑。

- schema 的 case 级增加 `flaky: boolean`(可选,默认 false)。
- scoring:`flaky=true` 的 case 失败时,`passed` 仍为 false 但标记 `flakyFailure:true`,**不触发 criticalPassRate 失败**(记分不阻断)。
- health:flaky 失败计入 `meanScore` 但不计入门禁失败计数。
- 借鉴:DeepEval `LLMTestCase(flaky=True)`——"score and verdict are still reported, but its failure never fails the test case"。

### P2:完善 golden 治理

> **实施状态:已实施(2026-07-30)**。case 级新增可选 `kind` 枚举(`standard`/`variation`/`edge`/`adversarial`);3 个 suite 共 29 个 case 已补 kind 值(core 分布:standard 4 / variation 3 / edge 4 / adversarial 7);按决策未加计数门禁,kind 仅作元数据标签。cost/trace 子项延后(依赖 P0 online 跑通)。

- **分类标准**:在 `eval-suite.schema.json` 的 case 增加 `kind` 枚举(`standard`/`variation`/`edge`/`adversarial`),对齐 DeepEval 四类。`eval:check` 可校验每个 capability 至少含 1 个 edge + 1 个 adversarial。
- **对抗输入再生**:借鉴 Promptfoo 红队,定期用新对抗输入扩充 safety-isolation 类 case;当前 hook 类只有 3 个(EVAL-HOOK-001..003),偏薄。
- **版本化**:reference 文件已含 `approvedAt`,可再加 `suiteVersion` tag 锚定基线(对齐 LangSmith dataset tag)。

### P2(可选):cost 预算与 trace 闭环

- cost_limit:在 `eval-runner.js` 累计 `totalTokens`,suite 级配置 `maxCostUsd`,超限 fail-closed。借鉴 Inspect AI `set_model_cost`。
- trace 闭环:codex-runner 已解析 transcript(events/toolCalls),可导出为结构化 trace;后续做 macro eval 聚合(借鉴 OpenAI Cookbook Macro Evals)发现跨 run 行为模式。

---

## 7. 回归评测的使用方式(对齐用户诉求)

用户要"每次模型/提示词/Hook/Skill/工作流变化时跑一次回归"。结合现状,推荐工作流:

| 变更类型 | 触发 | 跑什么 | 门禁 |
|---|---|---|---|
| 确定性代码(脚本/schema/lib) | PR CI | `eval:replay` + `test:eval` | 阻断(已实现) |
| 规则/提示/Skill/Hook/adapter(非确定性) | 本地按 Skill 流程 + PR CI | 改前冻结 reference → 改后 `eval:replay` 对比 → 必要时 `eval:online` | offline 阻断;online 报告(P0 跑通后) |
| 模型升级 | canary schedule 或手动 dispatch | `eval:online --suite vibe-harness-online-canary`(repetitions:3) | 报告 passAt1/passAtK/passCaretK;连续 degraded≥3 升级为失败 |
| 紧急验证 | 手动 | `vibe-harness eval run --project <temp> --mode online --suite <id>` | 报告 |

关键:修改非确定性 Agent 行为时,**必须遵循 `eval-driven-development` Skill 的 5 步**(定义失败场景→冻结参考→最小改动→同条件重跑→比较指标),这正是用户诉求的工程化落地。当前缺的是 online 维度的参考结果(P0)。

---

## 8. 来源

### 项目侧(已核实)
- `docs/rules/eval-driven-development.md`、`docs/evals.md`、`vibe-harness.config.json`、`package.json`
- `scripts/lib/eval-*.js`、`scripts/eval-*.js`、`runtime/evals/codex-runner.mjs`
- `evals/suites/*.json`、`evals/references/`、`.vibe-harness/evals/runs/`
- `.github/workflows/ci.yml`、`.github/workflows/evals.yml`
- 核实命令:`node -e` 读取 suite case 数;`ls evals/references/`;`grep trialSummaries`

### 业界(网络调研)
- **Inspect AI**(UK AISI):https://inspect.aisi.org.uk/ — Task 三段式、pass@k/pass_k/mode reducer、cost_limit、agents
- **Promptfoo**:https://www.promptfoo.dev/docs/intro/ — llm-rubric、red-team、缓存、CI/CD(更新 2026-07-28)
- **DeepEval**(Confident AI):https://deepeval.com/ — G-Eval/DAG/QAG、flaky 标记、四类 golden、`--official`(© 2026)
- **LangSmith**(LangChain):https://docs.langchain.com/langsmith/evaluation-concepts — trajectory 评测、dataset 版本化、分层门禁、online eval
- **Braintrust**:https://www.braintrust.dev/docs/guides/evals — experiment 不可变快照、online scoring
- **OpenAI Evals API / graders**:https://developers.openai.com/api/docs/guides/evals — string_check/text_similarity/score_model/python grader(2026-11 关停预警)
- **OpenAI Cookbook**:
  - Agent Improvement Loop:https://developers.openai.com/cookbook/examples/agents_sdk/agent_improvement_loop.md — hybrid 断言、trace 飞轮
  - Macro Evals:https://developers.openai.com/cookbook/examples/partners/macro_evals_for_agentic_systems/macro_evals_for_agentic_systems.md
- **论文**:
  - pass@k(HumanEval):arXiv:2107.03374(2021-07)
  - pass_k:arXiv:2406.12045
  - LLM-as-judge 偏差:arXiv:2306.05685(NeurIPS 2023)
  - SWE-bench:arXiv:2310.06770(ICLR 2024)
  - SWE-agent:arXiv:2405.15793

### 未决项
- **passCaretK**:公开检索无此标准术语,疑似内部命名(可能对应 Inspect AI 的 `pass_k_{k}` 即"多次全过"可靠性下限)。建议确认是否为笔误或内部约定;若要对外对齐可更名。
- **CircleEval**:公开检索未发现此框架,疑似"CircleCI 上跑 eval"的口语化或私有命名。
- **Ragas 指标详情**:docs.ragas.io 受 Cloudflare 拦截未抓取;RAG 场景非本项目重点,可略。
- **Anthropic agent-evals 专文**:原路径 404,已迁至 platform.claude.com,未检索到独立 eval 方法论页,待补充。
