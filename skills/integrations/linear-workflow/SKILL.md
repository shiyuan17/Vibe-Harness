---
name: linear-workflow
description: Use when executing, reviewing, verifying, refining, synchronizing, or handling host-dispatched authorized Linear issues in a multi-Agent coding workflow.
---

# Linear 工作流

本 Skill 是 linear-workflow 规则的操作入口：规则定义授权模型、状态门禁、原生 DAG 语义、Execution Receipt 和 Git 流的完整合同，本 Skill 只保留触发条件、操作顺序和回退。规范条文以 docs/rules/linear-workflow.md 为准，本文件不重复；两者描述同一工作流，修改须同步。

触发与边界：

- Writer 仅在用户明确要求具体 Issue、已有 Delegate 且宿主显式启动，或宿主依据有效限时领单授权事件派发具体 Issue 时执行。
- 无宿主授权派发时禁止自动领取；Agent 不扫描、轮询或订阅 Ready Queue。Vibe-Harness 不提供常驻调度器、自动超时回收或自动重派。
- 没有具体 Issue ID 时，Agent 不选择、认领或更新任务；宿主按规则第 1 节选候选，不把队列可见性当授权。
- 高风险执行只接受 v2 Execution Envelope，v1 仅作 contract-only/degraded 兼容；mode 与 effect 枚举按规则第 1 节。调用写工具前建立当前请求的 Execution Envelope。无原生 Goal bridge 时不声称后台持续执行，不阻止用户继续请求或宿主显式续跑恢复原范围工作。
- 分支约定：`feat/*、fix/* → develop → main`；紧急修复 `hotfix/* → main → develop`。`develop` 是日常集成分支，`main` 是正式发布分支，不创建长期 `release/*` 分支，`release/*` 只在管理员为并行维护版本临时创建时存在并按其门禁处理；closing PR 合并后开发 Issue 立即 Done。合入 `develop` 不要求远端 CI 或强制审批；远端 CI 只在发布边界（`develop → main`、`hotfix/* → main`、`release/*`）运行。合并前的本地验证必须建立在最新 `origin/develop` 之上，高风险变更仍须携带 Independent Review Receipt。

## 1. 判断执行授权与角色

按规则第 1 节判定授权后开始。提及、查看、总结、解释、Review、Verify 或列出队列都不构成领取授权；Ready、Todo、依赖满足或队列可见不是 execute 授权。Reviewer 和 Verifier 始终只读，不登记执行身份、不写 Receipt、不取得实现所有权。自动领取仅接受宿主给出的具体 Issue ID、未撤销且未过期的限时授权、尚未用尽的领取数额、独占派发证明和绑定该 Issue 的 v2 execute Envelope；缺任一项即拒绝。每个 Issue 达到 terminalCondition 后结束本次运行，下一任务只能由宿主重新核验授权并启动新的运行。

## 2. 读取 Linear 真值

使用可用的 Linear connector 读取宿主指定的当前 Issue 的状态、Assignee、Delegate、描述、Project、Cycle、labels、全部原生 relations、workspace 与 team Guidance（team 级优先，且指导不是授权根），以及足以判定所有 Execution Receipt 生命周期的完整结构化评论历史。DAG 节点还要读取 DAG Root 和判定直接或传递依赖、Scope、Resource Locks、trigger 与 fan-in 所需的节点。Agent 不读取队列自行选单；宿主事件派发按 Priority 降序、创建时间升序、Issue ID 升序挑选 Todo 候选。

无 Parent、Dependencies=None 且 resourceLocks=None 的独立 Issue 使用单任务快车道：只读取当前 Issue、完整 Receipt 生命周期和直接关系，不得执行全项目 DAG 遍历。若发现 Parent、直接依赖、非空 Resource Locks、Scope 冲突线索或关系不完整，退出快车道并按 DAG 门禁补读足够范围。

分页不完整、关系不可见、Receipt 无法解析或记录互相矛盾时 fail-closed。不得推断不存在的字段、关系、权限或评论。不要读取无关团队或扩大搜索范围。Triage Issue 只读解释，不自动 accept、duplicate、decline 或 snooze。

同一用户请求保存 dagStructureHash，覆盖范围以规则第 4 节为准（结构字段，不含 related 关系、评论活动与状态流转）；提供方支持时另存 dagChangeCursor。只有摘要与可靠游标共同证明结构未变，恢复才采用当前 Issue、PR/MR、HEAD 和变化节点的增量读取；旧哈希本身不是未变证据。无可靠游标时允许一次有界重读相关完整范围，仍不完整则暂停受影响执行。

## 3. 执行 Ready 与 DAG 门禁

按规则第 3、4 节逐项核对 Definition of Ready、依赖真值、Scope 投影与冲突串行；发现缺口或冲突时只报告事实，不自动拆 Issue、补关系、改变 Parent 或调整优先级。门禁通过后解析目标远端 ref 并冻结 base SHA，后续分支和 worktree 从该基线创建。契约耦合节点的派发前重验证按规则第 4 节执行。

## 4. 登记 Agent 与 Execution Receipt

正常写通道下，在创建 worktree、分支或开始实现前按固定顺序登记；完整 schema、幂等与恢复语义见规则第 5 节：

1. 检查是否已有其他 Delegate、其他 fallback Agent label 或未终结的活动实例；存在时停止并请求显式交接。
2. 保留人类 Assignee，优先登记原生 Delegate/App User。
3. 不支持 Delegate 时，只使用管理员预配置的低基数 agent:<agent-key> 与 role:writer 标签；不得创建带实例 ID 的标签。
4. 按 references/execution-receipt.md 追加不可变 start Receipt；自动领取用 v2、source=authorized-auto-claim 和宿主授权的非敏感 grantId，其他情形沿用 v1。
5. 重新读取并逐字段确认身份与 Receipt 一致；任何部分写入、结果不确定或验证失败都报告 registration-incomplete，不开始实现，也不声称已领取。

v1 source 依次判定为：有效交接使用 authorized-handoff；本轮明确执行指令使用 explicit-user-request；否则只有当前 Agent 已是 Delegate 且宿主显式启动时使用 existing-delegate。宿主自动领单不伪装成 v1 显式指令，必须使用 v2 authorized-auto-claim。宿主没有可证明的跨实例互斥能力时，写后重读也不能替代原子领取，停止派发。

## 5. Linear 不可写时的回退/fallback

Linear 只读、MCP 不可用或写入验证失败时，不得声称已登记、领取或同步。只有用户已明确要求执行具体 Issue，且用户提供的上下文足以通过 Ready 与 DAG 门禁时，才可继续本地工作，并明确标记 unregistered / Linear 未同步；自动领单没有此回退，停止派发。

写能力恢复后不得回填或倒签 Receipt 冒充先前已登记；若继续执行，从恢复时刻创建新的 registered execution。Reviewer 和 Verifier 即使能看到写工具也不得使用。

## 6. 隔离执行与状态同步

正常登记确认后，write 叶子 Issue 使用一个 Writer、一个命名分支和一个 closing PR/MR。顺序执行且工作区干净时允许使用当前 clone；并发 Agent、脏工作区、存在无关改动或明确需要隔离时，必须创建仓库外 worktree。分支使用 <type>/<ISSUE-ID>-<slug>，worktree 使用同级 <repo>-worktrees/<ISSUE-ID>。commit 使用 `Refs <ISSUE-ID>`；GitHub PR 或 GitLab MR 描述使用 `Fixes <ISSUE-ID>`，只有提供方配置且创建后重读确认的等价 closing 语法才可替代。read 节点只产出约定输出和 Verification 证据；aggregate Parent 不创建实现 worktree。

普通 `feat/*`、`fix/*` 以 `origin/develop` 为目标；合入 `develop` 不要求远端 CI 或强制审批，Writer 在 envelope 授权 `mergeRequestWrite` 后可自行 squash 合并（或在提供方请求 auto-merge），closing PR 合并后开发 Issue 立即 Done。限时领单的默认目标也是合入 `develop`，但 `linearWrite`、`workspaceWrite`、`gitBranch`、`gitCommit`、`gitPush`、`mergeRequestWrite` 及实际需要的其他 effects 均须逐项授权；缺少合并授权时停在已授权终点，不假称 Done。合并前必须确认本轮验证建立在最新 `origin/develop` 之上，base 已前进时重跑受影响检查；高风险变更缺少 Independent Review Receipt 或收据结论为 negative 时不得自行落地合并。`hotfix/*` 从 `origin/main` 创建并先合入 `main`（此处运行发布门禁），随后用非 closing PR 回同步 `develop`。Release 流程与 credential helper 边界按规则第 6 节执行。

创建 PR/MR 前重新读取目标 ref 与 source HEAD，确认提供方 target 等于声明 ref；计算 merge-base，并确认它等于冻结 base SHA，或是该 SHA 在同一目标 ref 历史上的已验证后代。不一致时阻断创建。创建后重读标题、source、target、描述、Issue 链接和 closing 语义。

优先让 Linear 的 GitHub/GitLab 集成或团队自动化推进状态；只有缺少对应自动化且 envelope 允许 linearWrite 时才手工更新，并执行“读取当前值 → 校验允许转换 → 写入 → 重读确认”。本地工作完成、测试通过或 PR/MR 创建都不等于 Done；当 envelope 授权 `mergeRequestWrite` 且目标为 `develop` 时，Writer 自行落地 squash merge 后该写叶子即 Done，否则在 PR ready for review 后报告等待人工合并。`Ready to Merge` 只对带门禁目标（`main`、`release/*`）适用，Done 的完成证据按规则第 2 节状态表执行。

释放、中止、交接和本地工作完成都追加 terminal event，不编辑原 Receipt。没有自动超时或自动回收；失联实例必须由人工核对 worktree、分支和 PR 后显式释放或交接。

## 7. 交付与参考

交付时报告本地结果、验证证据、PR/MR/merge 的已观察状态、登记状态及 Linear 是否实际同步。不要把请求已发送、工具不可用或推测状态写成成功。终止条件、monitor 观察边界与并发软上限按规则第 7 节执行。

创建团队模板或管理员配置时，按需读取：

- references/ai-coding-task.md
- references/dag-parent.md
- references/execution-receipt.md
- references/release-issue.md
- references/triage-template.md
- references/workspace-setup.md

这些文件是配置和契约清单，不授权直接修改 Linear Workspace。
