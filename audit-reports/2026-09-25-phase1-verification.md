# Phase 1：验证、评审与完成证据审查

## 范围与事实边界

- 基线：`98a9d52585e8cfe4692e8f81810b075cd8643dc6`；审查日期为本地 2026-09-25，负控输出的 UTC 时间为 2026-09-26。
- 域前缀 `VER`：test/micro/review 规范、验证收据与完成判定、Review/merge gate、Eval/verifier、冻结测试保护及 CI 门禁条件。
- 只读取共同 Phase 0 基线及本域资产；未读取其他 Phase 1 输出，未重新全量枚举，未派发子 Agent。产品文件只读；本报告为唯一持久写入。实验仅使用可清理的临时项目，不联网、不安装、不跑全量测试。
- 已确认 `codebase-memory status` 返回 `unavailable / runtime-not-installed`；没有将该外部能力当作已实现。代码先用 CodeGraph；工具未覆盖的精确片段与标记 pending-sync 的文件按要求直接读取。末次 `git diff --name-only` 为空，源基线未变化。
- “已实现”仅指源码存在且本轮覆盖的行为成立；“部分实现”表示真实入口存在但关键合同未闭环；另外三档为“仅规范定义 / 缺失 / 无法确认”。这些状态不是项目评分。
- 下列优先级使用本轮要求的 P0/P1/P2；没有发现足以标 P0 的证据。不把文档长度、规则数量、shadow 策略或未加载宿主 Hook 本身算作缺陷。

## 结论

最低成本路线不是再增加审查角色、收据字段或测试层，而是让已有消费者真正检查已有证据。当前最重要的断点在**最后消费处**：完成命令相信旧状态、Review 相信不完整的身份集合、合并聚合遗漏一个真实 job、Eval 用一般成功轨迹替代特定协作合同。Micro 则存在相反方向的误阻断。

| Finding | 优先级 | 核实程度 | 五级实现状态 | 根因摘要 |
|---|---|---|---|---|
| VER-F01 | P1 | 已确认事实；队列消费细节含静态结论 | 部分实现 | 收据生成记录指纹，但终态消费没有保持新鲜度不变量 |
| VER-F02 | P1 | 已确认事实 | 部分实现 | v2 Review 只验集合内部去重，未验与实施者的独立关系 |
| VER-F03 | P1 | 已确认事实；线上阻断效果无法确认 | 部分实现 | required 聚合的手写 job 清单遗漏 security |
| VER-F04 | P1 | 已确认事实 | 部分实现 | Eval 的机制专用断言退化为一般“修改后验证”断言 |
| VER-F05 | P2 | 已确认事实 | 部分实现 | 两套 Micro 分层判定重复且顺序相悖，合法成功永久降为 blocked |

## Findings

### VER-F01 — 新修改后，旧 passed 仍满足显式完成检查

**问题。** 合法执行验证并将收据记录到 done 单元后，再把被测行为改坏，`task check --complete` 仍返回 `passed`、退出 0。这里不是指普通任务记录应自动触发测试，而是显式消费“完成证据”的入口没有核对证据对应的当前状态。同一新鲜度缺口也出现在深度队列终态。

**证据（路径、行号与原文）。**

- `docs/rules/test-rules.md:8`：“同一指纹、同一命令集合且此后无实质写入才复用已 passed 的收据；有实质写入必须重跑。”
- `docs/rules/governance-core.md:84`：“handoff 只引用晚于最后一次实质修改的结果。”
- `runtime/commands/run.mjs:3495`：`const unverified = targetUnits`，后接 `unit.status === 'done' && unit.verification?.status !== 'passed'`；`:3501` 的完成谓词仅组合 `unfinished / unverified / failedUnits / blockers`，没有比较当前工作树、命令集合或收据指纹。
- `scripts/verification-queue.js:52`：`const allowed = current.status === 'queued' ? ['running', 'stale'] : current.status === 'running' ? ['passed', 'failed', 'blocked', 'stale'] : [];`；`:64` 的 `markStaleIfChanged` 却会调用 `transitionQueue(..., 'stale', ...)`。
- `scripts/verification-queue.js:80`：`if (queued.status !== 'queued') continue;`；`:85` 到 `:101` 从 running 执行到 passed，没有在消费前比对已存 `commitSha / worktreeFingerprint / commandSetFingerprint / planFingerprint`，也未绑定执行得到的新 verification receipt。

**本轮负控。** 临时 Git 项目声明 `test: node check.mjs`，断言 `value.txt === "good"`；先取得真实 passed 收据，用 `task update --unit u1 --unit-status u1:done --verification <真实JSON> --write` 记录；随后改为 `"bad"`。直接运行相同检查退出 1，但完成命令仍通过：

```json
{"beforeVerification":"passed","beforeComplete":"passed","postChangeBehaviorExit":1,"postChangeComplete":"passed","postChangeCompleteExit":0}
```

队列最小实验依次 `enqueue → running → passed`，随后对新身份调用 `markStaleIfChanged`，得到 `Invalid queue transition passed -> stale`，落盘状态仍为 `passed`。未执行完整队列消费者；它不比较入队身份的结论来自上述当前源码。

**五级实现状态。** 部分实现：验证产生真实命令结果与指纹，任务完成和异步收据的消费端未维持同一不变量。

**根因。** 将 `passed` 当作持久布尔事实，而非“某输入状态、某命令集合”的关系。生产端有证据元数据，消费者只读状态标签；队列状态机又把 stale 排除在已通过终态之后。

**影响与边界。** 已复现本地完成假阳性，足以误导长期任务恢复与父 Agent fan-in。没有声称工作树合并门、远端发布或其他消费者均可绕过；那些链路未在本域重复深读。

**最低成本改进。** 不增加新收据：在显式 `--complete` 路径复用已有指纹/命令集合比较，缺失或不匹配返回 unverified/blocked；队列在消费前核对已存身份，终态查询按当前身份派生 stale，或允许 passed→stale。只补“真实通过→改坏→拒绝完成”和“passed→新指纹→stale”负控。若队列暂时没有证据消费者，先停止把它的终态当正式完成证据，优于继续扩展状态机。

**优先级：P1。**

### VER-F02 — v2 双独立评审可包含实施者本人

**问题。** 顶层 `reviewer` 与 `implementer` 不同时，`reviewers` 数组仍可由“实施者 + 一个评审者”组成；代码判为 `healthy / REVIEW_APPROVED`。两个数组元素互不相同，并不等于两个都独立于实施者。

**证据（路径、行号与原文）。**

- `CONTRIBUTING.md:133`：“v2 收据还必须包含两个不同 reviewer/context，且 `contextIndependence=verified`”；同处明确默认 shadow，此策略不计作本 finding。
- `scripts/lib/review-audit.js:97`：`receipt?.reviewer?.identity === receipt?.implementer?.identity`；`:98` 同样只比较顶层 reviewer context。
- `scripts/lib/review-audit.js:101`：`const identities = reviewers.map((item) => item?.identity).filter(Boolean);`；`:104` 只检查 `new Set(identities).size !== identities.length`，`:105` 对 context 同理，未将 implementer 纳入排除关系。
- `scripts/lib/review-audit.js:119`：`if (risk.level === 'high' && evidence.length === 0) evidence.push(auditItem('REVIEW_APPROVED', 'info', 'Independent review receipt is current and approved.'));`
- `schemas/review-receipt.schema.json:15` 仅定义 reviewers 的元素形状与 `minItems: 2`，没有替代上述关系检查。

**本轮负控。** 使用真实 schema 和高风险路径 `runtime/commands/run.mjs` 调用公开 `evaluateReviewReceipt`；顶层 reviewer 为另一身份，`reviewers=[implementer, reviewer]`，两 context 不同，`contextIndependence="verified"`。结果：

```json
{"status":"healthy","codes":["REVIEW_APPROVED"],"primaryReviewerNegative":"degraded"}
```

负控对照将顶层 reviewer 改为 implementer 后正确降为 degraded，说明缺口确实位于数组成员关系而非测试没走审查逻辑。该实验的 verification ID 是不存在的 `missing-receipt`、时间为 2000 年，仍被接受；这同时证明此入口只做内嵌声明检查，不证明宿主独立性或最终验证产物的真实性。后者作为能力边界记录，不另增 finding。

**五级实现状态。** 部分实现：schema、当前 diff、顶层身份及声明字段检查已实现；v2 独立集合关系不完整，真实宿主证明无法由这段代码确认。

**根因。** `reviewer` 与 `reviewers` 形成重复真值；将“集合内唯一”和一个 `verified` 字符串，误当“相对于实施者的独立评审”。

**影响与边界。** 已复现非法自审被标批准，污染 shadow 统计，也会在未来 required 模式形成误放行。目前 CI 明示 shadow，不能据此声称已绕过一个当前强制的独立 Review 门。

**最低成本改进。** 单一化 reviewer 列表；每个 reviewer 的 identity/context 都须区别于 implementer，并核对顶层兼容字段确为列表成员。没有可信宿主证据时保持 attested/degraded，不用新增 Agent 或填更多自报字段制造独立性。先修判定，再讨论是否启用 required。

**优先级：P1。**

### VER-F03 — security 失败不进入唯一 required merge-gate

**问题。** workflow 实际运行依赖审查和 gitleaks，但 required 聚合不依赖 `security`，也不读取其状态；其失败不能使该聚合失败。

**证据（路径、行号与原文）。**

- `docs/github-delivery.md:20`：“required status check 只选择 merge-gate”；`:25`：“失败 check 会使 merge-gate 失败”。
- `.github/workflows/ci.yml:217` 定义 `security`；`:229` 使用 dependency-review，`:231` 为 `fail-on-severity: high`；`:232` 使用 gitleaks。
- `.github/workflows/ci.yml:299`：`needs: [change-plan, product, supply-chain, risk-evidence, branch-policy, independent-review, high-risk-approval]`，不含 security。
- `scripts/merge-gate.js:9` 到 `:21` 的 `names` 不含 `SECURITY_RESULT`；`:23`：`.filter((name) => process.env[name] !== undefined)`，只聚合显式列入且存在的项。

**本轮负控。** 将 workflow 当前导出的七项 gate 状态设为 success，另设 `SECURITY_RESULT=failure`，直接执行 `node scripts/merge-gate.js`：

```json
{"security":"failure","gateExit":0,"gateOk":true,"securityConsumed":false}
```

**五级实现状态。** 部分实现：安全扫描 job 与聚合器均存在，失败传播边断开。远端 ruleset 是否确按文档安装无法确认。

**根因。** job 清单、env 映射与聚合器名称表手写多份；测试/文档中的“有安全检查”不等于“安全检查参与最终决策”。

**影响与边界。** 已证明仓库声明的唯一 required gate 可在安全 job 失败时绿色；若管理员只启用所述 gate，则不能阻断对应合并。未访问 GitHub、未读取真实凭据、未执行真实泄漏或依赖漏洞场景，不声称远端已发生不安全合并。

**最低成本改进。** 将现有 `security` 接入 `needs` 和 env，聚合器消费 `SECURITY_RESULT`，加一条失败传播负控。无需增加扫描器、角色或第二套门禁；维护一个明确的 required job 集合，而不是靠扫描名称存在证明控制有效。

**优先级：P1。**

### VER-F04 — H16 协作 Eval 未验证依赖顺序，错误轨迹照样全通过

**问题。** H16 要求 decoder 在 schema producer 完成后派发；当前 verifier 只检查若干事件存在。更严重的是，完全没有 subagent 事件时也可退回通用“修改后验证成功”分支，令整个真实 H16 fixture 通过。

**证据（路径、行号与原文）。**

- `harness-evals/scenarios/H16-multi-agent-dependency.json:10`：`"The parent dispatches independent work in parallel but starts the consumer only after the producer contract is available."`
- 同文件 `:28`：`"wait-before-dependent-dispatch"`；`:29`：`"dispatch-dependent-task-early"`；`:34` 将 “decoder dispatch follows schema completion” 声明为 critical trace check。
- `harness-evals/verifiers/scenario.js:163` 到 `:166` 仅用 `has('agent-dispatch')`、`has('agent-complete')`、`has('verification')`，然后返回 `passed: true`，没有 producer/consumer 关联和顺序比较。
- 同文件 `:193` 的缺少专用证据拒绝清单为 `['stale-context', 'agent-handoff', 'subagent-failure', 'duplicate-work', 'worktree-conflict']`，遗漏 `multi-agent-dependency`；`:199` 到 `:200` 对一般 change→verification 返回通过。
- `tests/component/harness-evals-scenarios.test.js:214`：`['H14', 'H15', 'H17', 'H18']` 是现有协作结构化负控选择，未覆盖 H16。

**本轮负控。** 使用仓库 `createFixtureManager` 物化真实 H16 fixture，修改允许范围内 schema（保持 encode/decode 隐藏测试通过），执行真实 `createScenarioVerifier`：

1. 仅提供 `[change, verification(succeeded=true)]`，没有任何 subagent 事件。
2. 提供 `dispatch(decoder) → dispatch(schema) → complete(schema) → verification`，显式违反依赖顺序。

两次均得到 H16-C1/C2/C3 全部 passed，整体 `status: "passed"`；第二次 C3 evidence 仍是 `dependencyDispatch:true / producerCompletion:true / parentVerification:true`。

**五级实现状态。** 部分实现：真实隐藏 outcome 测试和 Git 写入范围检查可执行，特定协作行为的判据未实现到所声明精度。

**根因。** 复用一般轨迹成功启发式替代每个机制的必要条件；场景文字写得比机械断言更强，测试又只覆盖部分相邻机制。

**影响与边界。** 当前可将“无协作”或“依赖提前派发”的轨迹记为协作成功，不能用此 passed 支撑长期多 Agent 可靠性提升。实验只验证确定性评分器，不是一次在线模型表现测量，也不说明其他 H01–H20 都有同样问题。

**最低成本改进。** 删除 H16 的通用通过回退；缺专用事实返回 unverified/blocked。复用已有事件顺序结构核对 producer completion 在 consumer dispatch 前，并关联对应 Agent/单元，而非新增协作引擎。将本次两个坏轨迹加入现有 verifier 负控。

**优先级：P1。**

### VER-F05 — 源仓库结构化 Micro 成功被永久降级为 blocked

**问题。** 同一个确定性纯函数 probe，在源 `verify:micro` 路径产生 `exitCode=0`、`snapshotComparison=match`、正常输出，却是 blocked；受管 runtime 源入口为 passed。

**证据（路径、行号与原文）。**

- `docs/rules/micro-verification.md:18`：“只有达到预期退出码、快照匹配且输入输出摘要可审计时才为 passed。”
- `scripts/micro-verify.js:105`：`await executeStructuredMicro(check, targetDir, { snapshotBefore: before });`，未传 `snapshotAfter`。
- `scripts/lib/micro-runner.js:85`：`const snapshotComparison = snapshotBefore && snapshotAfter`；`:87` 缺一即 `'unavailable'`；`:88`：`if (result.status === 'passed' && snapshotComparison !== 'match') result.status = 'blocked';`。
- `scripts/micro-verify.js:106` 到 `:110` 才取得 after 并改为 match，但只实现 passed→blocked，没有把此前因 unavailable 降级的成功恢复。
- `tests/component/micro-receipt.test.js:8` 的测试是 `Micro receipt schema accepts bounded passed evidence`，验证的是手构 JSON；`tests/integration/installed-micro.test.js:47` 覆盖安装 runtime 的正常入口，不是上述源 CLI 组合。

**本轮负控。** 临时 Git 项目声明结构化 pure probe，入口为 `export default () => 7;`，调用公开 `scripts/micro-verify.js` 的 `main(['--id','pure','--run','--json'], fixture)`。实际：

```json
{"status":"blocked","exitCode":0,"snapshotComparison":"match","outputSummary":{"stdout":"{\"output\":7}","stderr":""}}
```

随后对同项目执行 `runtime/commands/run.mjs verify --micro pure` 为 passed。本轮调用的是安装运行时的源入口，没有进行新的 install 或宣称真实宿主验收。包含源 Micro 的实验进程最终退出 1，是产品 main 设置的 blocked 退出码，不是实验基础设施报错。

**五级实现状态。** 部分实现：执行与两个快照都存在，最终状态组合错误。

**根因。** 内外两层都拥有“工作树稳定性→最终状态”的决定权；内层在无法取得 after 时提前终结，外层无法纠正，形成两套 runner 行为漂移。

**影响与边界。** 有效局部证据被阻断，诱发无意义升级、重试或绕开入口。已证明源结构化路径；不把安装 Micro 判成失效，也未测试全部 legacy command 兼容面。

**最低成本改进。** 快照采集与最终状态只保留一个所有者；更优先复用受管 runner 的共同实现，而非新加补偿字段或恢复分支。补一条经源公开入口的成功测试，再复用既有 changed/timeout/overflow 负控确保不误放行。

**优先级：P2。**

## 关键机制五问

下表只评价本域关键机制。表中的“稳定执行”是当前边界，不将规则文本等同于宿主保证。

| 机制与五级状态 | 解决什么问题？ | 删除后果？ | 是否有更简单替代？ | Agent 能否稳定执行？ | 如何自动验证？ |
|---|---|---|---|---|---|
| L0–L6 与完成主张规则：仅规范定义 | 防止低层成功冒充整体完成 | 证据范围容易膨胀 | 保留“最后修改后的匹配检查”核心，不复制多套枚举 | 能理解，但本身不能强制消费者 | 用少量消费端反例，而非只断言文案存在；`governance-core.md:81` |
| 同步 verify 与快照：已实现（本轮聚焦范围） | 将命令结果绑定一次工作树状态 | 失去可复核命令/身份边界 | 一个共享 snapshot+execute+report 内核 | 显式命令可稳定执行；Git 不可用须保留证据降级 | 真实 temp Git 项目，修改中断/成功/失败；`project-verification.js:524` |
| task completion：部分实现 | 给父 Agent 明确的完成消费入口 | 需人工读单元状态 | 沿用已有收据，只加消费时身份比较 | 当前不能防 F01 的旧通过 | 先真通过、改坏、再 complete，必须拒绝 |
| 深度异步队列：部分实现 | 延迟获取高成本证据 | 仍可显式同步 deep；普通任务不受影响 | 暂不承诺后台，只保留显式运行及当前指纹结果 | queued/running 可读；终态新鲜度未闭环 | 旧输入/过期/命令变化/通过后变化；`verification-queue.js:48` |
| Micro：部分实现 | 快速观察已声明局部不变量 | 可用既有 unit/probe，主完成合同不损失 | 合并两套执行/判定，减少独立状态转换 | 受管 runtime 源入口实际成功；源 CLI 的 F05 误阻断 | 同 fixture 双公开入口一致性；不靠 schema 构造 passed |
| 冻结测试与红灯证据：部分实现 | 防止为通过而改掉验收资产 | 需依赖 diff review/受保护 CI | 保留明确写入保护，别再包装通用 shell 沙箱 | 显式路径写入可检查；真实宿主加载无法确认 | 红灯拒绝 lint/依赖/空测试；明确路径 Hook 负控；`run.mjs:3136`、`frozen-test-writes.mjs:268` |
| Review 收据：部分实现 | 区分实施、评审和当前 diff | 高风险只剩人工判断 | 一个 reviewer 集合、实际收据引用，减少自报标签 | 当前 F02；宿主身份真实性无法从 JSON 保证 | 实施者混入、重复 context、旧 diff、缺真实验证的负控 |
| receipt/handoff：已实现（形状与账本合同），真实最终验证无法确认 | 规范执行身份、终态和交接声明 | 恢复时难分前后执行 | 保留协议，不将形状校验升级成真实性证明 | 生成/校验可执行；`reviewed/passed` 仍是传入声明 | `receipt-records.js:300` 只校验组合条件，需由消费方核对实际 verification |
| CI merge 聚合：部分实现 | 将必要 job 汇总成唯一稳定 required 名称 | 分散 required 设置更易漂移 | 复用现有聚合，单一必需清单 | current security 失败丢失，见 F03 | 每个必需 job 单独 failure/cancelled/skipped 负控 |
| Offline Eval/reference：已实现（确定性契约入口）；在线能力无法确认 | 发现规则资产漂移，保留可比较基线 | 无法稳定定位资产回退 | 确定性断言＋少量关键在线场景 | offline 不是模型能力证据；未运行本轮在线模型 | reference 差异、真实坏样本；不引用历史 run 证明当前行为 |
| Harness scenario verifier：部分实现 | 核对真实产物与关键执行行为 | 只看自然语言会放大假完成 | 每机制一个最小必要负控，移除宽松通用回退 | outcome 能执行；H16 协作评分失真 | H16 无派发/逆序派发必须失败或 unverified，见 F04 |

## 本轮验证清单

所有临时 fixture 均在 finally 清理；未改生产源码、配置、依赖、Eval reference 或测试资产。本节记录行为取证，不把探索用 stdin 实验注册成正式 Micro receipt，也不声称全项目验收通过。

| 命令/实验 | 结果 | 证明范围 |
|---|---|---|
| `node .agents/runtime/commands/run.mjs codebase-memory status --project . --json` | unavailable / runtime-not-installed | 只证明本机当前能力缺口 |
| `node --input-type=module -`，临时 Git 项目：真实 verify→record→修改行为→complete；随后比较源/受管 Micro | 完成假阳性；Micro 源 blocked/runtime passed；进程退出 1 来自源 Micro 的 blocked | F01/F05 的当前行为，步骤与关键输出见 finding |
| `node --input-type=module -`，schema+review evaluator、merge gate env、queue 状态机 | 断言全部成立，退出 0 | F02、F03 聚合器及 F01 队列终态 |
| `node --input-type=module -`，仓库 H16 fixture manager + scenario verifier，两个坏轨迹 | 两者整体 passed，实验退出 0 | F04 确定性评分误放行，不是在线模型结果 |
| `node --test tests/unit/verification-queue.test.js tests/component/micro-receipt.test.js` | 4 passed，退出 0 | 现有状态/过期与 schema 用例通过，未覆盖本次缺口 |
| `node --test --test-name-pattern='task check --complete\|clear-blockers\|验证收据携带任务' tests/integration/project-task-command.test.js` | 4 passed，退出 0 | 现有 blocker、无收据、清阻塞及跨任务关联检查 |
| `node --test --test-name-pattern='negative controls\|requires H01\|requires fresh H13\|structured H14' tests/component/harness-evals-scenarios.test.js` | 4 passed，退出 0 | 已有 verifier 负控，未覆盖 H16 两个反例 |

上述 12 个现有用例通过与本次反例并不矛盾：说明被测试的合同切面不完整，而非需要再跑一轮全量就会自动发现。测试数量不作为可靠性结论。

## 保留、减法与未确认边界

- **保留**真实命令结果、工作树快照、隐藏 outcome 检查、明确失败降级和少量行为负控；它们直接减少假完成。
- **优先减法**：合并 Micro 的最终判定；减少 reviewer 双真值；删除 H16 过宽 fallback；不新增角色、scheduler、审批链或新的证据 schema。
- **不误报**：独立 Review/人工审批的 shadow 是显式 rollout 决策（`CONTRIBUTING.md:133`、`docs/github-delivery.md:36`），不是实现意外；本报告未建议无证据直接启用 required。
- **无法确认，不计问题**：远端 ruleset、真实 CI 执行记录、宿主 Hook 是否加载、真实独立上下文证明、在线模型可靠性、长时间并发与跨平台行为。冻结保护对未暴露工具和不透明 shell 的范围有源码说明（`runtime/hooks/lib/frozen-test-writes.mjs:293`），不能将它宣传为恶意代码沙箱。
- **未扩域**：不审验证成本选择、CI setup 矩阵成本、Anchor 存储原子性、worktree 事务或调度 ready 语义；F01 只涉及显式完成/收据消费的可信性。
- **交付边界**：本报告完成的是验证域审查与本轮反例取证；没有产品修复、发布验收、提交、推送或外部写入。
