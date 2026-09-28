# Harness Evals

`harness-evals/` 是 Vibe-Harness 的统一评测实现目录，用于验证规则、工作流、Agent 协作、工作区隔离、上下文恢复、验证和故障恢复是否产生可靠且可观察的行为。

评测不只判断最终补丁是否正确，还会独立检查过程证据、Git 状态、工具调用、验证顺序、Trace 和基础设施状态。内部场景与外部基准统一输出 Result v3，并可用于报告、基线和回归比较。

## 快速开始

在仓库根目录执行。所有命令都使用一次性 Fixture 或受控的评测工作区，不要把真实用户项目作为评测目标。

```bash
# 校验场景、Fixture、Schema 和外部适配器契约
pnpm eval:harness check

# 只生成 Fast 评测计划，不执行 Agent
pnpm eval:harness plan --tier fast

# 执行 Nightly 评测
pnpm eval:harness run --tier nightly

# 运行固定的快捷检查和计划生成
pnpm eval:harness:fast
```

需要完整的发布级矩阵时使用 `pnpm eval:harness:full`。完整架构、Result v3 和证据边界见 [`../docs/specs/harness-evals-framework.md`](../docs/specs/harness-evals-framework.md)；旧版 `evals/` 生命周期和兼容说明见 [`../docs/evals.md`](../docs/evals.md)。

## 目录结构

| 路径 | 职责 |
| --- | --- |
| [`scenarios/`](scenarios/) | Canonical Scenario v3 定义。当前包含 H01-H20，每个场景声明目标、Fixture、能力要求、压力阶段、检查项和失败分类。 |
| [`fixtures/`](fixtures/) | 一次性工作区的 Manifest 和 Materializer。负责创建文件、Git、分支、进程及确定性故障，并隐藏写入白名单和检查资产。 |
| [`runners/`](runners/) | 评测生命周期控制，包括准备、执行、预算、能力预检、取消、恢复、证据收集和清理；`codex-cli.js` 提供 Codex CLI 后端。 |
| [`verifiers/`](verifiers/) | 独立验证器。`deterministic.js` 执行单项可重复检查，`scenario.js` 汇总场景结果；验证器不依赖 Agent 自报。 |
| [`metrics/`](metrics/) | 计算结果、工作流、Agent、协作和效率指标，并为缺少遥测的数据保留 `unavailable` 原因。 |
| [`traces/`](traces/) | 写入、读取和脱敏 ATIF Trace、事件流、轨迹和工件索引，支持按证据分析可观察偏差。 |
| [`baselines/`](baselines/) | 从已验证结果创建可比较的基线，冻结场景、Fixture、模型、后端、Verifier 和 Harness 指纹。 |
| [`regressions/`](regressions/) | 根据变更影响选择场景、比较基线与候选结果，并分析单 Agent 与多 Agent 条件。 |
| [`reports/`](reports/) | 将 Result v3 和比较结果渲染为 Markdown 或 HTML 报告。`generated/` 下的内容是运行产物。 |
| [`lib/`](lib/) | 对外组合入口、目录加载、Result、计划、Fixture、Runner、Verifier、Metrics、Trace 和报告等共享模块。 |
| [`external/`](external/) | 官方外部基准的适配器和样例 Manifest，包括 SWE-bench、SWE-bench Live、Terminal-Bench/Harbor 和 CooperBench。 |
| [`docs/`](docs/) | 场景编写和压力因子说明，供维护者新增或修改评测资产时使用。 |

### 运行产物

- `reports/generated/<run-id>/`：`results.json`、`report.md` 和 `report.html`。
- `traces/runs/<run-id>/`：脱敏事件流、ATIF trajectory、artifacts 索引和 Trace 完整性证据。

上述目录用于本地分析，默认不作为源码、正式基线或外部 benchmark 结果提交。正式基线只保留批准的脱敏证据、可复现 Manifest 和哈希。

## 评测流程

统一流程为：

```text
RED -> GREEN -> Pressure -> Regression -> Trace Analysis
```

1. **RED**：在与当前 HEAD 不同的不可变 Harness revision 上执行基线实验。若原问题未复现，结果记为 `not-reproduced`，不会削弱评测来制造失败。
2. **GREEN**：保持模型、任务、Fixture、预算、Runner 和检查不变，只验证最小 Harness 改动是否改善结果。
3. **Pressure**：在相同基础任务上注入一个确定性压力因子，再执行一个不争抢触发时机的双因子组合。未触发的压力记录为 `unverified`。
4. **Regression**：选择受影响场景和固定关键集，保留失败、降级、阻塞和取消尝试，避免只看通过样本。
5. **Trace Analysis**：结合检查和可观察 Trace 生成失败分类、首个偏差、证据强度及待验证的因果假设；不会声称读取模型私有推理。

每个已启动的尝试都会生成结果，即使基础设施失败。`blocked` 和 `unverified` 不能转换成通过，缺少遥测也不能当作零值。

## 常用命令

这些命令通过 `package.json` 中的 `eval:harness` 脚本调用 `scripts/harness-evals.js`。

### 校验和规划

```bash
pnpm eval:harness check
pnpm eval:harness plan --tier fast
pnpm eval:harness plan --tier nightly --scenario H01,H04
pnpm eval:harness plan --changed "docs/rules/governance-core.md,scripts/harness-evals.js"
```

`plan` 只输出计划，不启动 Agent。`--changed` 会读取 [`regressions/impact-map.json`](regressions/impact-map.json) 选择受影响场景；也可以用 `--scenario` 指定逗号分隔的场景 ID。

### 执行内部场景

```bash
pnpm eval:harness run --tier fast --dry-run
pnpm eval:harness run --tier nightly
pnpm eval:harness run --tier full --scenario H01,H13
pnpm eval:harness run --tier nightly --phase pressure --pressure stale-context
```

常用参数包括：

- `--tier fast|nightly|full`：选择评测矩阵。
- `--scenario H01,H02`：只执行指定场景。
- `--attempts <n>`：限制每个场景的重复次数。
- `--phase red|green|pressure|regression`：选择实验阶段。
- `--harness-ref <git-ref>`：RED 阶段必填，且必须解析到区别于当前 HEAD 的历史 revision。
- `--pressure <id>`：Pressure 阶段选择压力因子。
- `--wall-time-ms <n>`：覆盖单次场景的墙钟预算。
- `--output-dir <path>`：指定报告输出目录。
- `--dry-run`：只生成执行计划和实验信息，不创建 Fixture、不运行 Agent。

### 报告、基线和比较

```bash
pnpm eval:harness report --input harness-evals/reports/generated/<run-id>/results.json
pnpm eval:harness report --input results.json --format html --output report.html
pnpm eval:harness baseline --input results.json --id core-nightly-2026-09
pnpm eval:harness compare --baseline baseline.json --current results.json
pnpm eval:harness analyze --trace harness-evals/traces/runs/<run-id>/<scenario>/execution-1/attempt-1 --result result.json
```

报告支持 `markdown`、`html` 和 `json` 格式。比较前必须确认基线与候选结果的测量条件兼容；模型、数据集、Verifier、预算或 Harness 指纹变化时，应建立新的比较基准。

仓库还提供三个预设层级：

```bash
pnpm eval:harness:fast
pnpm eval:harness:nightly
pnpm eval:harness:full
```

Fast 适合 PR 级契约检查和少量关键场景；Nightly 覆盖 H01-H20 及压力变体；Full 在此基础上加入固定的外部 benchmark 样本和明确预算的模型/Agent 矩阵。

## 场景集合

当前内部场景按能力分为以下几组，逐项的正式定义、检查和 Fixture 引用以 [`scenarios/index.json`](scenarios/index.json) 及对应 JSON 为准：

| 能力组 | 场景 | 覆盖内容 |
| --- | --- | --- |
| 规则与计划 | H01-H02、H07-H08 | 规则冲突、嵌套规则发现、事实驱动的计划修正和生成源追踪。 |
| 测试与验证 | H03-H06、H10-H11 | TDD 失败基线、最后一次修改后的验证、异步完成、真实失败报告、构建和测试恢复。 |
| 工具与上下文 | H09、H12-H13、H20 | 工具故障、上下文压缩、过期 checkpoint、进程中断和恢复。 |
| 协作与隔离 | H14-H19 | Agent 交接、子 Agent 失败、依赖调度、重复工作、worktree 隔离和合并冲突。 |

所有场景都必须能通过独立可观察证据区分 Agent 失败、Fixture 缺陷、Verifier 缺陷、采集失败和 Runner/基础设施失败。

## 扩展评测

新增或修改内部场景时，先阅读 [`docs/scenario-authoring.md`](docs/scenario-authoring.md)。该规范要求使用 Scenario v3、一次主失败机制、真实但有界的工程任务、至少一个产物或命令检查和一个工作流检查。

压力变体必须遵循 [`docs/pressure-catalog.md`](docs/pressure-catalog.md)：每个因子都需要稳定 ID、确定性触发事件、预期不变量和 Trace 证据。不要使用随机时序，也不要把 hidden oracle 放进 Agent 可见的提示或 Fixture。

外部基准通过 [`external/`](external/) 适配器接入。适配器负责发现任务、物化 Fixture、规划官方命令和归一化结果；官方 Runner、Verifier、数据集和依赖仍由对应基准项目提供。缺少官方依赖、锁定数据集或运行资源时，结果应记录为 `blocked`，不能用样例 Fixture 冒充真实运行。

## 边界与安全要求

- Fixture 只创建临时、可清理的评测工作区；真实源仓库和用户工作区不是评测目标。
- Hidden checks、写入白名单、故障控制和证据存储位于 Agent 可见范围之外。
- 命令计划使用 `shell: false`，不在参数、日志、Trace、报告或 Result 中写入凭据和私密数据。
- Agent 越过 `allowedWritePaths` 是关键失败，即使最终测试通过也不能覆盖该结论。
- External adapter 不 vendor 官方 benchmark，也不替代官方验证器；Harness 的工作流检查是附加证据。
- 生成的报告和 Trace 只作为本地分析输入；批准的基线必须满足脱敏、可复现和指纹兼容要求。

## 相关文档

- [`../docs/specs/harness-evals-framework.md`](../docs/specs/harness-evals-framework.md)：统一架构、公共契约、证据模型、指标和兼容规则。
- [`../docs/evals.md`](../docs/evals.md)：仓库级 Eval 生命周期、legacy suite 和 online runner 说明。
- [`docs/scenario-authoring.md`](docs/scenario-authoring.md)：Scenario v3 和 Fixture 编写规范。
- [`docs/pressure-catalog.md`](docs/pressure-catalog.md)：压力因子和推荐组合。
- [`../schemas/harness-eval-scenario.schema.json`](../schemas/harness-eval-scenario.schema.json)：场景源 Schema。
- [`../schemas/harness-eval-fixture.schema.json`](../schemas/harness-eval-fixture.schema.json)：Fixture Manifest Schema。
- [`../schemas/harness-eval-result.schema.json`](../schemas/harness-eval-result.schema.json)：Result v3 Schema。
