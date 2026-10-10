# Symphony 宿主接入边界

本参考是 Vibe-Harness 与 Symphony Elixir fork 的接线合同，不是可运行的调度器、Grant 签发入口或生产启用证明。Symphony 的原始轮询、进程内 claimed 集合、自动 retry、`linear_graphql` 原始 mutation 和宽权限 workspace hook 均不能直接承载自动领单。只有宿主完成下列约束并通过跨仓与真实接口验证后，才可启用自动模式。

## 签发和派发

- 由用户明确授予一个仓库、一个 Linear team 或 project 队列、Agent 产品身份、精确 `origin/develop`、独立 effects、UTC 截止时间及正整数 `maxClaims`。认证运维人员在受保护的宿主 CLI 内记录授权依据并签发/撤销持久 Grant；项目文件、Issue 正文、Webhook 或 Agent 不能签发。首次部署并发上限为 1。
- Grant 保存 `grantId`、队列与仓库标识、`agentKey`、目标 ref、effects、`expiresAt`、`maxClaims`、已占额度、撤销状态和审计引用。自动合并需在签发时明确允许 `mergeRequestWrite`，不得从代码实现权限推导。
- 宿主只在授权建立后的空闲事件或验签且去重的队列变化事件选候选；限于 Todo 代码任务，顺序为 Priority 降序、创建时间升序、Issue ID 升序。不允许 Agent 扫描队列；周期任务只能观察已派发执行及续期，不能绕过 Grant 启动新 Issue。

## 原子 Claim 与登记

- PostgreSQL 同一事务核验未撤销、未过期的 Grant、剩余额度、精确队列和仓库、单 Grant 并发上限及单 Issue 唯一活动 Claim；成功预留时占用一次额度，失败后不得自动返还。数据库唯一约束与条件更新提供跨进程互斥，并产生新的递增 fencing token。`scripts/lib/linear-claim.js` 是纯状态转换辅助函数，不实现数据库事务。
- 每次执行使用稳定的 `executionId`、`claimId` 和幂等键。结果不确定时先按键查询；同键同内容才可视为重试成功，不得新建第二次执行。先 Claim，再登记 Delegate 与不可变 v3 Start Receipt，最后重读并逐字段确认。v3 的自动领单 source 固定 `authorized-auto-claim`，带非敏感 `grantId`、Claim 元数据与宿主 provider 标识；历史 v1/v2 只读解析。
- 执行结束只追加一条终止事件记录：`schema`、`eventId`、`executionId`、`eventType`、`successorExecutionId`、`occurredAt` 六个字段，`eventType` 为 `local-work-completed`，`successorExecutionId` 必须存在且为 `null`。release、abort 与 handoff 是独立的宿主决定，不由该路径产生。
- Claim、身份或 Receipt 有任何冲突、部分登记、分页不完整、lease 过期或 fencing 失配即停止写入并进入人工核对，保留 worktree、分支、PR 和台账；不得靠过期自动释放、替换或重派。正常续 turn 在同一运行时复用 ID，新的运行时必须显式 handoff 或 release。

## 执行隔离与终点

- 宿主逐 Issue 签发 v2 Execution Envelope，冻结工作区身份、目标 SHA、受限写入根、Linear 范围、允许及禁止 effects 和真实宿主证明。启动、续跑和每次外部写入前核验 Grant、Claim、lease、fencing、Envelope 与当前 Issue；不满足即 fail-closed。
- Agent 不持有 Linear/Git 原始写凭据，不暴露可调用任意 mutation 的宿主 `linear_graphql`。经最小权限代理按当前 Issue 与 effect 执行 Linear、Git push 和 PR/MR 操作：宿主侧只提供逐操作的 effect allowlist 判定（`linear_set_delegate`/`linear_append_receipt`/`linear_append_event` 属 `linearWrite`，`git_push_branch` 属 `gitPush`，`git_create_closing_pr`/`git_squash_merge` 属 `mergeRequestWrite`），禁止 effect 优先于任何放行回调，Worker 侧只拿到冻结上下文（Issue、Claim、fencing、工作区身份、Envelope 摘要、目标 SHA、worktree 路径、镜像与命令），不含 provider 句柄。Worker 与生命周期 hook 均须受 OS 文件系统和默认拒绝网络出口约束，避免 shell 或 API 直连绕过。
- 只有本次运行创建的 closing PR/MR、最新 `origin/develop` 验证、稳定 fast gate 和适用的独立评审证据均成立，且 Grant/Envelope 允许 `mergeRequestWrite`，才可 squash 合并。重读合并证据后才报告 Done；PR 创建或本地验证通过不等于 Done。异常、撤销或证据不足时停止该 Grant 的后续派发。

## 落地状态（2026-10-10）

Symphony Elixir fork 已有第一段可验证实现：Grant 签发 CLI、PostgreSQL Claim 状态机、宿主签发的去重队列事件、guarded 派发状态机、限域 Linear/Git 代理、离线隔离容器和同运行时重启核对。自动派发仍默认关闭，`guarded` 需要宿主同时设置 `SYMPHONY_ALLOW_GUARDED_DISPATCH=1`、`SYMPHONY_GUARDED_DATABASE_URL`、`SYMPHONY_GUARDED_EVENT_SECRET`，且入口只有单 Issue 的签名事件。

已有证据（可在隔离环境重放）：SQL 契约与角色边界在一次性 PostgreSQL 17 上通过；真实数据库集成用例覆盖双实例并发预留、失败方不返还额度、重复重试、登记 fencing、撤销、review、effect 拒绝与同运行时重启核对；Elixir 侧 52 个 guarded 用例覆盖 Envelope 冻结、事件验签与重放拒绝、越权 effect、Worker 上下文不含 provider 凭据。消费方以 `tests/fixtures/symphony-hosted/guarded-execution.sample.json`（由宿主侧 `GuardedReceipt` 真实代码路径生成）验证 v3 Receipt 与 v1 终止事件可被接受，并拒绝被篡改的记录。

尚未闭环：Linear webhook 入口与签名事件投递循环、沙箱内的真实模型 Worker、独立评审门禁与 closing PR 的 squash 合并编排（代理已具备受控调用，但没有驱动序列，因此派发结果恒为 `merge: nil`）。在这些缺口补齐并通过真实隔离 Linear/Git 成功与拒绝路径之前，不得签发生产 Grant、真实领单、推送或自动合并。

## 验证与回滚

提供方须覆盖双实例竞争、重复事件、超时后的幂等查询、失联、重启、撤销、lease 过期、写凭据绕过和拒绝越权合并。消费者须以相同合同样例覆盖 v1/v2 兼容、v3 登记和错误码。单仓 mock 不能证明真实跨仓集成；先在隔离环境完成真实 Linear/Git 成功与失败路径，再由持久 Grant 显式开启生产派发。

回滚先停新派发、撤销 Grant 并隔离运行 Worker，保留全部证据供人工核对；已合并提交须经独立授权的 revert PR 处理，不得删除 Receipt 或直接清空 Claim 表。
