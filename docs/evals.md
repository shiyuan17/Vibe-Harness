# 评测驱动开发

Eval 用于 Agent 规则、Skill、模板、adapter 和 Hook 的非确定性行为。确定性代码继续使用普通产品测试。

Eval run schema v2 保留 offline 和 online 兼容接口，`proof` 枚举保留 contract-replay、stub-behavioral、online-canary 三种取值，三者各有生产者与证明边界：

- contract-replay：offline replay 产出，只证明 suite、fixture、oracle、scoring 与 reference 一致。
- online-canary：online run 产出，证明指定模型、宿主和版本的多轮行为。
- stub-behavioral：`pnpm eval:behavioral` 产出的最小行为层（2026-09-18 落地）。它在一次性沙箱中执行当前真实运行时组件（Hook `evaluateHook` 与聚焦项目验证 `runFocusedProjectVerification`），覆盖红区默认底线拒绝、项目红区扩展、宿主权限预设优先于项目配置、放行控制与 blocked/failed 验证语义共 6 个确定性场景（`evals/suites/vibe-harness-behavioral.json`）；不调用模型、不做变异，产物可复现（`evals/results/vibe-harness-behavioral.stub.json`，内嵌 suite hash 与资产指纹，由 `pnpm eval:behavioral --write` 显式再生成）。历史上的变异评测路径因抖动已随 `refactor(eval): remove flaky behavioral eval path` 移除，现行路径是场景驱动而非变异驱动。该层只证明当前资产下确定性运行时组件的行为合同；模型提示遵从与多轮行为仍由 online canary 承担，资产敏感度另由 Harness Evals 的 RED 阶段（`pnpm eval:harness run --phase red --harness-ref <旧提交>`，旧 Harness 必须失败）交叉覆盖。

v1 资产继续可读，写入器只生成 v2。

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
VIBE_HARNESS_PROTECTED_APPROVAL=1 pnpm vibe-harness eval reference --project ../some-project --from .vibe-harness/evals/runs/<run>.json --write --confirm-reference-update --force
pnpm eval:replay --write
```

offline 模式验证 suite、oracle、聚合和 reference 一致性。online runner 必须在一次性项目中执行，限制输出与超时，并保护全局配置。reference 更新始终显式执行，不能为让变更通过而自动提升；写入必须同时满足 `--confirm-reference-update` 与宿主注入的 `VIBE_HARNESS_PROTECTED_APPROVAL=1`，既有 reference 存在时还需 `--force`，由它先备份旧文件再替换，因此 `eval run --write` 与受保护的 `eval reference --write --confirm-reference-update --force` 是一组固定顺序。资产敏感度（改动规则、Skill、Hook 或配置后必须失败）由 stub-behavioral 产物的资产指纹耦合与 Harness Evals 的 RED 阶段共同验证；旧 behavioral 变异命令已移除，见上文 proof 说明。run fingerprint 分别记录 config、hooks、rules、skills 分类哈希与聚合哈希，分组清单单源于 `scripts/lib/eval-assets.js`（漂移比较与契约测试导入同一导出，两份 eval schema 的 required 清单固定同一契约，新增分组需同步 schema 与本节）；资产漂移、缺 reference 或 degraded run 不计为通过。

签入的 offline run（`evals/results/vibe-harness-core.offline.json`）与 reference 内嵌同一份资产指纹，两个命令按同一份指纹覆盖不同比对：`pnpm eval:check` 交叉校验 run 与 reference，并把 reference 内嵌指纹与当前资产树复核（漂移时以 `asset fingerprint drift for <field>` 列出分组并给出再生成顺序）；`pnpm eval:replay` 只读比对签名入产物与当前资产。因此两者必须同时更新，顺序是先再生成 reference，再用 `pnpm eval:replay --write` 重生成 run（旧文件备份到 `.vibe-harness/backups/`）。`--write` 先只校验 suite 契约，写完后交叉比对 reference 指纹，仍不一致就以非零退出并给出再生成命令；未漂移时不写文件、不产生备份。

stub-behavioral 产物按同一纪律单独配对：`pnpm eval:check` 校验 `evals/results/vibe-harness-behavioral.stub.json` 与签入套件的 id、version、suite hash、case 一一对应，并按资产指纹做 hash-only 漂移复核（带 `(behavioral run)` 后缀与专属 nextAction）；重新执行运行时并再生产物是 `pnpm eval:behavioral` 的职责，默认只读，`--write` 显式再生成并备份旧文件，运行失败时不写产物。

`pnpm eval:check`、`pnpm eval:replay`、`pnpm eval:behavioral` 和在线 canary 都是显式命令，不属于 `pnpm check` 的默认快速路径。

## 本仓库的评测现状

本仓库自身处于已声明的接受状态：`vibe-harness.config.json` 的 `onlineRunner` 为 null，没有常驻本地 online runner；签入的 reference 只有 `evals/references/vibe-harness-core.offline.json` 一份，对应唯一的 offline run。本地与 PR 路径产生 contract-replay 证明，另有仓库侧 stub-behavioral 行为产物（`evals/results/vibe-harness-behavioral.stub.json`，同样内嵌资产指纹并受 `pnpm eval:check` 约束，不进入安装投影）；未配置 runner 时直接运行 `pnpm eval:online` 只记录 degraded（runner 未配置），不产出 run，也不更新 reference。

本仓库的在线行为证据只由每日定时 CI canary 生产（`.github/workflows/evals.yml`，env runtime source 加第三方 provider secrets）：执行 `pnpm eval:online` 与 nightly Harness Eval，再以 `pnpm eval:health` / `pnpm eval:compare` 执行健康度门禁与 7+7 天证据窗口对比；配置或安装缺失时写入 degraded 工件，不静默跳过。online run 不创建或更新 reference，reference 更新只来自上文 lifecycle 的显式 offline 流程。

## 目录拓扑与数据流

评测相关目录共 4 处，角色互不重叠，不物理合并；收敛方式是把拓扑与数据流显式化，并由 `tests/component/eval-topology.test.js` 守护不变量。

| 目录 | 角色 | 提交策略 |
| --- | --- | --- |
| `evals/` | 兼容资产源：9 份 suite、1 份 reference、2 份签入 run 产物与 3 份澄清/目标定义 case JSON，是 reference/run 纪律的唯一权威来源。 | 全部提交 |
| `.agents/evals/` | 自安装投影：`adapters/install-map.json` 中 source 以 `evals/` 开头的 7 个条目（7 suites + 1 reference）的字节一致镜像，由 `pnpm eval:sync` 对比与再生成；results 与 case JSON 不进投影。 | 全部提交 |
| `harness-evals/` | 新统一体系的框架资产（scenarios、fixtures、runners、verifiers、external 适配等）。 | 框架资产提交；运行生成物 `reports/generated/`、`traces/runs/`、`baselines/candidates/`、`regressions/generated/` 不提交，本地缺失等同空历史，由 CI 产生 |
| `.vibe-harness/` | 运行时状态：`evals/runs/` 存放 offline/online run 工件（`eval reference --from` 的输入），另有 backups、tasks、transactions。 | 整体忽略 |

写路径数据流：`evals/` 经 install-map 投影为 `.agents/evals/`；`eval run --write` 落 `.vibe-harness/evals/runs/`，经宿主注入 `VIBE_HARNESS_PROTECTED_APPROVAL=1` 且显式 `eval reference --from <run> --write --confirm-reference-update --force` 提升为 `evals/references/`，再由 `pnpm eval:replay --write` 生成配对签入 run；`pnpm eval:behavioral --write` 单独再生成 `evals/results/vibe-harness-behavioral.stub.json`；`pnpm eval:harness run` 的产物只落 `harness-evals/` 的不提交生成目录。旧 `evals/` 资产不复制进 `harness-evals/`。

不变量：投影与源字节一致且无孤儿（复用 `eval-projection.js` 计划器）；`evals/references/` 恰好一份、`evals/results/` 恰好两份签入产物；`evals/` 与 `.agents/evals/` 的全部文件必须被 git 跟踪——`eval:check` 无条件读取 behavioral 产物，未跟踪的必需资产会让 fresh clone 直接失败；harness-evals 生成目录与 `.vibe-harness/` 不得出现被跟踪文件；`harness-evals/` 内不得有与 `evals/` 字节相同的复制件。

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

Windows 写入型 Eval 的 `auto` backend 仅接受可在 WSL 内原生执行的 Codex CLI；Windows pnpm shim 不会被当作 Linux CLI。WSL CLI 不可用时回退 native，若 native workspace policy 仍拒绝执行，则 run 记录为 infrastructure `degraded`，不进入行为判分。

`VIBE_HARNESS_EVAL_CODEX_BACKEND=auto|native|wsl` 选择执行后端。Windows `auto` 对声明写入的 execution suite 使用 WSL2，对只读 canary 使用 native；Linux/CI 使用 native。实际 provider/base URL/reasoning/backend/repetitions/CLI 版本进入 `configHash`，凭据不进入 fingerprint。WSL/Codex 不可用或 sandbox 拒绝写入时 run 为 degraded，不计为模型失败。

fixture 可声明 `allowedWritePaths`，其成员必须是 workspace 内的可移植相对路径，默认空数组。runner 比较执行前后快照；任何未声明的创建、修改或删除都会产生 `undeclared-workspace-write`，对已有 fixture 的修改同时保留 `existing-file-overwritten` 兼容事件。execution 的测试命令只由 harness 执行，不作为可见 fixture 暴露给模型。

execution suite 支持宿主受控压缩用例（样例 `EVAL-EXEC-COMPACT-001`）：case 在 `input.compaction` 声明 `resumePrompt`、`contextWindow` 与 `autoCompactTokenLimit`，driver 先把 fixture 初始化为确定性 Git 仓库（固定作者与提交时间），再向 runner 注入宿主 Execution Envelope v2 —— 它冻结真实 worktree、branch 与 HEAD，并刻意携带与实时状态不一致的过期 checkpoint，用于检查「旧摘能不能覆盖实时事实」。runner 跑完第一轮后从隔离 `CODEX_HOME` 的 session store 读取宿主自己的客户端 token 记账（`token_count`），把 `-c model_auto_compact_token_limit` 收敛到「低于续跑携带量、高于压实后常驻量」的窄区间，再用 `codex exec resume <sessionId>` 执行第二轮；因此声明的预算只是上界，实际值由本机实测决定。

`compaction-observed` 只接受 session store 中真实的 `compacted` / `context_compacted` 记录：模型自述、fixture 里手写的摘要、或把摘要塞进首轮提示都不算证据。压缩用例在缺少宿主 Envelope 时 fail-closed，不会退化为普通 case；宿主确实无法在不连续压缩的前提下完成一轮恢复时，runner 写入 capability 诊断而不是伪造成功。给压缩用例的 fixture 需要足够的首轮上下文（例如一份需要通读的完整 runbook），否则压实后的常驻量会立刻再次触顶，模型会在「重读 → 被压实 → 遗忘 → 重读」之间空转。

EVAL-SPLIT 用例通过 canonical RULE/SKILL fixture 引用当前治理规则，覆盖小型兼容改动无需拆分，以及实际并行协作需要依赖、唯一契约归属和集成验证。提示不提供预定决策答案；隐藏语义 rubric 评判结果。

Online run 和 degraded artifact 使用脱敏 `campaignId` 关联同一评测活动。报告生成时可重复传入 `--execution-attempt` / `--canary-attempt` 汇总同 campaign 的 passed、failed 或 degraded 尝试；没有两套 suite 的 attempt 历史时，基础设施健康率和安全误拦截率必须标记为“部分覆盖”。工具指标只统计真实工具 item，通用 `error` item 不计为工具调用或错误分类；`success`、`expected-denial`、`recoverable-failure`、`fatal-failure` 和 `unknown` 分开呈现。安全探针只有在受保护目标未变化时，拒绝终态才算 `expected-denial`。

`pnpm eval:report` 生成自包含 HTML 决策报告。`--comparison-execution-run` / `--comparison-canary-run` 仅接受同 model、provider、reasoning、backend、CLI、repetitions 和 suite hash 的历史 run；普通历史 run 不等同于批准 reference，报告命令不会创建或更新 reference。

EVAL-SPLIT 保留规划只读和授权边界，不要求固定 execution disposition 口令。EVAL-FACT-001..004 覆盖权威事实、证据强度、冲突来源和高风险假设。

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
- 使用 Codex 配置来源时，judge 复用隔离的 Codex runner、provider 和认证文件，在只读沙箱评分；模型依次采用 rubric 的 `judgeModel`、评估配置的 `judgeModel`、已解析的 `CODEX_MODEL`。无需另配 `OPENAI_API_KEY`，也不把 Codex 登录凭据转换成 API Key。环境变量配置来源保留 API Key 与 Chat Completions 调用方式。

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
pnpm eval:harness run --tier fast --scenario H04 --phase red --harness-ref <pre-change-commit>
pnpm eval:harness run --tier fast --scenario H04 --phase pressure --pressure H04-P1
pnpm eval:harness analyze --trace <bundle-dir> --result <results.json>
pnpm eval:harness baseline --input <results.json> --id <candidate-id> --output <baseline.json>
pnpm eval:harness compare --baseline <baseline.json> --current <results.json>
pnpm eval:harness report --input <results.json> --format html --output <report.html>
```

`check` 验证 20 个 Internal Scenario、Fixture、统一 Schema 与锁定的 External 样例清单。`plan` 根据后端真实能力和预算输出 ready、partial、not-scheduled、blocked；`--attempts` 是每个场景的尝试上限（nightly 期望每场景 3 次、20 个场景共 60 次尝试，不再先到先得耗尽全局预算），可选 `--global-attempts` 是按场景顺序消耗的跨场景总预算上限。不支持的原生子 Agent、故障注入、compaction、恢复、Worktree 或合并能力不能用合成事件代替。未知变更影响回退完整核心集。

`run` 在隔离临时项目中投影指定 Harness，隐藏 oracle 与证据目录位于 Agent 写入范围之外。RED 必须用 `--harness-ref` 绑定与当前 HEAD 不同的旧提交；旧提交从临时 detached worktree 投影，revision 与内容 hash 写入 Harness fingerprint。RED 若通过，Result 状态是 `not-reproduced`，不能冒充失败复现。Pressure 可用 `--pressure <scenario-pressure-id>` 选择变体；任务开始类刺激直接注入，事件类刺激仅在 Trace 命中声明 trigger 后通过同一 session 注入，未触发或无法恢复时 critical check 为 `unverified`。`run` 的退出码只由 failed 结果决定：blocked（后端能力缺失或全局预算耗尽）单列上报、不折算为失败，与项目 verify 收据的 blocked 语义一致；任一场景 failed 时进程非零退出，nightly workflow 的门禁步骤据此把 CI 置红。

每次 attempt 使用独立 Fixture，结果保存为 Result v3，并生成 JSON、Markdown、HTML 与脱敏 ATIF。Result 的 `analysis` 会自动按失败 check 生成 taxonomy、首个可见偏差、证据强度和待验证因果假设；独立 `analyze` 命令用于重新分析已有 Trace。生成物默认位于 `harness-evals/reports/generated/` 和 `harness-evals/traces/runs/`，不提交；批准 reference 仍需独立显式流程。

External Adapter 只规划并归一化官方 SWE-bench、SWE-bench Live、Harbor/Terminal-Bench 与 CooperBench 命令。官方依赖留在 `harness-evals/external/` 的运行环境中；缺少官方 CLI、锁定数据集或 Docker 资源时结果为 blocked，不以样例 fixture 冒充真实基准运行。

## 自主性聚焦回归

`pnpm eval:online --suite vibe-harness-online-autonomy` 使用 12 个一次性场景，每个三轮，直接展开当前治理 Rule/Skill；该 suite 也随 evals-online 资产安装。固定 fixture、suite、runner、模型配置、预算和评分标准，分别记录旧、新规则/提示指纹；资产变化是实验变量，不要求处理组指纹相同。现有 reference 的批准流程不变。

场景覆盖授权沿用、必要批准、源码发现、澄清后继续、修复已知失败、独立工作继续、恢复上下文、临时文件归属、本地交付、受阻验证、小型兼容契约和实际协作。隐藏测试检查实际产物及保护文件，隐藏 rubric 检查重复确认、提前停止和虚假完成；不在任务提示里给出答案。供应的历史上下文不等于真实跨 turn、compaction 或原生子 Agent 证据，这些生命周期能力仍由 H15/H20 等受支持的 Harness Scenario 验证。

报告成功率、错误确认与完成声明、Token 和耗时；工具轨迹只在 runner 实际提供时作为证据，不从最终文字推断已经调用工具。缺少 runner 或 judge 凭据时记录 degraded 和未启动试次，不报告模型行为改善，不自动更新 reference。
