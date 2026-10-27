# Git 规则

Git 规则的目的是保护用户改动、让提交可审查、确保 worktree 任务真正 merge-back；每个判断都以仓库实际远端事实为准，不用设想中的分支模型代替核实。

## Fast Path 卡片

- **默认路径**：编辑前后核对 `git status --short`，只暂存本任务改动，一个逻辑变更一个 commit；已验证且归属明确的本地提交与当前分支普通推送可按需执行，不是完成任务的默认动作；建分支、PR/MR、凭据等按各自授权边界执行。
- **提交信息**：主题 `<type>(<scope>): <描述>`，正文写为什么改与被否决的方案；不用 `--no-verify`，不伪造署名 trailer。
- **不变量**：归属不清的改动视为用户改动，不覆盖、不暂存、不提交；显式 split-push 调用将调用时已有修改纳入交付范围，按「启动与归属」核对排除项。凭据、私钥与个人敏感数据不进入提交、提交信息或 PR/MR。
- **继续读全文的信号**：历史改写、force push、共享分支与门禁、worktree 隔离、合并落地、冲突处理、Hook 或跨仓协作。

以下为完整规则，仅当任务超出卡片或命中升级触发时继续读取。

## 多 Worktree 并发交付：stage/publish 两阶段协议

### 词汇定义

在两阶段交付协议中，worktree 有明确的角色分类。受管交付使用 `stage` 与 `publish`；旧 `worktree land` 兼容引擎已移除：

| 词汇 | 定义 | 生命周期 | 用途 |
|------|------|---------|------|
| **Candidate worktree** | 隔离的临时 worktree，用于构建和验证待交付的组合提交 | stage 持久化候选引用后清理；推送结果不确定时保留供检查或恢复 | 验证即将发布的提交，不修改主检出或远端 |
| **Task worktree** | 用户或宿主创建的 worktree，对应一个工作分支（如 `feat/X`） | publish 确认后进入清理阶段；失败时保留，分支仅在远端确认后删除 | 用户在上面进行开发工作，最终提交到目标分支 |
| **Primary worktree** | 仓库的主检出点（Git 的默认工作树） | 持续存在 | 维护本地状态；publish 后仅在安全时 ff-only 同步目标分支 |

**两阶段交付的角色划分**：
- **Candidate worktree** 由 stage 或 publish 重建路径内部创建，完全隔离；候选 SHA 先持久化到私有 ref，再进行清理
- **Task worktree** 是用户或宿主主动创建的开发环境；publish 确认后尝试移除该 worktree，未发布事务由 `discard` 释放
- **Primary worktree** 是 `git worktree list` 显示为主分支（通常是 `develop`）的那一个

### 问题背景

在多 worktree 并发开发中，真正需要串行的只有对同一目标 ref 的最终更新：
基线读取、非强制推送与远端 SHA 回读必须呈现一个确定顺序。候选构建与
验证运行在 detached 候选 worktree 和私有 ref 上；共享依赖、端口与服务
必须另行隔离，目录隔离本身不证明资源隔离。把验证
也纳入仓库级互斥，会让一个批次的重型检查阻塞其他批次的短时收口。恢复
动作若依赖人工判断远端事实（显式 supersede、归档仪式），会把可以自动
推导的结论变成操作负担；验证失败若不区分候选失败与环境失败，会让已
验证候选被反复重建。

### 两阶段交付协议（stage/publish）

stage 把“本地完成”从远端时序中解耦，publish 再完成最终集成。只有
`publish --write` 进入 Git common dir 下的仓库级 FIFO，且只在短时
finalize 段持有队首；stage、全部验证与清理都在队列外执行。

这里“验证出队”指运行时显式候选验证；原生 push 仍执行项目 pre-push Hook，
Hook 与网络时延会延长 finalize，不承诺固定秒数。不得为缩短占锁时间静默绕过
项目 Hook。正常推送确认后先释放队列，再尝试本地 ff-only 同步和清理。

短时互斥只用于分配单调票号；票按 `%012d-<uuid>.json` 保存，状态限定为
`queued`、`running`、`completed`、`cancelled`、`expired`。只有队首取得
运行租约，等待者持续心跳并报告 `queue-wait`、`queue-ready`、
`queue-released`、前方数量和持有者。

#### Phase 1：本地 stage（队列外构建、验证与暂存）

参数校验、任务/分支检查、变更范围与远端地址解析全部在队列外完成；
stage 全程不进入仓库 FIFO：

1. **隔离候选构建**：以本地 `refs/heads/develop` 快照为基线，在临时独立 worktree 中按任务顺序 no-ff 合入冻结提交；stage 不 fetch。
2. **隔离验证**：在该临时 worktree 中执行所选必要验证；显式选中的 `deep` 或
   `resourceClass: "repo-heavy"` 检查同样在队外执行。验证持有带心跳续期的候选活动租约；共享端口、数据库或缓存仍须单独隔离。
3. **持久化本地结果**：候选 SHA 写入 `refs/vibe-harness/staged/<batch-id>`，事务记录冻结源 HEAD、本地基线和验证指纹，返回 `local_staged`；候选目录清理等非关键收尾随即在队列外执行。

验证绑定冻结 base SHA，干净候选也能向 affected 检查传递真实变更路径。
复用不是默认跨树命中：workspace 模式绑定同一工作区；tree-content 模式只对
显式 deterministic 检查开放，当前按整树、命令、工具链、配置与环境指纹匹配，
selection 检查另绑定 base/路径。整树内容变化会失效，不承诺逐路径增量重验。
已被同一有效候选收据覆盖的 fan-in 不重复执行；同目标已就绪任务可一次合批。

主检出有无关改动或位于其他分支不阻塞 stage；stage 不 stash、覆盖、提交或移动主检出。

#### Phase 2：远端 publish（自动对账 + 短时 finalize）

publish 不重新排队整个发布：入口先在队列外 fetch 精确目标 ref 并自动对账，
结论自动推导，不移动主检出，也不在旧候选上叠加第二次 merge：

1. **已集成确认**：候选已是远端 HEAD 的祖先 → 记录对账历史（kind
   `integrated`）并确认集成，直接进入队外清理。
2. **自动归档**：远端已包含全部冻结源 HEAD 但未包含候选 → 自动写入
   `archived_integrated`（kind `archived-integrated`），旧候选与匹配的
   staged ref 安全回收。
3. **基线前进重建**：远端已从 staged 基线前进 → 从新基线重建同一组冻结源
   提交的候选（kind `rebuilt`），按完整输入指纹复用或重验，
   再回到对账入口；重建最多
   `LAND_MAX_ATTEMPTS = 3` 次，超限返回 `LAND_BATCH_BASELINE_CHANGED`
   并保留现场。
4. **基线未动终锁**：远端仍停在 staged 基线 → 取得仓库 FIFO 队首并只在
   短时 finalize 段持有它：重新解析唯一实际 push URL 并复查基线新鲜度 →
   显式非强制 refspec 精确推送冻结候选 SHA → 重读精确远端确认，候选等于
   远端 HEAD 或仍为其祖先才进入 `integrated` → 释放队列 → 安全 ff-only 本地同步
   （主检出不
   在目标分支、脏或领先时记录 `deferred` / `diverged`，不改用户文件）。

冲突、验证失败或推送结果不确定时，事务先记录 `conflict`、
`recovery_required` 或 `push_uncertain` 再继续；人工检查不得阻塞后续请求。
队外清理失败返回 `integrated_cleanup_pending`，重试只清理。队列等待默认
30 分钟，可用 `VIBE_HARNESS_REPO_QUEUE_TIMEOUT_MS` 收紧；旧
`VIBE_HARNESS_LAND_LOCK_TIMEOUT_MS` 作为兼容别名。

### 验证失败分类与被取代候选

验证失败写入事务的 `verifyFailure`，按 `candidateFailed` 分流：

- **候选失败**（`LAND_VERIFY_FAILED`，failureType `checks-failed`）：事务置为
  `recovery_required`，必须修复源提交后重新 stage，不得在原候选上续跑。
- **环境失败**（`LAND_VERIFY_ENVIRONMENT_FAILED`，failureType `blocked`、
  `stale`、`snapshot-drift`、`snapshot-unknown` 或 `not-run`；协作取消产生
  的 `VERIFICATION_CANCELLED` 归入 `not-run`）：同一候选保持可续跑，环境
  恢复后重新执行验证即可。

publish 重建后的环境失败保留可恢复阶段与候选 HEAD；基线、冻结源和候选的
干净状态未变时续验同一树，不重新 merge。候选被改动时保留现场并拒绝复用；
远端继续前进时按新基线有界重建，真实检查失败仍要求修复源提交。

publish 确认集成或自动归档后，仅当同一 push endpoint 指纹与精确 ref 已包含另一事务的全部冻结源时，才对仍登记且租约归属未变的候选写入 CANCEL sidecar。基线前进不取消独立工作；验证在检查之间协作停止，不杀宿主进程、不强制释放活租约。`supersededCandidates` 的 `cancel-requested` 只表示请求已发送，实际停止前资源仍占用；死进程残留交由 recover。

### 残留锁处理

当交付进程异常中止时，队列票、事务 lease、候选活动租约或旧格式锁可能残留。处理步骤：

1. **只读盘点**：`worktree recover --project . --json` 列出队列票、事务、
   lease、staged ref 与候选目录；活跃或无法判定的租约、
   脏候选、`push_uncertain`、用户分支和非事务目录一律保留。外部集成不需要显式归档仪式：下一次 `publish --batch <batch-id> --write` 的自动对账会 fetch 精确远端并写入 `archived_integrated`。

2. **显式全局回收**：
   ```bash
   node .agents/runtime/commands/run.mjs worktree recover --project . --all --write --json
   ```
   仅回收心跳过期票、死进程 lease、已结束事务的干净候选与私有 ref。
   活跃租约、脏候选和无法归属的内容继续报告并保留。

3. **限域恢复候选 worktree**：若临时候选 worktree 残留在
   `.vibe-harness-land-{taskId}-{uuid}`，先检查目标任务、活动租约和工作区状态：
   ```bash
   node .agents/runtime/commands/run.mjs worktree recover --project . --task <taskId> --write --json
   ```
   无选择器的 `recover --write` 必须拒绝；只有显式 `recover --all --write` 才能全局恢复。

**FIFO 的特性**：

- 单台机器、单个 Git common dir 的仓库级顺序，不跨机器协调。
- 不自动合批、不抢占、不按优先级插队；队首失败也要记录现场后释放。
- 只有 publish 的短时 finalize 段（基线复查、目标 ref 更新、非强制
  push 与远端回读）持有队首租约；候选构建、全部
  验证与清理都在队列外执行。直接在其他终端执行的原生 `git merge`
  不在可拦截范围内。
- `validationCommands.checks[].resourceClass: "repo-heavy"` 仍是合法声明，
  由验证计划与收据原样透传；它不再触发仓库级互斥或队列集成，重型检查
  与其他检查一样在候选内执行，并行于其他批次。
- 自定义 `verify:changed` 一类重检查必须改用
  `node .agents/runtime/commands/run.mjs verify --project . --tier quick
  --paths <paths...>`，不能只在干净候选树中直接执行底层脚本；`--paths`
  显式提供变更范围，避免空 diff 回退到不受管的检验路径。

### 版本词汇

| 术语 | 含义 | 备注 |
|------|------|------|
| **Phase 1** | 队列外构建、验证候选并持久化 staged ref | 不 fetch；不进入仓库 FIFO |
| **Phase 2** | fetch 自动对账，必要时重建并按指纹重验，短时终锁完成推送与本地同步 | 只有 finalize 段持有队首，推送确认后释放，本地同步在队外尝试 |
| **Delivery FIFO** | Git common dir 下的仓库级单调票队列 | 只有 publish 的 finalize 段取队首；等待者报告位置、前方数量与持有者 |
| **自动对账** | publish 入口 fetch 精确远端并推导确认/归档/重建/终锁 | 取代 `--supersede` 与 `--archive-integrated` 仪式 |
| **Baseline 变化** | 对账发现远端目标已从 staged 基线前进 | 队列外从新基线重建并按完整输入指纹复用或重验，最多 `LAND_MAX_ATTEMPTS = 3` 次 |
| **Queue timeout** | 默认 30 分钟的等待预算 | 超时返回 `WORKTREE_QUEUE_TIMEOUT` 并保留票与现场 |
| **Lease Lock** | 票记录中的 PID、心跳与 TTL | 死进程或过期票可盘点回收，活跃租约保留 |
| **--target-mode primary** | `stage` 专属的本地目标意图断言 | 其他子命令拒绝该参数；`remote` 已退役并在任何写入前拒绝 |

### 代码层面

#### 常量定义

```javascript
const DEFAULT_DELIVERY_QUEUE_TIMEOUT_MS = 30 * 60 * 1000;
const QUEUE_TICKET_LEASE_MS = 60_000;
const QUEUE_TICKET_HEARTBEAT_MS = 15_000;
const LAND_MAX_ATTEMPTS = 3;
```

#### 核心函数

- `enqueueDelivery` / `acquireDeliveryTurn`：分配单调票并等待队首租约（仅 publish 的 finalize 段入队）
- `releaseDeliveryTurn`：记录完成、取消或过期状态并推进队首
- `inspectDeliveryQueue` / `reconcileDeliveryQueue`：只读盘点与显式回收过期票
- `worktreeStageReport(projectDir, args)`：队列外候选构建、验证和暂存入口
- `worktreePublishReport(projectDir, args)`：fetch 自动对账、重建与短时 finalize 入口
- `worktreeStageStatusReport` / `worktreeDiscardReport`：只读恢复与未发布事务回收
- `cancelSupersededCandidates` / `copyVerificationReceipts` / `reconcilePublishedBaseline`：协作取消、收据复制与对账推导

### 效果

| 场景 | 全流程入队 FIFO | 验证出队 + 短时终锁 |
|------|-------------------|-------------|
| 3 个 worktree 同时交付 | 重型验证按票号串行，后续批次等待最重检查完成 | 验证并行进行，只有短时 finalize 排队 |
| 远端在验证期间前进 | 队首 publish 读取最新远端后整树重验 | 队外自动对账重建并按指纹重验，收据复用降低成本 |
| 被取代候选仍在验证 | 继续占用队列与算力直到本批轮到 | 仅对同目标已集成的冻结源请求协作取消，原持有者释放租约 |
| 进程崩溃或超时 | 锁与候选可能残留且难以判定 | 票和 lease 可盘点，死票与安全事务可显式回收 |

## Delivery Profile 清理边界

managed-mr 的 land 只读取已合入 MR 的证据，不本地合并或推送；ancestor 快速路径保留。squash 清理须绑定 sourceBase/sourceHead、targetRef/targetBefore/targetAfter、mergeMethod/mergeCommit、patchId 和 taskId，并重读目标引用、核对整个 source diff 与单父 squash commit 的 stable patch-id、干净工作树以及当前完成收据；缺失、漂移或不一致一律 blocked。GitLab `--mr` 读取失败不得猜测已合并。cleanup 保留分支，不自动强删 squash source 分支。

### 显式 develop flow

仅用户显式调用 `vb-git-develop-flow` / `$vb-git-develop-flow` 或 `vb-linear-worktree-develop` / `$vb-linear-worktree-develop` 才选择此模式；风险等级只影响验证与必要隔离，不自动选择 flow。普通提交、`vb-git-split-push`、普通 Linear Issue 与项目默认 delivery 保持各自入口，不创建额外流程。

本节定义 local-land 交付合同，Skill 只保留入口、操作顺序和停止边界。宿主创建的 worktree 通过 `--task <id>:<branch>` 的精确分支或路径归因，不要求先写入端口登记表；`worktree bootstrap` 保留为无宿主或需要受管端口时的 fallback。只提交本任务已归属的改动，核对 canonicalCwd、gitCommonDir、gitDir、分支、HEAD、基线与写入根；已有改动不得覆盖、stash 或夹带。

单任务与 batch 使用同一落地顺序：

1. **stage** 在队列外核对任务归属、冻结源 HEAD、变更范围与远端地址；从本地 `refs/heads/develop` 快照建立 detached 候选。不 fetch，不要求主检出干净，也不移动主检出或远端。
2. 在队列外把冻结任务提交 no-ff 合入候选并完成按风险选择的必要验证（候选活动租约标识活性）。通过后把候选 SHA 保存到 `refs/vibe-harness/staged/<batch-id>`，返回 `integrationStatus: local_staged`；源 worktree、分支和主检出改动全部保留。
3. **publish** 重新解析唯一实际 push URL 与精确 `refs/heads/develop`，只以地址 SHA-256 指纹持久化；入口在队列外 fetch 精确远端并自动对账：候选已含于远端则直接确认集成，冻结源已全部集成则自动归档，远端前进则从新基线重建同一组合并候选并按完整输入指纹复用或重验，不在旧候选上叠加第二次 merge。
4. 对账确认基线未动时，publish 才取得仓库 FIFO 队首进入短时 finalize：核验远端 SHA、暂存引用、冻结源提交、事务租约和实际 push URL；不满足时按有界上限重建重验，不强制推送。
5. 在 finalize 段内以显式非强制 refspec 推送冻结候选 SHA 到精确远端 ref，并重读远端 SHA。候选等于远端 HEAD 或仍是其祖先时进入 `integrated`，记录 `remoteConfirmedHead` / `remoteAdvanced`；`remoteValidation` 独立表示远端 CI/MR 验证。
6. 推送确认后，在释放队首前尝试安全 ff-only 本地同步并将 `localRefSync` 记为 `updated`；否则记为 `deferred` 或 `diverged`，不得 stash、覆盖或提交用户改动。清理在队外使用独立有限执行时限；超时或失败返回成功并标记 `integrated_cleanup_pending`，重试只清理。

`--target-mode primary` 是 `stage` 专属的意图断言，其他子命令直接拒绝该参数；`remote` 已退役，任何写入前必须明确拒绝并提示迁移。`--base-ref develop` 是目标断言，不是分支切换。脏主检出只使本地同步 `deferred`，不阻塞远端发布。新流程的 `stage` 只产生 `local_staged`，必须经 `publish` 回读远端 SHA 才算完整交付。

恢复记录按 v4 保存在 Git common dir，增加 `queue`、`publishing`、
`recovery_required`、`reconcileHistory`、`verifyFailure`、`archive` 与
`archived_integrated` 等阶段字段，并继续读取 v1/v2/v3 后在下次安全
写入升级。记录绑定源 HEAD、冻结基线、候选 SHA、精确目标及阶段，不依赖
Linear Receipt。冲突、验证失败和 `push_uncertain` 先记录后继续；
stage 后源提交漂移必须重新 stage，publish 不得静默换成新提交。推送结果
不明先查询精确远端，确认候选已在远端时只继续清理，远端仍停在基线时可
有界重推原候选。远端前进与外部集成由 publish 的 fetch 自动对账推导：
已集成即确认，冻结源已全部集成即自动归档，无需 `--supersede` 或
`--archive-integrated` 仪式。远端分叉不 reset、rebase、
force push 或删除源。仍有交付事务的源工作区只能经对应
`stage`/`publish`/`status`/`discard` 恢复；通用 cleanup 不得绕过事务直接清理。旧版运行时不能读取 v4 事务，
升级前必须结束旧版交付进程。

交付状态分层报告：`commandStatus` 表示本次命令结论，`integrationStatus` 表示本地暂存或远端集成，`remoteValidation` 表示远端检查，`localRefSync` 表示主检出同步。只有远端 SHA 回读确认候选已到达远端才可写 `integrated`；候选已被后续远端提交覆盖但仍是祖先时按实际远端 HEAD 同步。本地暂存只能写 `local_staged`；推送结果不明时 `discard` 必须拒绝。

worktree 内部生命周期按本轮授权与本地 Git 事实核验，缺少宿主证明不阻塞已授权本地隔离和实现；跨边界、凭据、红区与外部写入按 governance-core。此模式不创建 PR/MR，不操作 main；Linear 仅在专用入口的当前计划范围同步。

### Source 分支生命周期

在提升（promotion）流程中，source 分支（发起 PR 或 MR 的分支）的生命周期应该明确定义，避免悬空或错误清理：

1. **创建阶段**：发起 PR/MR 时，source 分支由 develop flow 创建或指定
2. **验证阶段**：PR/MR 在目标分支上验证通过，可能需要多次推送迭代
3. **落地阶段**：PR/MR 合并落地后，source 分支的处理方式：
   - **Squash 模式**：source 分支可以保留（供历史参考）或手动删除
   - **非 Squash 模式**：source 分支保留在仓库中，作为历史记录的一部分
4. **清理策略**：
   - 不自动强删 source 分支（`git branch -D`）
   - 用户或 CI 可以在 PR/MR 关闭后手动选择删除
   - 对于 squash 落地，cleanup 配置保留分支而不删除

## 启动与归属

- 编辑前运行 `git status --short`，并只处理当前任务路径。
- 普通任务中，归属不清、任务开始前已存在或来自并发工作的改动都视为用户改动，不覆盖、不暂存、不提交。用户显式调用 `$vb-git-split-push` 时，默认分析并交付调用时已有的已暂存、未暂存和未跟踪修改，不因早于本次会话而重复确认归属；用户明确限定的范围优先。冻结起始清单与内容，明确排除项、并发新增或变化、敏感内容及生成垃圾仍保留，不混入提交。
- 仅在并发工作可能冲突、脏工作区与任务范围重叠、跨仓协作或明确需要独立构建与验证环境时使用独立 worktree；普通单 Agent 局部修复不因任务类型自动创建 worktree。
- 分批交付前再次检查 working tree 与 staged diff，明确包含、排除、验证、风险和回滚方式。

## 提交与推送边界

当前任务范围内的本地普通提交与当前分支普通推送无需独立授权，也无需逐项登记 effect 或任务级 Execution Envelope 证明；用户显式禁止时不得执行，已有有效 Envelope 的 `forbiddenEffects` 优先。`workspaceWrite`、`gitBranch`、`mergeRequestWrite`、`credentialUse` 仍按 `governance-core.md` 独立授权。

- 提交不自动触发推送，普通任务完成也不要求提交或推送；只有交付确需远端可见、目标明确且安全时才推送，两者都不隐含建分支、PR/MR、凭据转用或发布授权。
- Hook 只豁免直接、单一、可判定的 `git commit -m`／`git push`；复合命令、危险参数、无效 Envelope、远端或目标分支无法核实时不豁免，Hook 也不能推断暂存内容归属，提交前仍须人工核对本任务 diff。
- Vibe-Harness 不通过 Stop Hook、运行时脚本或默认流程自动执行 `git commit`／`git push`；`$vb-git-split-push` 是显式调用的分组提交与普通推送流程，不是唯一入口。
- split-push 从已核实 upstream 解析唯一实际 push URL 与精确 ref；无 upstream 仅在唯一 origin 且非保护目标时显式建立跟踪。冻结 SHA，用 `git push --no-force <actual-push-url> <sha>:<exact-ref>` 并重读远端 SHA；拒绝多地址、mirror 和目标不明。受管交付固定 `origin/develop`，不使用裸 push 或 upstream 推断。
- 显式 split-push 可直接在当前 `develop` 分组提交，不创建任务分支或 worktree，不逐组请求确认。本地提交完成后允许同步当前分支的精确远端目标：从实际 push URL fetch 精确 ref 并冻结 SHA；工作区及暂存区干净且无进行中的 merge/rebase 时，相等或本地领先则继续，纯落后用 `git merge --ff-only <remote-sha>`，分叉用 `git merge --no-edit <remote-sha>`。保留已有提交 SHA，不自动 rebase、stash、解决冲突或合入其他任务分支；无共同祖先、冲突或 Hook 拒绝时保留现场并停止。有排除项或并发改动只阻止同步及推送，不撤销已完成组。
- 同步改变最终树后，按本地交付与远端引入的影响面重新验证最终待推送快照；不能以同步前失效结果代替。远端前进导致明确的非快进拒绝时重新 fetch、同步、验证、推送，整个流程最多三轮；网络失败或结果不明先回读对账，不能证明则停止。回读同一地址的精确远端 SHA，与待推 SHA 相等或经祖先检查证明包含后才确认远端交付。
- main、master、release 与实际目标的保护/共享分支不得由 split-push 自动推送；不能仅凭当前分支名判断。develop 仍遵循项目实际保护策略，任何普通推送须核实精确目标；强推、远端删除和历史重写不在范围。
- 按需提交前须核对提交分组：验收点与建议 commit message、包含文件、排除文件、验证（命令及结果）、风险（低／中／高与理由）、回滚方式。
- 分批验证必须绑定当前批次的 staged snapshot：Git 命令固定已核对的仓库目录，每组暂存后运行 `git diff --cached --check`，仅工作树 `git diff --check` 不覆盖未暂存的新文件。提交前记录文件清单、staged tree 与 patch/blob 指纹并复核 staged diff。核对代码、检查脚本、测试登记及本地依赖都已进入该快照；未暂存的新文件不能支撑已暂存配置。验证命令读取工作树而非 index，须确认验证相关路径的工作树内容与 index 一致且不依赖组外未暂存内容；否则用补丁拆分或从 index 导出的隔离快照对齐验证对象，保留原工作树与 index。提交后记录 commit SHA；Hook、工作树或暂存区改变验证对象后，针对新快照重新检查和验证。
- 未提交不等于任务失败，应交付改动清单和验证证据；显式分组交付时只暂存纳入交付范围的明确文件或补丁，不混入原暂存区的排除项。先运行匹配每组影响面的必要验证，遵守项目必需检查，不因 Skill 调用额外固定启动全量验证，再按本节推送。必要验证失败或超时停止受影响提交；推送受阻仍分别报告分组 SHA、本地同步、验证结果和远端确认。已安装的 `vb-git-split-push` Skill 与本规则共享归属、验证和推送安全边界，修改须同步。

## 提交内容与信息

- 每个 commit 只承载一个逻辑变更；重构与功能变更默认拆开，提交后的状态应能通过该变更对应的聚焦检查。
- 分批提交前读取项目 Git 规范与 commitlint 配置；同一逻辑能力的代码、测试、配置和必要文档一起提交，不按 runtime/tests/docs 等文件类别机械拆组，紧密耦合且不能独立验证的修改合组。复用已有暂存先复核完整性。默认逐组提交、全部验证通过后统一推送；显式要求逐批推送时，每组验证并提交后推送，任一批失败即停止后续批次。
- 显式 split-push 对已明确定位、属于冻结交付范围的 EOF 空行、尾随空格或项目 formatter 纯格式问题，可保留语义最小修复，记录修复并仅重新暂存对应文件/补丁；重新检查快照及必要验证后，经原 Hook 重试提交一次。相同失败复发、发现并发变化、需要语义或范围决定、权限或安全策略拒绝、未知 Hook 拒绝、必要验证失败或超时时停止受影响步骤并保留现场。该恢复不允许禁用 Hook、改变策略或跳过验证。
- 提交主题使用 `<type>(<scope>): <描述>`，常用类型为 feat、fix、docs、refactor、test、chore 和 eval；项目配置 commitlint 时其配置是类型枚举、长度和大小写的唯一事实来源。
- 提交正文说明为什么改、影响面和被否决的方案；破坏性变更用 `feat!:` 或 `BREAKING CHANGE:` footer 显式声明，不靠正文措辞暗示。
- Issue 关联写进 PR/MR 描述与 `Refs <ISSUE-ID>` 等 trailer，closing magic word 不放进 commit；完整语义以 `linear-workflow.md`（若项目已安装该规则）为准。
- 不使用 `--no-verify` 绕过项目 Git Hook；唯一例外是 `worktree stage` 与 `worktree publish` 在隔离候选 worktree 内执行受管 merge 时显式禁用表单/Git Hook，避免改写共享依赖，该例外不推广到任何用户提交或推送。不添加未经确认的 `Co-authored-by`、`Signed-off-by` 或等价署名 trailer，需要标注 AI 参与时使用项目批准的 trailer，不伪造他人身份。
- 不把构建产物、依赖缓存、VCS 元数据、大体积二进制或用户未归属改动混入提交；行尾与二进制按 `.gitattributes` 处理，超大文件走 LFS 或外置存储。

## 分支模型与合并

分支模型、合并语义与门禁边界以本节为唯一规范来源；Linear 的 Issue 状态、Receipt 与分支命名绑定见 `linear-workflow.md`（若项目已安装该规则）。执行前核对实际远端分支、保护配置、required checks 和合并策略；不以文档声明代替已生效配置。发现不一致时先判定条款所属域，再修正漂移一侧。

- 默认分支模型：`feat/*、fix/* → develop → main`；紧急修复：`hotfix/* → main → develop`。该模型在项目显式建立对应分支后生效，尚未创建 `develop` 或迁移未完成的仓库以实际默认分支和已声明目标 ref 为准。
- 普通任务 PR 使用 squash merge；`develop → main` 的提升与 `main → develop` 的回同步使用 merge commit。squash 在目标分支生成的提交主题来自 PR/MR 标题，因此标题与提交主题使用同一 Conventional Commit 语法。
- `main` 只接受同仓库 `develop`、`hotfix/*` 和 release-please 的 PR，不使用长期 `release/*` 分支；目标项目已配置 `release/*` 时按其保护规则处理。
- 本仓库默认 `develop` 不配置服务器端 required gate；其他项目明确的审查和分支保护仍须遵守：稳定 fast gate 聚合检查不再作为集成分支的合并门禁，集成分支接受本地 `worktree stage`/`publish` 的 no-ff 直落与任务分支直推，质量责任由本地候选合并验证（lint、typecheck、unit，并按变更影响追加 component/integration）与提交前检查承担；发布边界继续使用完整 required CI。
- 普通任务 PR 仍可由 Writer 在 envelope 授权 `mergeRequestWrite` 后自行 squash merge；`Ready to Merge` 仍只用于带发布门禁目标。
- 合并前的本地验证必须建立在合并时的最新 `origin/develop` 之上；目标 ref 前进时重建最终候选，只重跑新输入失效的必要检查。独立审查可以观察和报告，但不构成普通 land 的收据门禁；目标分支平台保护及可信宿主授权仍独立生效。
- 不同写节点可在各自 worktree 并行实现与聚焦验证；共享契约只设一名 writer。目标 ref 最终化按短租约串行，Parent 只对最终组合行为做必要的 fan-in 验证，不重复每个只读节点的矩阵；远端 merge queue 未启用不得声称已有队列门禁。
- 显式 Linear Parent 批次默认一个 Writer、一个任务 worktree 和一个分支，以 Parent ID 归属；逐 Issue 形成经验证的本地 Conventional Commit，全部必需任务完成后以 Parent 最终 HEAD 作为唯一 source 统一 stage/publish，不逐任务推送。内部临时候选树仍可使用。若项目已安装该规则，范围变化确认、批内提交证据放行、批外依赖和 Done 规则见 `linear-workflow.md` 的「Parent 单 worktree 批次」；已有独立事务不自动迁移，共享树失败遗留改动保留现场。
- 紧急旁路必须有明确过期时间、授权人和审计记录；不得以 advisory、跳过检查或本地标记静默绕过 required gate。

## 分支与 PR/MR

- 默认分支名使用 `<type>/<short-topic>`（只用小写字母、数字和连字符）；Linear 工作流下使用 `<type>/<ISSUE-ID>-<slug>`，与项目 worktree 校验入口的分支命名校验一致；已有任务分支或用户指定分支优先。
- main、master、release 及其他仍受保护分支上的提交与推送遵循仓库保护和人工审批；`develop` 不在其列，可直推与直落。
- PR/MR 包含摘要、风险、验证、回滚和审查备注，高风险 PR/MR 引用 Planner 风险与必要自动验证结果；标题使用 `<type>(<scope>): <描述>`，因为 squash 合并用它生成目标分支上的提交主题。
- 单个 PR/MR 尽量只承载一个逻辑目的，超出可审查规模时拆分；确需一次交付的在描述中说明无法拆分的原因。
- Linear 工作流下必须给出可解析的精确目标远端 ref，只有解析结果确为仓库默认分支时才可写“默认分支”；开始实现前记录目标 ref 和 base SHA，分支与 worktree 必须从该基线创建。
- Linear 普通任务默认以 `origin/develop` 为基线，只有 hotfix 以 `origin/main` 为基线；发布提升和回同步使用 `Refs <ISSUE-ID>`，不得用 closing magic word 重复关闭已完成开发 Issue；普通任务 closing PR 合入 `develop` 即为 Done。
- 顺序执行且工作区干净时，任务分支可在当前 clone 创建；并发 Agent、脏工作区、存在无关改动或明确要求隔离时必须使用仓库外 worktree。普通 PR/MR 路径遵守“一任务一分支一 closing PR/MR”；显式 local-land 以 `stage` 的候选验证和 `publish` 的远端确认完成。
- 创建 PR/MR 前重新读取远端目标 ref 和 source HEAD，校验提供方所选 base 等于已声明目标 ref 并计算 merge-base：merge-base 必须等于冻结 base SHA，或是该 SHA 在同一目标 ref 历史上的已验证后代，否则停止创建并报告基线不一致。
- GitHub PR 与 GitLab MR 的标题、source、target、描述和 closing 语义都必须在创建后重读确认；Linear 分支与标题保留 Issue ID，closing 描述使用 `Fixes <ISSUE-ID>`，只有提供方配置并经重读确认的等价语法才可替代，closing 词不放进 commit。

## 同步与历史

- 只改写自己尚未推送的提交；共享分支上已推送的历史不得通过 rebase、amend 或 force push 修改。
- 需要同步尚未推送的分支时优先用 `--force-with-lease` 而不是 `--force`，推送前重新读取远端 SHA 确认没有被他人更新。
- 任务分支落后于目标 ref 时默认 rebase 到最新目标 ref；仓库明确要求 merge 同步时按其约定执行，并记录选择。
- 拉取更新使用 `--ff-only` 或 rebase，不用会产生隐式 merge commit 的默认 `git pull`；显式 split-push 按「提交与推送边界」使用精确 fetch 与显式 merge 同步当前远端目标。只读同步类命令（`git fetch`、`git ls-remote`、`git stash list`、`git submodule status`、带 `--ff-only` 的 `git pull`）由 hook 放行，`pull --ff-only` 额外要求跟踪工作区干净（脏工作区拒绝并报 `VIBE_HARNESS_SYNC_DIRTY_TREE`），裸 `git pull` 判为会写工作区的 `workspaceWrite`。
- 已推到共享分支的错误变更用 revert 加修复提交处理，保留可审计历史；不使用 reset、checkout 或历史改写抹掉已发布内容。

## 安全与敏感数据

- 密码、Secret、Token、Cookie、私钥和个人敏感数据不得进入提交、提交信息、PR/MR 描述、附件或 Git 历史；需要示例时使用占位值。
- 密钥检测分层执行：本地 Hook 扫描暂存内容，CI 与服务端保护各自独立扫描；客户端 Hook 可被绕过，本地扫描通过不作为密钥未泄露的证据。
- 发现凭据已进入历史时先轮换或吊销该凭据，再按单独授权清理历史和远端引用并通知受影响协作者；只删除文件后继续推送不算处理。
- Git credential helper 只可由其已配置的 Git transport 透明调用：仅有 Git transport 授权时不得读取、解析或转用 helper 输出进行网页或 API 登录，此类转换必须另有 `credentialUse` 与对应外部写入授权；Agent 不得把 helper 输出或原始凭据写入文件，credential query、包装脚本或其他辅助文件也不得写入仓库或 worktree。

## Git Hooks

- full profile 会安装项目级 pre-commit 和 pre-push 文件，但不修改本地或全局 Git 配置；是否启用 `core.hooksPath` 由用户决定。
- 项目可用 husky 或其他管理器激活同一批 Hook 脚本；本仓库以 `prepare: husky` 激活 pre-commit/pre-push 并叠加 lint-staged 与 commit-msg 校验，两套机制并存时以仓库实际运行的脚本为准，不重复维护逻辑。
- Hook 只承载快速、确定的本地检查（空白与冲突标记、暂存区密钥扫描、格式与 lint）；完整验证、跨平台矩阵和发布门禁由 CI 承担。
- 暂存区空白检查失败时报告安全的文件、行号和检查类别，保持非零退出；不输出 Git 附带的原始代码行或完整 diff。无法识别的错误保留拒绝，并指向仓库内的只读诊断命令。
- 客户端 Hook 可被本地用户绕过，强制策略应放在 CI 和服务端保护中。

## 参考实现边界

Vibe-Harness 自身使用 Conventional Commits、commitlint、pre-commit、pre-push、lint 和测试作为可审查的参考实现；这些检查在实际提交或推送时由 Git 正常触发，不构成自动执行提交或推送的指令。

## Worktree

- 一个隔离单元对应一个命名分支和明确写入范围，worktree 放在仓库外部、数量不是并行目标；宿主创建的 worktree 可用 `--task <id>:<branch>` 直接归因，`worktree bootstrap` 只作为无宿主管理或需要受管端口时的 fallback。不需要隔离时直接在当前工作区保护用户改动，子 Agent 只在分配的 worktree、分支和写入范围内工作，审查任务默认只读。
- 派发前明确目标分支、依赖和共享契约的唯一写入者；writeScope 或资源重叠的任务按依赖顺序推进，过期基线与语义冲突由任务责任人解决，集成失败只暂停相关任务和后继。
- 引导、审计、交付与清理走项目脚本入口 `node .agents/runtime/commands/run.mjs worktree <list|check|bootstrap|stage|publish|status|discard|cleanup|recover> --project . --json`：默认只读，只有追加 `--write` 才落盘；`cleanup` 在分支未并入 `worktree.baseRef` 或工作区不干净时拒绝，且从不删除分支；不带 `--write` 的 `bootstrap` 是步骤计划预览，`--help` 给出该入口自身的命令面说明。该入口是安装交付内唯一的 worktree 写入面（创建、依赖链接与清理）；源仓库开发面另有只读审计 CLI（`scripts/worktree.js`，`list|check|plan`），不随安装交付，目标项目不引入第二个写入口。
- `worktree stage` 在仓库 FIFO 外从本地 `refs/heads/develop` 快照建立并验证候选，随后持久化到 `refs/vibe-harness/staged/<batch-id>`，不 fetch、不要求主检出干净、不移动主检出；`worktree publish --batch <id>` 先在队列外 fetch 自动对账（已集成确认、冻结源已全部集成则自动归档、基线前进则重建并按指纹重验），基线未动才取得短时 FIFO 终锁完成精确推送与回读 SHA，释放后尝试安全本地同步；`status` 只读报告恢复事实，`discard` 只丢弃已确认未发布事务并保留源工作区，推送结果不明时不得丢弃。所有候选验证都实测所请求且实际选中的检查；验证不进入队列，也不持有仓库互斥锁。验证失败、冲突或结果不明时记录事务后继续，清理在队外执行；不得据此宣称集成/发布证据。普通推送不得强制更新。`--base-ref` 仅作意图断言，`--write --no-verify` 拒绝执行。
- 仅多个互不依赖任务已同时 ready 时，可向 `worktree stage` 传多个 `--task`；批次在一个候选中按序合并，冲突只在候选解决，最终组合树实测通过才暂存。单项和批量遵守同一候选判据；deferred 待后续检查，持久收据写入失败不改变实测结果。publish 遇到远端前进会重建候选并限定昂贵自动重试，失败、推送结果不明或清理失败保留可恢复现场。
- 临时候选 worktree 只在工作区干净时自动移除；异常残留由 `worktree recover` 只读盘点，`recover --all --write` 只回收无活动租约、归属明确且干净的票、事务候选与私有 ref，脏候选、`push_uncertain` 和无法判定对象继续保留。本地 FIFO 只保证单机单 Git common dir 的执行顺序，不能代替远端共享分支 required checks。
- 目录已消失但 Git 元数据与分支绑定仍在的 worktree 由 `worktree check` 报 `WORKTREE_PRUNABLE_RESIDUE` 并阻塞审计通过。`worktree recover --task <taskId> --write` 按序移除目标任务的不完整 worktree（端口 env 文件在位且登记在册时跳过，仅当分支未离开基线且工作区干净时连同分支与端口登记一起移除）、prunable 残留（一次 `git worktree prune`）、孤立分支与孤立端口登记；只有显式 `worktree recover --all --write` 才允许全局回收。分支删除只在存在归因证据（端口登记表条目或 prunable 清单）、分支 HEAD 等于 `worktree.baseRef` 解析出的基线 SHA 且该分支不是基线本身时发生，无引用的用户占位分支、带未并入提交的分支与登记面之外的外来 worktree 一律不动。该证据门不与「merge-back 完成前不删除分支」冲突（被删分支从未持有任何提交）；另一处分支删除只发生在 `publish` 推送成功之后，并使用自带未合并拒绝保险的 `git branch -d`。
- 依赖链接（`node_modules` junction 或 symlink）由 `worktree bootstrap` 建立并对每个本地包逐项 realpath 断言，断言失败时回滚本次新建的 worktree；`.bin`/`.bun`/`.pnpm` 等内容寻址 store 与各自带 `node_modules` 的 workspace 包由 overlay 投影，构建缓存 `.cache`/`.vite`/`.vite-temp` 跳过；`worktree check` 报告依赖链接缺失或指回主检出的事实。
- 多 worktree 并发时端口按登记表分段：`worktree.ports` 的 `base`、`blockSize`、`variables` 与 `envFile` 决定主检出保留 `[base, base+blockSize-1]`、第 n 个 worktree 占用 `[base+n*blockSize, base+(n+1)*blockSize-1]`、块内第 i 个变量取 `blockStart+i`；结果写主检出 `.vibe-harness/worktree-ports.json`，由 `.vibe-harness/worktree-ports.lock` 独占锁串行化，锁等待超时即 fail-closed 且不自动清理残留锁；端口冲突只按登记表与声明事实判定，不调用 `netstat`/`lsof` 推断分配。
- worktree 环境补齐是声明式的：`worktree.provision.setupCommands` 与 `envFiles` 由 `bootstrap` 按「worktree add →（主检出缺依赖时先 setup）→ 依赖链接 → 包级 overlay → 治理面镜像 → 端口与 env 文件 → 声明的 envFiles →（否则 setup）→ 工具链探针」执行，默认只出计划、追加 `--write` 才落盘，命中 `hooks.redZonePaths` 时还需 `--confirm-red-zone`。主检出缺少依赖（依赖根的 `node_modules` 不存在）时 `bootstrap` 以 `blocked` 结束并给出建议命令，仅当声明 `setupCommands` 时才允许 worktree 自行补齐依赖（此时 setup 先于依赖链接执行）；`worktree check` 只核对文件系统事实，不推断某条命令是否执行过。
- worktree 的治理面投影是声明式的：`worktree.mirrors` 的目录链接到主检出同名路径、文件在 worktree 侧缺失时从主检出复制一次，路径允许单段 `*` 通配（如 `frontend/internal/*/dist`），拒绝绝对路径、`..` 与空串。这用于投影被 `.gitignore` 忽略的 `.agents`、`.codex` 等治理配置；不隐含外部工具或索引管理。主检出没有的镜像项记为 `skipped` 而不使 bootstrap 失败；worktree 侧已存在的实体记为 `present` 且绝不覆盖，`worktree check` 对其报 `WORKTREE_MIRROR_STALE`；`mirrors` 缺失时按空投影处理。
- 镜像目录是链接而不是副本，复制型条目（`opencode.json`）留在 worktree 内由 Git 处理：移除 worktree 前必须先走 `worktree remove`/`publish`/`recover` 的 teardown（先删除镜像链接再 `git worktree remove`），不要对含链接的 worktree 直接递归删除——穿过 junction 会伤到主检出的 `.agents`。
- 安装交付的可执行入口（`.agents/runtime/hooks/*`、`tools/playwright-cli`、`runtime/evals/codex-runner.mjs`）按 **realpath** 判定自己是否为主模块：worktree 内经链接路径调用照常执行，只比较调用路径字符串会让 Hook 不给决策、工具入口空跑退出 0；新增入口沿用同一判定。
- worktree 内的写入只能由以该 worktree 为会话根（会话 cwd 即 worktree 根）的 Agent 完成；宿主边界策略的可写范围是项目根，主检出会话不得跨根写入 worktree，也不得以内联脚本、临时目录或改写路径触发方式绕过宿主边界。
- merge-back 完成前不清理 worktree 或删除分支，闭环回收按 `worktree publish` 的顺序执行（远端确认先于清理，分支删除仅在推送成功后）；清理前确认无未提交改动，先 `git worktree remove` 再 `git worktree prune`，清单以 `git worktree list --porcelain -z` 为准。

## 完成定义

- 本次任务按已授权交付边界结束；本地实现可在最终验证后交付，未合并的 worktree 只阻止宣称“已集成”。
- 只有精确远端 SHA 回读确认了经过最终组合树验证的候选已到达远端时，才能宣称“已集成”；`worktree publish` 的 `integrationStatus: integrated`、候选 SHA 与可选 `remoteConfirmedHead` 是该状态的机读证据。`local_staged`、本地同步延迟或清理残留都不能替代远端确认。存在未解释改动时不得宣称相应交付边界已完成。
- 工具不可用时只给出分组清单和命令建议，不声称已经提交、推送或合并。

## 禁止项

- 不使用 `git reset --hard`、`git checkout --` 或破坏性清理覆盖用户改动，除非用户明确要求。
- 不用 force push、历史改写或远端引用删除去修复共享分支上已推送的历史。
- 不以时间间隔、文件行数、变更数量或工具调用边界触发提交。
- 本地孤立分支或未合并 worktree 可以支撑已验证的本地交付，但不能据此宣称已集成、推送或发布；未验证 commit 不支撑对应完成主张。

声明式候选资源采用独立工作区身份、端口块、命名空间与缓存目录。setup/teardown 成对声明且以资源身份和步骤键幂等；具名资源只在相关检查执行时加锁，repo-heavy 只是成本提示。已集成事务可用 `worktree cleanup --batch <id>` 预览，追加 `--write` 重试清理。清理残留保留归属；同一终态重试不 merge、不验证、不 push。

受管推送在发布队列外核对完整输入，原生 pre-push 消费同机同用户认证的单次 SHA/ref/目标证明；证明失效时释放队列后补证。普通 push 在精确待推提交的干净工作区验证。只有显式 deterministic 且代码、依赖实际内容、配置、运行器、环境及资源上下文匹配时复用；外部可变状态默认不复用。最终候选可覆盖 Parent fan-in，子任务自报不能替代组合验证。

显式 Parent 批次的 publish 在远端确认后保留源任务 worktree、分支、锚点与资源归属，报告 `integrated_cleanup_pending`。逐项确认子任务及 Parent Done 后调用已有 `worktree cleanup --batch <id> --write`；状态回写失败只补写缺失状态，publish 重试不重复推送，也不提前清理源任务树。该顺序只适用于声明了批次上下文的来源，普通交付清理保持原语义。
