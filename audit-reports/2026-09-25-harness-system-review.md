# Harness 第一性原理系统审查

## 1. 核心结论

**当前尚不能以最低必要成本，稳定覆盖从简单修改到大型、长期、多 Agent 开发的全部范围。** 简单任务已有明确的轻量默认路径，但失败补偿能删除既有工作、恢复能覆盖后续成功写入，显式完成检查还能接受已经失效的验证结果（F01、F02、F04）。最关键的结构性问题不是“规则不足”，而是**关键消费入口没有统一兑现资源归属、证据有效性和状态转换条件**：例如 `runtime/commands/run.mjs:1802` 无条件执行 `worktree remove --force`，`:3496` 的完成判断只看 `unit.verification?.status !== 'passed'`，没有重新核对当前指纹。应先删除错误补偿、收敛已有判定并补入口负控，而不是增加角色、调度器、规则或状态文件。真实长期成功率、Token 账单及宿主强制隔离仍**无法确认**，本报告不宣称整体安全或发布就绪。

## 2. 现状概览

规则、Skill、角色和模板经安装器投影到项目/宿主；CLI与运行时提供任务、Worktree和验证，Hook限制可观察调用，CI聚合检查。默认单Agent直行，复杂任务按需升级。可执行实例：`scripts/task-dag.js:84` 调用 `validateTaskDag(await readDag(options))`；宿主边界见 `scripts/lib/runtime-diagnostics.js:32`：`Project files cannot prove that the host loaded or trusted`。

### 审查口径与范围

- 基线 HEAD：`98a9d52585e8cfe4692e8f81810b075cd8643dc6`；日期为本地 2026-09-25，部分命令输出为 UTC 2026-09-26。
- Phase 0 枚举 **866 个源/投影/测试/文档文件**，另列 **1229 个本地、忽略及生成文件的元数据**；不展开第三方依赖和 Git 对象，不读取真实 Memory 正文。逐文件清单中的“无法确认”不是“缺失”。
- 六域独立审查共提出21条候选；受宿主三个子 Agent 并发槽位限制，分两波执行，彼此不读取输出。初始摘要不足以充当完整基线，已暂停并在 v2 清单完成后重新正式审查；另有三次模型渠道启动失败，不计作审查。
- 独立对抗轮逐项核原文：**保留17、降级3、驳回1**；合并 W1/W2 的整改簇后，正文为 **19条：P0 5、P1 6、P2 8**。合并保留两个不同的派发验收谓词。
- “已实现”只用于源码/配置能证明的具体机制；本轮临时 fixture 是缺陷诊断观察，不是注册 Micro、修复验收或生产事故证据。后文“部分实现”表示机制存在而合同有缺口。

## 3. 问题清单

### P0：数据风险或显式终态误放行

#### F01 · 失败重试会删除复用 Worktree 中的既有工作

**问题 →** 同一任务复用已有 Worktree 后 setup 失败，补偿仍强制删除它及可能存在的既有分支。

**证据 →** `runtime/commands/run.mjs:1722` 仅在 `if (!existing)` 时创建；`:1802` 的失败路径却执行 `await runGit(['worktree', 'remove', '--force', plan.worktreePath], projectDir);`。两轮独立隔离观察均为 `treeStillExists:false`、`userFileStillExists:false`、`branchDeleted:true`。

**实现状态 →** 部分实现。**根因 →** 新建与复用共用补偿，未保存本次创建归属。**影响 →** 可重试的环境失败变成未提交工作丢失；不是所有 bootstrap 都会触发。

**改进方案 →** 只补偿本次创建的资源；复用失败保留既有树与分支。**优先级 → P0。** 回归必须组合“已有树＋未提交文件＋setup失败”，而非只测正常复用和新建失败。

#### F02 · 恢复旧事务会撤销后来已经成功的写入

**问题 →** 自动破陈旧锁后允许新事务成功，旧 active journal 仍可在稍后 recover 时覆盖新内容。

**证据 →** `scripts/lib/file-transaction.js:178` 删除旧锁；`:290` 仍筛选 `['active', 'recovery-failed']` 日志；`:92` 恢复时执行 `await rm(targetPath, { force: true, recursive: true });`。两轮独立观察：`afterCommit:"new-success"`，恢复后 `afterRecovery:"original"`。

**实现状态 →** 部分实现。**根因 →** 只修复锁可用性，没有先处理未完成 journal 的顺序与归属。**影响 →** 正常恢复可能静默撤销更晚成功状态；实证限于事务原语，不泛称全部安装流程已损坏。

**改进方案 →** 删除“仅破锁就继续新写入”的路径；先处理旧事务，恢复前核对目标仍属于该失败状态。**优先级 → P0。** 用“中断→新事务→恢复”顺序测试确保新成功内容不被覆盖。

#### F03 · Worktree 环境文件可越界写入

**问题 →** `ports.envFile` 接受 `../outside.env`，随后在自身 Worktree 外写文件。

**证据 →** `runtime/commands/run.mjs:1107` 只检查 `path.isAbsolute(raw.ports.envFile)`；`:1755` 使用 `path.join(plan.worktreePath, assignment.envFile)`，`:1757` 直接 `writeFileSync`。两轮隔离观察均为 `status:"passed"`、`targetOutsideWorktree:true`。

**实现状态 →** 部分实现。**根因 →** 把相对路径语法检查当作实际写入范围检查。**影响 →** 错误配置可覆盖兄弟目录文件；不假定配置由攻击者控制，也不声称突破 OS 沙箱。

**改进方案 →** 复用 canonical containment 原语，在最终写入前检查目标及符号链接归属；读源、写目标分别绑定正确根目录。**优先级 → P0。** 回归覆盖父目录逃逸、合法子路径和链接逃逸。

#### F04 · 行为已经改坏，显式完成检查仍通过

**问题 →** 单元保存真实 passed 收据后再修改被测行为，`task check --complete` 仍通过；队列的已通过结果也不能正常转 stale。

**证据 →** `runtime/commands/run.mjs:3496` 只筛选 `unit.status === 'done' && unit.verification?.status !== 'passed'`；`scripts/verification-queue.js:52` 对 passed 状态给出的后续允许集合为 `[]`。独立负控：真实验证先通过，改坏后相同检查退出1，而完成命令仍 `passed / exit 0`。

**实现状态 →** 部分实现。**根因 →** 消费者把 passed 当持久布尔值，而非某输入状态、命令和环境下的结论。**影响 →** 父 Agent、恢复会话或显式终态消费者可收到假绿；不等于其他合并/发布入口也已证明可绕过。

**改进方案 →** 复用已有当前指纹及命令身份检查；缺失、变化不得完成。队列消费前核对身份，终态查询允许派生 stale。**优先级 → P0。** 保留“真通过→改坏→拒绝完成”与“passed→新身份→stale”两个负控。

#### F05 · 安全扫描失败没有传播到仓库声明的唯一 required gate

**问题 →** dependency-review/gitleaks job 存在，但 `merge-gate` 不消费 security 的结果。

**证据 →** `.github/workflows/ci.yml:299`：`needs: [change-plan, product, supply-chain, risk-evidence, branch-policy, independent-review, high-risk-approval]`，没有 security；`scripts/merge-gate.js:9` 的名称表同样遗漏它。`docs/github-delivery.md:20` 声明“required status check 只选择 merge-gate”。两轮负控均在 `SECURITY_RESULT=failure` 时得到 `gateExit:0 / gateOk:true`。

**实现状态 →** 部分实现。**根因 →** 检查 job 与聚合器的手写名单没有闭合失败传播边。**影响 →** **若按仓库文档只要求该 gate**，安全扫描失败不能阻断合并；远端是否另有 required check、是否发生实际合并均无法确认。

**改进方案 →** 将现有 security 接入 needs、env 和聚合器，不新增扫描器。**优先级 → P0（上述条件下）。** 每个必需 job 分别注入 failure/cancelled，确认聚合拒绝。

### P1：显著可靠性缺口

#### F06 · “可派发”只检查了部分必要条件

**问题 →** 安装运行时既将未验证的 done 前驱视为可消费，也不核对并发写入范围/资源互斥；不能把这个通过解释为全面 ready。

**证据 →** `runtime/commands/run.mjs:2870`：`else if (status !== 'done') unfinished.push({ id, status });`；`:3456`：`const unmet = [...stopped, ...predecessors.unfinished];`。其 `planUnitGraph`（`:2837`）只恢复 id/dependsOn；另一入口 `scripts/lib/task-dag.js:267` 已能报告 `TASK_DAG_SCOPE_CONFLICT` 和 `TASK_DAG_RESOURCE_LOCK_CONFLICT`。

**实现状态 →** 部分实现；静态结论。**根因 →** 同一派发概念分散在进度、依赖与冲突校验中，输出未说明缺少哪些条件。**影响 →** 自动消费者可过早启动依赖节点或冲突写入，人工则需补齐多入口差集；未证明已发生真实覆盖事故。

**改进方案 →** 先缩窄输出为实际检查范围；需要全面 ready 的入口复用“当前有效前驱证据＋现有互斥检查”。不把完整多 Agent DAG 强加给单 Agent Anchor，不新增第二份任务文件。**优先级 → P1。** 分别测试未验证 done、过期 passed、重叠 scope/同锁及独立节点。

#### F07 · Hook 启动包装丢失宿主权限预设

**问题 →** 直接 runtime 能识别的只读 preset，在实际 bootstrap 链路中被环境清洗删除。

**证据 →** `scripts/lib/hook-bootstrap.cjs:1` 的 `inherited` 白名单含 `VIBE_HARNESS_EXECUTION_ENVELOPE`，不含 `VIBE_HARNESS_PERMISSION_PRESET`；`runtime/hooks/codex-hook.mjs:139` 却消费后者，`:147` 为 `hostPreset ?? settings.permissionPreset ?? null`。独立观察：同一 Write 事件直接入口 deny，包装入口返回 `{}`，未执行实际写工具。

**实现状态 →** 部分实现。**根因 →** 包装层的必要控制变量合同与消费者分开维护。**影响 →** 依赖该注入变量的角色限制在此链路失效；不证明真实宿主已注入该变量或其只读 sandbox 被绕过。

**改进方案 →** 在现有白名单保留该控制变量，继续剔除 secret；增加直接/包装入口同输入一致性用例。**优先级 → P1。**

#### F08 · 双独立评审集合允许实施者混入

**问题 →** 顶层 reviewer 合法时，`reviewers=[implementer, reviewer]` 仍可获 `REVIEW_APPROVED`。

**证据 →** `scripts/lib/review-audit.js:97` 只比较顶层 reviewer 与 implementer；`:104` 只检查 `new Set(identities).size !== identities.length`，没有排除数组中的实施者；`:119` 可输出 `REVIEW_APPROVED`。本轮 schema/evaluator 负控得到 `healthy`。

**实现状态 →** 部分实现。**根因 →** reviewer/reviewers 两份真值，集合内部互异被误作相对实施者独立。**影响 →** 批准信号和 shadow 统计失真；`CONTRIBUTING.md:133` 明确当前 shadow，不能说已绕过强制评审门。

**改进方案 →** reviewer 列表为单一真值，逐个排除实施者 identity/context，兼容顶层字段从列表校验或派生；没有可信宿主证明不自报完整独立性。**优先级 → P1。**

#### F09 · 协作 Eval 能把无协作或逆序派发判为成功

**问题 →** H16 没有真正验证 producer 完成早于 consumer 派发。

**证据 →** `harness-evals/scenarios/H16-multi-agent-dependency.json:34` 要求 `decoder dispatch follows schema completion`；`harness-evals/verifiers/scenario.js:163` 只检查 `has('agent-dispatch')` 等事件是否存在，`:193` 的缺专用证据拒绝清单遗漏 H16。真实 H16 fixture 的“无 subagent 轨迹”和“先派 decoder”轨迹均全部 passed。

**实现状态 →** 部分实现。**根因 →** 通用成功回退替代机制专用断言。**影响 →** 该分数不能证明多 Agent 依赖编排可靠；不推断其余19个场景均失效。

**改进方案 →** 删除 H16 通用通过回退；缺专用事实降级，按对应单元/Agent 检查事件顺序。**优先级 → P1。** 将两个坏轨迹加入已有 verifier 测试，不新增协作引擎。

#### F10 · 计划漂移时，连“为何不能继续”也无法保存

**问题 →** checkpoint 的 failure/blocker/nextAction 更新被计划一致性门一起拒绝。

**证据 →** `runtime/commands/run.mjs:3618` 检查 `planCheck.status !== 'passed'` 后提前返回失败，早于 `:3666` 的 blocker、`:3684` 的 failure、`:3691` 的 nextAction。隔离观察返回 `VIBE_HARNESS_PLAN_DRIFT`，三个恢复字段均未保存。

**实现状态 →** 部分实现。**根因 →** 执行授权前置门被用于所有恢复事实记录。**影响 →** 异常与压缩前最需要保存新事实时反而失去 checkpoint。

**改进方案 →** 纯恢复事实允许保存并标明漂移；推进实施状态的请求仍受原门约束，混合请求不能顺带放行。**优先级 → P1。** 测试“记录成功、推进仍拒绝”，不新增紧急日志。

#### F11 · 残缺或未知版本 Anchor 被呈现为 ready

**问题 →** 合法 JSON 不等于可恢复的任务状态，但读取入口没有验证最小内容合同。

**证据 →** `runtime/commands/run.mjs:2997` 只要求 `Number.isInteger(anchor.schemaVersion)`；`:2588` 的支持版本为2；`:3801` 固定 `status: 'ready'`。仅有 taskId/version 的 v2 或 v999 fixture 均得到 `ready`、`goal:null`、`stage:null`。

**实现状态 →** 部分实现。**根因 →** 解析成功替代语义有效，缺字段被默认空值吞掉。**影响 →** 恢复者不能区分“确实没有阻塞”与“阻塞记录丢失”；ready 是读取状态，本条不把它当完成放行。

**改进方案 →** 在现有 reader 统一检查支持版本和最小恢复字段，残缺输入拒绝或明确报缺口。**优先级 → P1。** 合法兼容样例与缺字段、未知版本负控并存。

### P2：有条件优化与局部误导

以下仍按同一发现格式压缩呈现，不把成本算术当作实际节省。

#### F12 · 跨层升级重复执行低层命令

**问题 →** 同状态依次 quick/standard/deep 会重跑累计集合。**证据 →** `scripts/lib/validation-tiers.js:309`：`VALIDATION_TIERS.slice(0, index + 1)`；`scripts/lib/project-verification.js:469` 遍历全部 `focused.commands`。按当前配置，集合算术为17次执行、9条唯一命令。

**实现状态 →** 累计执行已实现（源级）。**根因 →** 没有跨层单检查差集复用。**影响 →** 存在潜在重复成本，实际时长/Token收益未知；`docs/rules/test-rules.md:60` 明确命令集合变化重新执行，**不是已证实的规则违约**。**改进方案 →** 先尽量一次选对所需层并测量；重复成本确实显著后，才扩展现有收据的单检查复用与失效验证。**优先级 → P2。**

#### F13 · 源 Micro 成功被两层判定错误降为 blocked

**问题 →** 源结构化入口与运行时入口对同一正常 probe 结论不同。**证据 →** `scripts/micro-verify.js:105` 只传 `snapshotBefore`；`scripts/lib/micro-runner.js:88` 在缺 after 时将 passed 降 blocked；外层取得 after 后只补 match。观察为退出码0、快照match但blocked，运行时源入口则passed。

**实现状态 →** 部分实现。**根因 →** 快照和最终结论有两个所有者。**影响 →** 误阻断、重试或无必要升级。**改进方案 →** 保留一个最终判定位置，复用共同 runner；补双公开入口一致性测试。**优先级 → P2。**

#### F14 · 角色权限诊断没有说明粗粒度映射

**问题 →** 可执行验证角色映射到可写 sandbox，却统一称 `native`。**证据 →** `scripts/lib/role-projection.js:434`：`sandbox_mode: isExecutablePreset(role.permissionPreset) ? 'workspace-write' : 'read-only'`；`:603` 据 adapter 直接标 native；同时 `manifests/adapters.json:17` 已注明 `"status": "configured-unverified"`。

**实现状态 →** 部分实现。**根因 →** 原生字段支持与精确角色限制混用一个标签。**影响 →** 诊断容易被过读，但验证需要可写 sandbox 是合理折中，没有证明越权。**改进方案 →** 明示“原生 sandbox、角色限制粗粒度/待验证”，保留宿主不确定性；不宣称与 F07 已形成实际攻击链。**优先级 → P2。**

#### F15 · 端口登记要求缺少明确适用条件

**问题 →** 普通协作写入也可能按文义被要求检查端口登记。**证据 →** `docs/rules/ai-collab-rules.md:79` 写“派发 write 前”及“登记表缺失、锁不可用或声明冲突时 fail-closed”，但同句又限定“节点声明的端口块与容器”。

**实现状态 →** 仅规范定义。**根因 →** 专项资源约束没有明确 not_applicable 条件。**影响 →** 可能诱发无关检查，未证明发生过实际阻塞。**改进方案 →** 仅对实际声明/使用端口或容器的节点触发，不创建空登记表。**优先级 → P2。**

#### F16 · focused 的空差异提示与执行相反

**问题 →** 先执行基线，再说不需要验证。**证据 →** `scripts/lib/verification-plan.js:420` 添加“无变更时的项目基线”；`scripts/verify-focused.js:156` 先执行，`:187` 后输出 `No changed paths detected; no focused verification needed.`。

**实现状态 →** 行为已实现（静态结论）。**根因 →** 通用基线语义与 focused 提示分叉。**影响 →** 用户误判本次检查范围与成本。**改进方案 →** 最小修复先准确提示“执行基线”；只有明确选择空差异不验证语义时才前置短路，不能直接删除合法基线。**优先级 → P2。**

#### F17 · update 静默忽略它接受的初始化字段

**问题 →** `--goal/--title/--risk-level/--acceptance` 被解析后不更新，也不报不支持。**证据 →** `runtime/commands/run.mjs:124` 的公共 valueFlags 接受这些字段；更新函数不消费，`:3736` 仍返回 `status: args.write ? 'passed' : 'planned'`。fixture 得到 `passed / changed:false / goal:"Old goal"`。

**实现状态 →** 部分实现。**根因 →** 公共解析器未收紧子命令合同。**影响 →** 恢复事实可停留在旧值。**改进方案 →** 先明确拒绝 init-only 参数；只有产品需要可变目标时才实现真正更新。**优先级 → P2。**

#### F18 · Memory 的 healthy 超出了实际扫描范围

**问题 →** sessions 被跳过，同文件多条目仅取首个日期。**证据 →** `scripts/lib/memory-audit.js:67` 跳过非普通文件；`:91` 用 `fields.find`；`:120` 返回状态与 filesChecked，没有未覆盖目录说明。synthetic session 中坏日期/坏引用仍healthy；新旧条目调换顺序后结果改变。

**实现状态 →** 部分实现。**根因 →** 一个根层文件/首个日期被近似为恢复记录单位。**影响 →** 机械审计覆盖易被高估；没有读取或评价真实 Memory 内容。**改进方案 →** 先明确扫描范围与未覆盖项；若继续承诺整库审计，再补 sessions 遍历和条目级日期，不引入语义审计 Agent。**优先级 → P2。**

#### F19 · API 规则将默认中文误写成无条件要求

**问题 →** 非中文项目无法同时满足同一文件的两条要求。**证据 →** `docs/rules/api-rules.md:17` 要求“使用项目配置 `language` 声明的语言”；`:30` 又要求“用户可见提示断言中文文案”。

**实现状态 →** 仅规范定义。**根因 →** 默认值被硬编码为通用验收条件。**影响 →** 可能编写错误的文案断言，实际事故未知。**改进方案 →** 删除固定“中文”，引用项目语言/i18n合同即可。**优先级 → P2。**

## 4. 可删除／可简化清单

| 优先做减法 | 删除/简化后的影响 | 必要补偿 |
|---|---|---|
| 删除对复用资产的无条件补偿；删除只破陈旧锁就开始新事务 | 不再“失败即清干净”，但保住用户已有状态 | 标明本次创建归属；先处理旧 journal，失败状态可恢复 |
| 删除过宽的“全面可派发/已完成”声明，复用局部证据与互斥原语 | 输出更窄，不能再靠一个标签概括所有条件 | 只在请求派发/完成时检查当前所需条件；短任务不建第二份 DAG |
| 删除 H16 通用通过回退、减少 reviewer 双真值 | 证据不足时不再产生漂亮分数或批准 | 缺证据明确降级；已有专用事件/身份关系必须真正核验 |
| 合并 Micro 的最终状态所有权 | 不再有源/安装入口相反结论 | 复用成功、变更、超时、溢出负控 |
| 缩窄端口要求、Memory健康声明、角色native标签及固定中文条款 | 不再承诺未使用资源或未验证能力 | 使用 not_applicable/范围说明及项目语言契约，不另写一套规则 |
| 保留高风险整层回退；暂不实施 COST-02 的缩减建议 | 保留当前必要保守成本 | `docs/rules/test-rules.md:124` 明确 covers 为相对 import 可达的“下界”；无闭包证据，不缩小 |

不建议删除 Worktree、事务、状态锚点、真实验证、渐进读取或轻量角色合同本身；各机制的“删除后果/替代/执行稳定性/机械验证”五问分别保存在六域附录，跨域五问由对抗报告补齐。

## 5. 建议新增能力

**不建议新增独立角色、常驻调度器、第二套 Memory/任务状态、更多默认门禁或新验证层。** 本次正式问题主要可以通过收紧/复用现有实现解决。

唯一应增补的是**现有公开入口的组合负控覆盖**，不是新系统：

| 触发条件 | 预期收益 | 实现成本 | 为什么不能只做更简单的删除 |
|---|---|---|---|
| 修复或改变失败补偿、收据消费、Hook包装、CI聚合、协作 verifier | 防止“各内部函数通过、拼接后却丢数据或假绿”；以 F01/F04/F07/F09 的反例为最小集合 | 低至中：扩展已有 fixture 和定向测试；不引入服务/新框架，只在相关改动时运行 | 删除危险分支是修复，但不能证明另一入口不再绕过；本轮25项既有定向测试均通过，反例仍存在，因此至少需要对应公开入口坏路径断言 |

跨层差集缓存（F12）**不列必做新增**：触发应是实际记录证明同状态反复升级的重复成本显著；收益是减少有效检查的重复执行，成本是中等的单检查身份/环境失效与测试维护。尚不能证明它优于一次选对层级等更简单办法，因此先测量，不预先建设缓存服务。

## 6. 优化后的目标工作流（一页纸）

```text
收到任务
  └─ 读 Fast Path、相关事实和 Git 状态；确认实际授权与交付边界
      ├─ 解释/文案/微小非行为改动
      │   └─ 单 Agent 直接处理 → 静态核对或最小必要检查 → 简洁交付
      ├─ 可逆本地行为改动
      │   └─ 定位相关实现 → 最小修改 → 受影响检查 → 按当前证据交付
      └─ 真正跨阶段/多写者/高风险
          ├─ 长任务才建一个 Anchor；按实际依赖决定是否需要计划/并行
          ├─ 独立并行确有收益才派子 Agent；冲突才隔离 Worktree
          ├─ 派发：授权有效 + 前驱证据当前有效 + 实际写范围/资源不冲突
          ├─ 执行：补偿只处理本次资源；旧事务先恢复；写前核对实际路径
          ├─ 异常：可保存 failure/blocker/nextAction；这不授权继续执行
          └─ fan-in：父 Agent 看实际 diff，运行匹配当前交付主张的检查

验证消费
  ├─ 只承认当前输入/命令/环境下有效的证据；不是永久 passed 标签
  ├─ scope 下界/未知 → 扩大；不为省成本删除高风险必要覆盖
  ├─ 相同有效证据才复用；命令/状态变化重新判定
  └─ 本地、集成、合并、发布分别收口；未取证层不宣称完成

停止
  └─ 必需验收满足即交付；没有自动新增 Review、角色、文档或发布阶段
```

这保留 `docs/rules/governance-core.md:7` 的“必要事实 → 最小计划 → 直接实施 → 局部快速验证 → 简洁交付”，以及 `:34` 的“超过60分钟或第一次压缩才建锚点”；改变的是消费者的执行正确性，不是扩大默认流程。

## 7. 整改路线图

| 顺序 | 整改项 | 验证方式 / 退出条件 |
|---|---|---|
| P0-1 | F01/F02：资源归属与恢复顺序 | 临时仓库复现原反例后应保留既有脏文件/分支、不得覆盖后续成功状态；保留新建失败正常回滚用例 |
| P0-2 | F03：最终路径范围 | `../` 与链接逃逸拒绝；合法子路径可写；拒绝不得产生边界外副作用 |
| P0-3 | F04：当前证据消费 | 真通过后改坏，显式完成拒绝；队列身份变化不再保持可消费passed；正常同状态不重复验证 |
| P0-4 | F05：现有安全失败传播 | security单独failure使聚合非零；其他必要job同测；远端启用情况另行核验，不能用本地脚本代替 |
| P1-1 | F06：派发结论与实际条件一致 | 未验证/过期前驱不放行，冲突写入不全面ready，独立节点继续；不要求短任务新增DAG |
| P1-2 | F07/F08/F09：权限与证明链 | 直接/包装Hook一致；reviewer集合拒绝实施者；H16无协作/逆序不通过；shadow不偷换成required |
| P1-3 | F10/F11：可靠恢复入口 | 漂移时纯记录能保存、推进仍拒绝；残缺/未知版本不无提示ready；合法旧版本兼容有测试 |
| P2-1 | F13/F16/F17：收敛入口语义 | Micro双入口一致；空差异提示准确；不支持参数明确拒绝或真正执行 |
| P2-2 | F14/F15/F18/F19：缩窄文字与诊断 | 权限映射显式降级；不用端口不查表；Memory显示扫描范围；非中文配置无矛盾断言 |
| P2-3 | F12：测量后再优化重复检查 | 先记录真实重复命令/时长；确有净收益再实现差集；任何输入/环境变化必须失效，不降低必要验收 |

每项只先跑对应反例与受影响现有用例；合并共享判定或影响安装运行时后，再按真实变更选择集成检查。P0未修复前，不应仅凭当前 healthy/passed/ready 标签或既有测试通过宣称长期多 Agent 开发可靠。

## 附录：证据、裁定与边界

### 产物索引

- 事实基线：`2026-09-25-facts-baseline.md`
- 逐文件源资产：`2026-09-25-file-inventory.md`
- 本地/忽略资产元数据：`2026-09-25-local-inventory.md`
- 六域原始发现与关键机制五问：`2026-09-25-phase1-structure.md`、`2026-09-25-phase1-workflow.md`、`2026-09-25-phase1-cost.md`、`2026-09-25-phase1-reliability.md`、`2026-09-25-phase1-verification.md`、`2026-09-25-phase1-context.md`
- 21条逐项裁定、原文复核与独立负控：`2026-09-25-phase2-adversarial.md`

### 本轮证据强度

- 已有聚焦测试：可靠性5项、上下文8项、验证12项，共25项通过；另角色结构审计0错误0告警。**它们不覆盖全部发现，不能反证反例。**
- 对抗轮独立重跑：既有Worktree被删、旧事务覆盖新状态、环境文件越界、Hook preset丢失、旧收据假完成、安全失败未传播；结果与首轮一致，真实用户资产未被用于实验。
- 机械核验：866个Git跟踪文件无清单漏项/磁盘缺失；849个非Memory源文件指纹无漂移；六域141个路径/起始行引用存在且不越界。原文语义另由对抗轮核对。
- 交付校验：`pnpm docs:audit` 通过（134份受管文档）；11份本轮报告的空白检查通过，全部228个受检路径/起始行引用有效；总报告含7个要求章节、19条问题，现状概览273字符；产品跟踪文件diff为空。
- 未运行整仓矩阵、线上模型Eval、真实宿主压缩/长时并发或远端CI/ruleset验证；没有修复后验收、生产事故、实际Token节省或整体通过主张。
- 本次仅产出审查文档及本地任务锚点，未修改产品源文件、配置、依赖、规则、测试或Eval reference，未在项目提交/推送。

### 已驳回与不升级的次要线索

- COST-02：**驳回**“高风险整层验证必然浪费”；当前 covers 是下界，不能证明安全收窄。
- 文档双平台CI成本、规则/角色数量本身过多：缺少净收益或实际读取轨迹，不计正式问题。
- 缺自建scheduler、可选MCP未安装、Review采用shadow：是边界或明确策略，不作缺陷。
- 顺序链DAG示例与工作流模板措辞有局部歧义、普通编码规则有重复句：可随对应文件维护顺手精简，不单建整改项目。

**追溯映射：** F01=R1；F02=R3；F03=R4；F04=VER-F01；F05=VER-F03；F06=W1/W2；F07=R2；F08=VER-F02；F09=VER-F04；F10=C2；F11=C4；F12=COST-01；F13=VER-F05；F14=STR-F01；F15=W3；F16=COST-03；F17=C1；F18=C3；F19=STR-F02。
