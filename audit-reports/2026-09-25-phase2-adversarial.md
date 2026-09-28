# Phase 2：独立对抗复核

日期：2026-09-25；基线 HEAD：`98a9d52585e8cfe4692e8f81810b075cd8643dc6`。

## 结论与范围

**现有证据不能支持“已经以最低必要成本稳定覆盖简单到长期多 Agent 开发”的总体结论。** 主要阻碍不是规则、角色数量或缺少常驻调度器，而是失败补偿会损坏已有资产、显式终态消费者会接受失效证据，以及恢复与派发的局部合同没有接齐。另一方面，不能把合理的高风险保守验证直接判为浪费。

- 独立于 Phase 1；先读事实基线 v2，再读六份候选报告，只追候选原文及跨域交界，没有重做全量探索。
- 21 项逐一裁定：**保留 17、降级 3、驳回 1**；保留/降级项按用户口径为 **P0 5、P1 7、P2 8**。COST-01 降为优化候选，不计已证实的规则违反；W1/W2 建议一个整改簇、保留两个验收谓词。
- P0 用于已复现破坏性数据操作，或显式完成/required 聚合入口的错误放行；不是“生产事故已发生”的声明。中间步骤缺口、能力退化及恢复风险为 P1；诊断/文案边界与未量化优化为 P2。
- 产品、规则、配置、测试、真实 worktree、真实 Memory 正文均未修改或读取敏感正文；唯一持久写入是本报告。未联网、未安装、未派生 Agent。
- `codebase-memory status` 再次返回 `unavailable / runtime-not-installed`；使用现有 CodeGraph，未覆盖的精确片段补读源码。可选 MCP 未安装本身不是 finding。

## 逐条裁定

每项的一句话理由同时限定结论范围；证据键对应下一节的当前原文，不把 Phase 1 的判断直接当证据。

| 候选 | 裁定 / 优先级 | 一句话理由 | 证据 |
|---|---|---|---|
| STR-F01 | 降级 / P2 | 可执行验证需要可写 sandbox 是合理宿主折中，`native` 仅缺少精度说明且 adapter 已标 `configured-unverified`，不能把诊断歧义升级成已证明的角色越权。 | E01 |
| STR-F02 | 保留 / P2 | 同一规则既要求遵循项目 `language` 又固定断言中文，非中文项目确有文本冲突，但尚无实际改坏文案的证据。 | E02 |
| W1 | 保留 / P1 | `done` 与 `verification.status=passed` 已被实现明确区分，而派发仅看前者，不能用“只是任务进度”解释这个显式派发入口。 | E03 |
| W2 | 保留 / P1 | `--dispatch` 自称回答能否交出 write 单元，却没有节点范围/资源互斥信息，缺陷应限定为派发结论过宽而不是要求每个 Anchor 成为多 Agent 调度器。 | E04 |
| W3 | 降级 / P2 | 无条件“登记表缺失即 fail-closed”确有误触发空间，但上下文在讨论节点声明的端口/容器，证据只支持补明适用条件而非已发生运行阻塞。 | E05 |
| COST-01 | 降级 / P2 | 累计升级重复命令属实，但原规则要求同一命令集合才能复用、升级恰好改变集合，故保留差集执行的优化机会而撤销确定违反复用合同的解释。 | E06 |
| COST-02 | 驳回 / — | 静态 import 台账只能给出覆盖下界、不能证明高风险行为闭包，当前整层回退是有依据的保守设计，尚无证据证明收窄净收益大于漏验风险。 | E07 |
| COST-03 | 保留 / P2 | 空差异时实际先跑基线再提示无需验证的控制流矛盾成立，但最小修复可以是准确提示，不能据此无条件删除合法基线检查。 | E08 |
| R1 | 保留 / P0 | 独立重跑再次删除了复用 worktree 内未提交文件及既有分支，失败补偿缺资源创建归属直接构成数据风险。 | E09 |
| R2 | 保留 / P1 | 独立重跑确认 bootstrap 丢失宿主 preset 导致同一 Write 从拒绝变为空决策，但这不证明宿主只读 sandbox 被绕过或角色投影实际注入该变量。 | E10 |
| R3 | 保留 / P0 | 独立重跑再次让旧 journal 恢复覆盖后来成功提交的文件内容，破锁与恢复顺序失配是已证实的数据风险。 | E11 |
| R4 | 保留 / P0 | 独立重跑确认 `../outside.env` 在 worktree 外成功写入，且源码使用无条件 `writeFileSync`，即使配置来自可信用户也存在越界覆盖风险。 | E12 |
| VER-F01 | 保留 / P0 | 独立重跑“真验证通过→改坏→直接检查失败→显式完成仍通过”，证明失效证据能形成终态假绿，不能与只读 Anchor 状态查询混为一谈。 | E13 |
| VER-F02 | 保留 / P1 | v2 数组内部互异不等于相对实施者独立，现有比较确实漏检，但默认 shadow 限定了当前影响而不能宣称强制评审门已被绕过。 | E14 |
| VER-F03 | 保留 / P0 | 独立重跑 security=failure 仍使聚合器 exit 0，仓库声称唯一 required 的失败传播边确实断开，但远端其他 required checks 与实际合并行为未知。 | E15 |
| VER-F04 | 保留 / P1 | H16 要求 producer/consumer 顺序而实现只检查事件存在并容许通用成功回退，当前评分不能支撑该协作机制的可靠性结论。 | E16 |
| VER-F05 | 保留 / P2 | 源 Micro 内层因缺 after 快照先降 blocked、外层补齐后不恢复的链路成立，限于源结构化入口而非所有 Micro 能力。 | E17 |
| C1 | 保留 / P2 | update 的公共解析器接受初始化字段而分支不消费、仍返回 passed，缺陷是静默忽略，未必需要新增可变目标能力。 | E18 |
| C2 | 保留 / P1 | 计划漂移门在 failure/blocker/nextAction 落盘前返回，阻止记录为什么不能继续，不是保守执行检查所必需的副作用。 | E19 |
| C3 | 保留 / P2 | 扫描仅限根层且按首个日期判断的事实成立，但应先限定机械审计覆盖声明，不能要求它承担人工 Skill 的全部语义审计。 | E20 |
| C4 | 保留 / P1 | reader 接受未知整数版本和缺核心字段的 JSON，再以空值展示为 ready，恢复可信性确有缺口，但 ready 本身不是任务完成或派发通过。 | E21 |

## 原文核验账本

以下均在 Phase 2 经 CodeGraph 或精确行段读取核对；代码行号来自当前源码，规范只作为承诺边界，不用来推断实现。

| 证据 | 最小原文与关系 |
|---|---|
| E01 | `manifests/roles.json:16` 的 verification capabilities 没有 `workspace-write`；`scripts/lib/role-projection.js:434` 为可执行预设投影 `sandbox_mode: ... 'workspace-write' : 'read-only'`，`:603` 直接复制 adapter 的 `native`；但 `manifests/adapters.json:17` 同时声明 `"status": "configured-unverified"`，不能删去这个限定。 |
| E02 | `docs/rules/api-rules.md:17`：“使用项目配置 `language` 声明的语言”；`:30`：“用户可见提示断言中文文案”。 |
| E03 | `runtime/commands/run.mjs:2855` 的 status map 只取 `unit.status`，`:2870` 为 `status !== 'done'` 才加入 unfinished，`:3456`/`:3462` 据此前驱集合决定派发；`:3496` 却另识别 `done && verification?.status !== 'passed'`；`templates/plan.md:27` 要求进入依赖增量前完成验证。 |
| E04 | `runtime/commands/run.mjs:2750` 单元只含 acceptance/dependsOn/files/id/protectedGrants；`:2768` 比的是整体 allowedScope；`:2837` 的图只恢复 dependsOn/id；`:3451`–`:3453` 原注释是 “may this unit be handed out now” 及 “gate a write dispatch mechanically”；对照 `scripts/lib/task-dag.js:267` 的 `TASK_DAG_RESOURCE_LOCK_CONFLICT` / `TASK_DAG_SCOPE_CONFLICT`。 |
| E05 | `docs/rules/ai-collab-rules.md:79` 同句既写“确认节点声明的端口块与容器”，又写“登记表缺失、锁不可用或声明冲突时 fail-closed”；`:49` 说明端口/容器仅为多类 resourceLocks 之一。 |
| E06 | `scripts/lib/validation-tiers.js:309`：`VALIDATION_TIERS.slice(0, index + 1)`；`scripts/lib/project-verification.js:612` 把全部 selectedChecks 交执行器，`:469`/`:494` 逐个执行；但 `docs/rules/test-rules.md:59` 明写“同一指纹、同一命令集合”，`:60` 明写“命令集合变化按本轮检查重新执行”，Phase 1 的成本解释未充分保留这一限制。 |
| E07 | `scripts/lib/verification-plan.js:247` 读取 `tests/cases.json` 的 covers，`:283` 仅证明每个变更源至少被所选测试的一条路径归因，`:396` 高风险进整层分支；`docs/rules/test-rules.md:124` 明确“相对 import 可达”“下界语义”；`scripts/lib/verification-contract.js:159`–`:161` 不把该高风险整层计划标为 complete；本轮合成声明映射观察仍为 `scopeConfidence: lower-bound`。 |
| E08 | `scripts/lib/verification-plan.js:420` 加“无变更时的项目基线”；`scripts/verify-focused.js:156` 先执行，`:186`–`:188` 才输出 `No changed paths detected; no focused verification needed.`。 |
| E09 | `runtime/commands/run.mjs:1702` 找 existing，`:1722` 仅非 existing 才 add；`:1780` setup 失败后进入同一 catch，`:1802` 无条件 `worktree remove --force`，`:1807` 仅以 HEAD 等于 base 决定删分支。 |
| E10 | `scripts/lib/hook-bootstrap.cjs:1` 的 inherited 白名单含 Envelope 但不含 preset，随后 `spawnSync` 明传该 env；`runtime/hooks/codex-hook.mjs:139` 读取 `VIBE_HARNESS_PERMISSION_PRESET`、`:147` 回落 settings/null；`runtime/hooks/lib/role-permissions.mjs:40` 对 null 不拒绝直接写工具。 |
| E11 | `scripts/lib/file-transaction.js:177`–`:180` 陈旧锁只删除并重建；`:226`–`:227` 新事务 commit 后 release，`:124` 删除其 journal；`:290`–`:291` recover 仍选择旧 active；`:295`–`:298` 新事务已释放锁则无阻拦；`:92`/`:97` 删除当前目标并复制旧 preimage。 |
| E12 | `runtime/commands/run.mjs:1107` 只拒绝绝对路径；`:1110` normalizeSlashes；`:1755` `path.join(plan.worktreePath, assignment.envFile)`，`:1757` 直接 `writeFileSync`；这与 worktree 可在主仓外的正常设计不同，是 env 目标越出自身工作树。 |
| E13 | `runtime/commands/run.mjs:3250` 保存 fingerprint，`:3495`–`:3501` 完成消费者只用状态而未比较当前指纹；`scripts/verification-queue.js:52` 不允许 passed→stale，`:64` 却调用这个转移；`:80`–`:101` 消费队列也未比对入队身份。 |
| E14 | `scripts/lib/review-audit.js:97`/`:98` 只比顶层 reviewer 与 implementer，`:104`/`:105` 只验 reviewers 集合内部唯一，`:119` 可给 `REVIEW_APPROVED`；`CONTRIBUTING.md:133` 明确当前 shadow。 |
| E15 | `.github/workflows/ci.yml:217` 有 security，`:229`/`:232` 运行 dependency-review/gitleaks；`:299` 的 merge-gate needs 与后续 env 均无 security；`scripts/merge-gate.js:9`–`:21` 名单也无 SECURITY_RESULT；`docs/github-delivery.md:20` 只要求 merge-gate，`:25` 承诺失败 check 传播。 |
| E16 | `harness-evals/scenarios/H16-multi-agent-dependency.json:34` 的 critical trace 要求 decoder dispatch follows schema completion；`harness-evals/verifiers/scenario.js:163`–`:166` 仅作 has 检查，`:193` 的专用证据缺失清单遗漏 H16，`:199`–`:200` 可一般 change→verification 通过。 |
| E17 | `scripts/micro-verify.js:105` 仅传 snapshotBefore，`:106`–`:110` 才补 after 且只做 passed→blocked；`scripts/lib/micro-runner.js:85`–`:88` 缺 after 已把通过降为 blocked。 |
| E18 | `runtime/commands/run.mjs:124` 的共享 valueFlags 含 title/goal/risk-level/acceptance，`:3344`–`:3348` init 消费；`:3638`–`:3744` update 不消费这些字段，`:3736` 仍按 write 返回 passed、`:3739` 另报 written=false。 |
| E19 | `runtime/commands/run.mjs:3616`–`:3620` plan-check 失败立即返回，先于 `:3666` blocker、`:3684` failure、`:3691` nextAction；`:2931` 同时提示 “record the reason and run task plan-sync”。 |
| E20 | `scripts/lib/memory-audit.js:63`–`:67` 只扫描两目录的普通文件，`:91`/`:99`/`:100` 取首个日期；`:120` 只输出 filesChecked，不说明 sessions 未覆盖；`skills/integrations/agentmemory/references/handoff.md:21` 恰会回退 sessions，`references/audit.md:7` 包含 sessions。 |
| E21 | `runtime/commands/run.mjs:2995`–`:2997` 只验对象、taskId 和整数 schemaVersion；`:2588` 支持版本常量为 2；`:3801` 固定 ready、`:3803`–`:3815` 对缺字段填空；对照 `:3319`–`:3320` init 明确要求 title/goal，不能把残缺输入视为同等有效锚点。 |

## 合并建议与方案净收益

1. **W1/W2 合并为“派发输出合同不完整”整改簇，不能丢掉两个谓词。** W1 缺前驱可消费证据，W2 缺并发互斥；共享局部判定原语有益，但把整个多 Agent DAG 强塞进单 Agent Anchor 会增加字段、迁移与维护成本。最低成本先使输出明确哪些 ready 条件已检查、哪些未检查；需要全面 ready 的调用点再复用现有冲突内核。普通独立/顺序单元不新增第二份 DAG 或 scheduler。
2. **VER-F01 与 W1 关联，但不完全合并。** 即使 W1 开始读取 verification.status，仍可能接受已经过期的 passed；应共享“当前状态下有效证据”的判定。派发、显式完成和队列是不同消费者，分别保留负控；不能只修其中一个就宣称三个闭环。
3. **C1/C2/C4 同属 Anchor 边界，但不与 VER-F01 合并。** update 是记录请求、status/ready 是恢复读取、check/complete 是完成证据消费；三者不同。记录 failure 不应授权继续执行，status ready 不应被解读为 complete，完善恢复字段校验也不能代替验证新鲜度检查。
4. **R2 与 STR-F01 不合并为“已证实角色沙箱绕过”。** 前者是启动包装丢控制变量，后者是原生 sandbox 诊断精度；Codex 投影函数当前只写 name/description/sandbox/developer_instructions，没有证明它会注入 preset。修 R2 不能让粗粒度 sandbox 自动变精确；修诊断也不能补回丢失变量。
5. **R1/R3 可以共用“补偿只能作用于仍归本次事务所有的状态”原则，但保留两个修复。** R1 要区分新建/复用，R3 要闭合未完 journal 与下一事务的顺序；加自然语言清理规则不能修复任一路径。R4 另需写入目标的 canonical containment，不能只在配置文本上禁一个字符串。
6. **成本先修误导与重复所有权，不先删安全覆盖。** COST-03 可以先纠正提示；VER-F05 让快照/最终判定只有一个所有者；COST-01 应先测量重复成本，再设计命令粒度缓存的身份与失效，不把“17 次对 9 条唯一命令”的算术当实际节省承诺。COST-02 在闭包证据不足时保持现状。

## 五问遗漏补查

只补六域交界处的遗漏，不重抄 Phase 1 全部机制五问，也不新增正式问题。

| 跨域机制 | 解决什么 | 删除会怎样 | 更简单替代 | 能否稳定理解/执行 | 自动验证 |
|---|---|---|---|---|---|
| 失败补偿与复用资产归属（R1/R3） | 失败后保留可信状态 | 删除事务/恢复会留下半安装，不能整体删 | 保留现有事务；先处理旧 journal，只清理本次创建资产 | 当前反例已经破坏数据；这是代码问题而非 Agent 记忆问题 | 新建失败、复用失败、崩溃后续写再恢复三个 fixture，比全套生命周期更聚焦 |
| ready / done / passed 三种消费者（W1/W2/VER-F01） | 区分可派发、工作完成与证据有效 | 全删会回到人工判断 | 一个当前证据判定＋已有冲突检查；输出检查范围 | 当前字段相似但语义不同，不能靠父 Agent 猜 | 未验证 done、过期 passed、范围冲突、独立节点四类负控；H16 另验顺序 |
| 执行门与恢复记录（C2/C4） | 阻止错误实施，同时保存为何停下 | 删除 plan 门会放宽执行，删除恢复记录会丢上下文 | 只把门用于推进；纯恢复事实可写但仍标漂移 | 必须区分纯记录请求与夹带状态推进的混合请求 | 漂移时记录 blocker 成功、推进仍拒绝、残缺版本不假 ready |
| 权限声明到宿主执行（R2/STR-F01） | 尽量把角色能力上限落到工具入口 | 删环境清洗会泄露不必要变量，删 sandbox 会扩大权限 | 保留单白名单和原生 sandbox，准确报告粗粒度降级 | 本轮只证包装链；宿主加载、preset 注入和 OS enforcement 仍需宿主证据 | 同输入直接/包装入口一致；真实源码拒写另作宿主测试，不由投影审计替代 |
| 覆盖证据与缓存成本（COST-01/02） | 支付当前必要检查而不虚增信心 | 删层级或高风险回退可能漏验 | 同一状态下验证过身份的检查才可复用；无闭包仍整层 | covers 下界与 complete 声明必须分开，预算估计不等于成本测量 | 子进程计数＋状态/命令/环境漂移失效；高风险映射不足必须回退 |
| 真实门与证明门（VER-F03/F04/F02） | CI 阻断、协作评测、独立评审各解决不同问题 | 删任何一项会失去相应信号，但无需增新层 | 修现有失败传播与专用断言；shadow 仍如实报告 | 不能用一次 Eval passed 代替派发安全，也不能把 shadow 当强制门 | 每个必需 job 单独失败、H16 无协作/逆序、实施者混入 reviewers |

**本轮没有提出新增问题。** “缺真实长期轨迹”“宿主是否加载 Hook”“可选索引未安装”“没有自建后台调度器”均是证据边界或合理宿主分工，不因跨域无人负责就转成 finding。

## 本轮核验命令与结果

### 只读基线与原文

- `git status --short`：起始只有共同审查报告未跟踪；`git rev-parse HEAD` 与 Phase 0 一致。
- `node .agents/runtime/commands/run.mjs codebase-memory status --project . --json`：`unavailable / runtime-not-installed`；未 provision。
- CodeGraph 针对 run.mjs、事务、Hook/preset、投影、验证选择/执行、Review、队列、Micro、memory audit、H16 verifier、DAG 精确查询；仅对返回缺口补读限定行段，JSON/Markdown/YAML 直接核对。
- 一次限定文档文本检索包含不存在的 `docs/commands.md`，工具报告该文件不存在；没有将其当证据，后续直接以当前源码注释和已有模板裁定派发承诺。

### Phase 2 独立诊断观察（不是正式 Micro/产品验收）

1. 复跑 `2026-09-25-phase1-reliability.md` 已保存的 `javascript` 观察脚本：PowerShell 只提取该已核读代码块，经 `node --input-type=module -` 执行；全部写入位于脚本新建的 `tmpdir()/vh-reliability-observation-*`，finally 校验绝对路径后清理，退出 0：

   ```jsonl
   {"observation":"existing-worktree-failure","firstStatus":"passed","retryStatus":"failed","rolledBack":true,"treeStillExists":false,"userFileStillExists":false,"branchDeleted":true}
   {"observation":"relative-path-escape","status":"passed","envFile":"../outside.env","targetOutsideWorktree":true,"outsideFileExists":true}
   {"observation":"stale-transaction-overwrites-new-commit","afterCommit":"new-success","staleJournals":["active"],"recoveredCount":1,"afterRecovery":"original"}
   {"observation":"bootstrap-host-preset-loss","directExit":0,"directDecision":"deny / ROLE_PERMISSION_PRESET","bootstrapExit":0,"bootstrapDecision":{},"actualWriteExecuted":false}
   ```

2. `node --input-type=module -` 重建 VER-F01 的最小负控：新建 `tmpdir()/vh-phase2-completion-*` Git 项目，声明 `test: node check.mjs`，该检查断言 value.txt 为 good；依次公开 CLI `task init → verify --only test → task update --unit u1 --unit-status u1:done --verification <真实JSON> → task check --complete → 改为bad → node check.mjs → task check --complete`。finally 校验并清理，观察进程退出 0：

   ```json
   {"beforeVerification":"passed","beforeComplete":"passed","postChangeBehaviorExit":1,"postChangeComplete":"passed","postChangeCompleteExit":0}
   ```

3. `node --input-type=module -` 只读负控：用子进程 env 将当前 merge-gate 导出的七个结果设 success、SECURITY_RESULT 设 failure，再执行 `node scripts/merge-gate.js`；另调用 `buildVerificationPlan`，对 runtime 路径传合成 covers 声明，仅观察计划、不执行检查；退出 0：

   ```jsonl
   {"observation":"security-propagation","security":"failure","gateExit":0,"gateOk":true,"securityConsumed":false}
   {"observation":"high-risk-scope","risk":"high","scope":"affected","scopeConfidence":"lower-bound","checks":["pnpm validate","pnpm lint","pnpm typecheck","pnpm test:unit","pnpm test:component","pnpm test:integration"]}
   ```

   合成 covers 不是实际覆盖闭包证明，恰用于挑战“只要所有变更文件都出现在映射中就能认定高风险收窄安全”的前提。

### 验证边界

- Phase 2 没有重跑 Phase 1 已执行的 25 个聚焦现有测试；它们属于 Phase 1 记录，不能写作本轮重新通过，也不能反证这里的反例。
- 没有真实宿主多 Agent、真实上下文压缩、线上 CI/ruleset 或长期成本 trace，因而不报告成功率、Token 节省、宿主级隔离通过或生产事故。
- 静态已核实与独立诊断复现分别列出；没有修复产品，所以这些观察不是修复后验收。
- 写报告后只做报告空白校验与产品 Git diff 检查；不因生成审查文档自动运行整仓检查。

## 交回父 Agent 的建议顺序

1. 先消除 R1/R3/R4 的破坏性写入和 VER-F01/VER-F03 的显式终态假绿。
2. 再闭合派发谓词、权限变量包装、恢复异常记录以及 H16/Review 的证明精度。
3. 最后处理 P2 文案/诊断与经过测量的差集执行优化，暂不采纳 COST-02 的高风险收窄建议。

保持 Fast Path、按需升级、单一事实源与宿主能力边界；不新增角色、强制 Review/Test 阶段、状态服务或第二份 DAG 来替代局部根因修复。
