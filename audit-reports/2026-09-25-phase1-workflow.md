# Phase 1：工作流独立审查

## 结论与边界

现有 Harness 的简单任务路径并未设计成默认重流程，但尚不能从当前文件证明它能以最低必要成本稳定支撑长期多 Agent 开发。工作流域最关键的结构性限制是：同一“可派发”含义分散在自然语言 DAG、开发面 DAG 校验器和安装面 plan/task 校验器中，后者的 `passed` 未覆盖前者要求的验证与互斥条件。应收敛既有判定、缩窄成功声明，并删除无条件基础设施要求；不需要增加常驻调度器或更多规则。

- 输入：共同事实基线 v2、逐文件清单及工作流域所有权；未读取其他 Phase 1 输出。
- 基线：`98a9d52585e8cfe4692e8f81810b075cd8643dc6`。未修改产品文件。
- 方法：源码与测试内容静态交叉核对；本轮未运行测试或构造写入型复现。下述行为推论都是静态结论，测试文件只证明存在相关断言，不证明本轮通过。
- 仅审工作流与派发语义；收据真实性、存储一致性、Hook enforcement、Worktree 事务及 Memory 恢复由其他域负责。

## 正式发现

### W1 · P1：前驱仅标 `done` 即可解锁后继，未验证产物仍可进入依赖链

**问题 →** `task check --dispatch` 的前驱判定把 `done` 当作成功，不要求前驱已经通过验证；这不是收据真伪问题，而是派发谓词根本没有消费验证状态。

**证据 →**
- `docs/rules/ai-collab-rules.md:59`：“all_success 要求全部直接前驱 `succeeded`；unverified、failed、blocked、skipped、cancelled、Canceled、Duplicate 和 Won't Fix 都不算成功。”
- `templates/plan.md:27`：“每个增量必须在进入下一个依赖增量前完成验证。”
- `runtime/commands/run.mjs:2855`：`const statusOf = new Map(anchorUnits.map((unit) => [unit.id, typeof unit.status === 'string' ? unit.status : 'pending']));`
- `runtime/commands/run.mjs:2870`：`else if (status !== 'done') unfinished.push({ id, status });`
- `runtime/commands/run.mjs:3462`：`status: unmet.length > 0 ? 'failed' : 'passed',`
- 同文件 `:3496` 在完成检查中另外识别了 `unit.status === 'done' && unit.verification?.status !== 'passed'`，说明系统本身允许“done 但未验证”，但派发分支提前返回。
- `tests/integration/project-task-command.test.js:1004` 调用 `['task', 'update', 'chain', '--unit-status', 'A:done', '--write', '--json']`，`:1005` 随即检查 B 的 `--dispatch`，`:1006` 明确断言 `assert.equal(dispatchable.report.status, 'passed');`。这里没有先附 A 的验证结果。

**实现状态 →** 部分实现：未完成/失败/blocked 前驱会阻止派发；“done 与已验证成功”的转换条件未实现于派发分支。

**根因 →** 任务进度状态与依赖成功状态混用，完成检查和派发检查维护了不同的判据。

**影响 →** 按命令结果编排的父 Agent 可在前驱缺验证时派发消费者；问题会延迟到 fan-in 才暴露，增加返工并降低长链可靠性。未确认现有宿主实际执行过这种错误派发。

**改进方案 →** 复用已有完成检查中的最小验证条件作为前驱成功条件，显式区分“工作已写完”和“可供后继消费”；不要新建状态系统。测试保留 `A:done` 不足以放行、补齐有效验证后才放行，以及独立节点不受阻三种情形；收据新鲜度/真实性由现有验证域判据提供，不在此再造。

**优先级 →** P1。

### W2 · P1：两个图模型的派发语义分叉，安装面 `--dispatch` 不检查节点间写入互斥

**问题 →** `task-dag check` 有 writeScope/resourceLocks 冲突判定，但 `plan-units → task check --dispatch` 只保留依赖图；两个无依赖且写相同文件的单元可以各自得到派发通过。调用者需要手工理解并补齐两个入口的差集。

**证据 →**
- `docs/rules/ai-collab-rules.md:69`：“writeScope 重叠或 resourceLocks 相同的 write 节点只有存在传递依赖顺序时才可串行执行，否则冲突节点都不 ready”。
- `scripts/lib/task-dag.js:85`：`const sharedLocks = left.resourceLocks.filter((lock) => right.resourceLocks.includes(lock));`
- `scripts/lib/task-dag.js:267`：`conflicts.push({ code: hit.locks.length > 0 ? 'TASK_DAG_RESOURCE_LOCK_CONFLICT' : 'TASK_DAG_SCOPE_CONFLICT', detail, nodes: [first.id, second.id] });`
- `runtime/commands/run.mjs:2750` 的规范化对象仅含 `acceptance`、`dependsOn`、`files`、`id`、`protectedGrants`；`:2768` 的范围校验只把单元路径与整体 `allowedScope`/`protectedAssets` 比较。
- `runtime/commands/run.mjs:2942`：`dependencies: Object.fromEntries(units.units.map((unit) => [unit.id, unit.dependsOn])),`
- `runtime/commands/run.mjs:2837` 的 `planUnitGraph` 仅恢复 `{ dependsOn, id }`，没有文件或锁。
- `runtime/commands/run.mjs:3451` 将该分支描述为 “`--dispatch` is the pre-dispatch question: may this unit be handed out now?”；`:3456` 却只计算 `const unmet = [...stopped, ...predecessors.unfinished];`，`:3462` 据此产生 `passed`。
- `templates/plan.md:39`：“下面的机器可读执行块是交接与派发的契约”；而 `docs/rules/ai-collab-rules.md:35` 又称轻量 Task DAG “不由 Vibe-Harness 解析”。

**实现状态 →** 部分实现：开发面 DAG 校验器已实现冲突检测（源码级）；安装面派发检查没有同等判定，文档同时存在“人读 DAG”和“机读派发契约”两种承诺。

**根因 →** 同一调度概念使用两套字段和校验器，缺少一个共同的可派发谓词；不是缺少更多模型或规则。

**影响 →** 自动化消费者容易把依赖满足误读成全面 ready；人工消费者需要维护双份声明并重复核对。静态代码能够确认漏检，但实际并发覆盖事故无法确认。

**改进方案 →** 做减法：将既有 plan 单元映射到同一 DAG 校验内核，复用 scope/lock/依赖语义；不要要求用户再写第二份 DAG。若暂不合并，立即把安装面输出缩窄为“仅依赖检查”，明确未评估互斥而不是总括 `dispatch: true`。补同路径并行、同锁并行、显式串行与独立节点四类一致性测试。

**优先级 →** P1。

### W3 · P1：所有 write 节点都被要求依赖端口登记表，无网络服务的协作也可能被阻塞

**问题 →** 协作规则将端口/容器隔离的前置条件施加到每一次 write 派发，没有“节点需要端口或容器”的触发条件。

**证据 →**
- `docs/rules/ai-collab-rules.md:79`：“派发 write 前以登记表为端口/容器锁事实：读取主检出 `.vibe-harness/worktree-ports.json`（连同 `.vibe-harness/worktree-ports.lock`）确认节点声明的端口块与容器不与其它 running 节点重叠……登记表缺失、锁不可用或声明冲突时 fail-closed”。
- 同文件 `:49` 将 `resourceLocks` 定义为多类资源，其中包括 API、schema、manifest、版本、缓存、端口和容器，而不是要求每个节点都使用端口。
- `docs/rules/governance-core.md:9`：“高成本动作不默认执行”，明确列有 Worktree。
- `docs/rules/git-rules.md:18`：“仅在并发工作可能冲突、脏工作区与任务范围重叠、跨仓协作或明确需要独立构建与验证环境时使用独立 worktree”。

**实现状态 →** 仅规范定义（本问题是无条件前置要求）；未发现足以证明普通 write 派发必定被机器拦截的证据，不声称发生过运行时阻塞。

**根因 →** 将基础设施专项约束提升为协作通用不变量，缺少按实际资源使用触发的条件。

**影响 →** 严格遵守该条款的 Agent 即使只并行修改互不相交的文档或纯函数，也需要查找不相关登记表，并在缺失时停工或引入不必要环境。放宽执行则让规则遵守口径不稳定。

**改进方案 →** 删除无条件要求，限于节点实际声明端口/容器资源或需要运行相应服务时检查；没有使用该资源应明确 not_applicable，不生成空登记表。用两个路由场景验证：纯文件写入不触发端口检查；需要端口且登记缺失仍拒绝。

**优先级 →** P1（规范造成的不必要阻塞风险；若对抗轮要求运行事故证据，可降 P2，不应升级 P0）。

## 关键机制五问

| 机制与证据 | ① 解决什么 | ② 删除后果 | ③ 更简单替代 | ④ Agent 能否稳定执行 | ⑤ 能否自动验证 |
|---|---|---|---|---|---|
| Direct/Fast Path；`docs/rules/governance-core.md:7`“必要事实 → 最小计划 → 直接实施 → 局部快速验证 → 简洁交付” | 避免小改动被完整流程拖慢 | 失去统一低成本默认路径 | 保留卡片，删重复展开，不新增模式选择器 | 文义明确；稳定遵守率无法确认 | 可用简单任务路由 Eval，不可仅测规则文本存在 |
| 风险分级；同文件 `:66`“通常只需静态核对或无需命令验证，不编写用例，不触发测试套件”及 `:67-68` | 将验证成本与后果绑定 | 简单与高风险任务失去区别 | 三档足够；无需再叠加任务大小强制阶段 | 分类边界可读；遇公共契约等升级信号需实际判断 | 选择器自动化由成本域核对；本域不能确认分类正确率 |
| Plan；`templates/plan.md:39`“机器可读执行块是交接与派发的契约”；`runtime/commands/run.mjs:2947` `if (units.problems.length > 0)` | 多会话传递范围、顺序与验收 | 复杂交接丢失机器可检查的关系 | 单 Agent 短任务内联即可；复杂任务保留一个模型 | 当前存在 W2 的双模型歧义 | 范围、依赖和环已有源码校验；互斥应复用而非新增 |
| Goal；`skills/core/define-goal/SKILL.md:21`“只有用户明确要求激活且宿主暴露目标操作时才先检查当前目标并调用” | 保留大任务终点与宿主生命周期 | 容易把内部单元完成误作整体结束 | 使用宿主 Goal，不自建后台轮询或第二进度服务 | 授权边界明确；宿主真实续跑稳定性无法确认 | 可测试宿主调用合同；本仓库文本不能证明宿主持续执行 |
| 多 Agent DAG；`scripts/lib/task-dag.js:323` 按 trigger 比较成功/终态，`:267` 记录范围或锁冲突 | 安排依赖、减少并行冲突 | 复杂并发退回人工判断 | 无并行收益的顺序链不建 DAG | 规范有帮助但入口语义分叉，见 W1/W2 | 静态 DAG 检查已有实现；实际派发/宿主锁非该 CLI 能证明 |
| 按需隔离；`docs/rules/git-rules.md:18`“仅在并发工作可能冲突……时使用独立 worktree” | 保护改动、隔离有冲突的执行环境 | 并发写入及环境相互污染风险增大 | 干净单写者沿用现有工作区；无服务不用端口表 | 总原则可执行，W3 却增加无关前置条件 | 隔离实现由可靠性域核对；本域只评触发语义 |
| 父 Agent fan-in；`docs/rules/ai-collab-rules.md:81`“重新读取工作区状态和实际 diff……最后一次实质写入后运行集成验证” | 防止子节点局部通过被当成集成通过 | 组合错误容易漏报 | 父节点一次聚焦集成，不让每个子节点重跑全部验证 | 责任清楚；实际遵守率无法确认 | diff/验证可自动采集；人工采纳决定不能由 child 自报替代 |
| Review/交付分层；`docs/rules/ai-collab-rules.md:126`“结论是辅助证据而非完成门禁”；`docs/rules/git-rules.md:131`“本地实现可在最终验证后交付” | 区分可选复审与授权交付终点 | 可能过早宣称集成或默认要求无关发布 | 本地结果、集成、发布分开声明 | 原则清楚；专项强制 Review 路径交验证域核对 | 本域不确认 Review 真实拦截能力；不能由规范推断已执行 |

## 减法优先与后续验证

1. 合并 plan/task/DAG 的 ready 判定，不新增 scheduler、DAG 文件或父 Agent 手工核对清单；先修 W1，再收敛 W2。
2. 删除所有 write 都读取端口登记表的要求，按实际资源触发，修 W3。
3. 删除互相反向示范的顺序链 DAG 示例：`skills/core/task-decomposition/references/task-decomposition-guide.md:45` 说“固定顺序链……不建 DAG”，`:150` 却示范“拆为两个顺序节点……并行收益＝无关键路径缩短”。这是 P2 次要条目，不单列正式问题。
4. 缩窄 `templates/workflow.md:49` 的“在 worktree 中实施的交付先经……worktree land”到明确要求集成的交付；`docs/rules/git-rules.md:131` 已允许本地交付，顶部“推荐步骤，非门禁”不应依赖读者临场消解。P2 次要歧义。

## 无法确认，不计正式问题

- 无真实任务轨迹、成本采样或在线连续运行结果，不能给“稳定率”“额外 token 百分比”“已造成数据事故”等量化结论。
- 没有证据证明用户实际把 `task check --dispatch` 单独作为宿主派发门；W1/W2 是源码级缺口及其可推导后果，不是已发生事故。
- 仓库明确限制自身合同边界：`docs/rules/governance-core.md:108`“Vibe-Harness 只交付合同，不假定宿主有常驻状态服务或完整 Hook enforcement”。不能把“没有自建后台调度器”本身当缺陷。
- 本轮未验证 Linear 提供方自动化、宿主 fresh context 或 Goal bridge；不能把规范中的状态转换当作能力已经上线。
- 不根据规则文件多、模板长就推断每轮全部加载；未取执行轨迹，不计这类成本问题。
