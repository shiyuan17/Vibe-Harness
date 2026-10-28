# 交付生命周期与兼容迁移

状态：Implemented

## 配置

```json
{
  "delivery": {
    "default": "managed-mr",
    "profiles": {
      "managed-mr": { "merge": "squash", "cleanup": "evidence-compatible", "requireReceipt": false, "reviewPolicy": "required" },
      "local-land": { "merge": "no-ff", "cleanup": "ancestor", "requireReceipt": false, "reviewPolicy": "none" },
      "inspect-only": { "write": false, "requireReceipt": false }
    }
  },
  "worktree": {
    "provision": {
      "services": [
        { "id": "frontend", "command": "bun run dev", "cwd": "frontend", "healthcheck": "http://localhost:${PORT}", "stopOnTeardown": true }
      ]
    }
  },
  "projectRules": {
    "mode": "auto",
    "exceptions": [
      { "id": "review-shadow" }
    ]
  }
}
```

例外仅有 id 时故意为 stale。owner 必须由项目批准者确认；approvedAt/expiresAt 是实际批准和到期时间，reviewCadence、rollbackCondition、successMetric 是人工复核口径。不填虚构的批准值使门禁变绿。

`reviewPolicy` 只取 `required` 或 `none`。内置及自定义 `local-land` 配置未声明该字段时按 `none` 处理，不回落到旧版的 `required`；其他 profile 未声明时仍按 `required`。`--reviewed` 在普通 local-land 中只记录调用者查看了哪些验证项，不阻塞 land；项目明确规定的审查、必需审批、Hook 与分支保护继续独立生效。需要兼容旧收据的消费者仍可读取 `status:"not_required"`、`reasonCode:"REVIEW_NOT_REQUIRED"`，但不得把它伪装成 `relevant`。

## 收据与 squash

`verify --delivery managed-mr --plan` 预览命令。需要 completion receipt 的显式消费者仍可读取 stage=verify 的草稿并补入 MR、浏览器、数据库等真实验收；不能删除仍未通过的必需项。收据包含 status、delivery.profile/stage、非空 acceptance（id/status/command 或 criterion/scope）、unverified、remainingRisks、rollback、source/target HEAD 或指纹、verification。

`task check --receipt` 已退役并明确拒绝；普通任务不要求 completion JSON。已有锚点用 `task update --verification` 登记真实 verify 报告，完成检查核对认证来源、当前内容与写指纹、检查集合及计划绑定；整任务还核对计划全集，局部完成不替代整体完成。新 local-land 流程分为 `worktree stage` 与 `worktree publish --batch <id>`：stage 在仓库 FIFO 外从本地 develop 快照产生验证过的 `local_staged` 私有引用，不 fetch、不移动主检出；publish 入口先 fetch 自动对账——候选已含于远端则确认集成，冻结源已全部集成则自动写入 `archived_integrated`，远端前进则从新基线重建并按完整输入指纹复用或重验（有界重试）——基线未动才取得短时 FIFO 终锁，精确推送并在释放后尝试安全本地同步，只有远端 SHA 回读确认候选到达远端才写 `integrated`。若另一发布在回读前继续推进目标，只要候选仍为精确远端 HEAD 的祖先，就记录实际 `remoteConfirmedHead` 与 `remoteAdvanced`，不误报分叉。主检出同步单列 `localRefSync`，清理失败单列 `integrated_cleanup_pending`，脏主检出只延迟本地同步。

任务锚点使用短时锁、读取版本比较和原子替换；冲突时重读后重试，不覆盖新状态。前一有效快照保存在同路径 `.previous`，恢复时先核对真实工作区，不能据旧快照重放结果不明的外部操作。计划文本 revision 与合同 digest 分开：围栏外独立单行 HTML 说明注释不撤销证据，单元合同绑定共享正文、范围、对应验收及递归前驱。plan-sync 保留认证历史，只对合同变化的单元及消费者撤销历史放行；无法归属的共享正文变化保守扩大，检查定义变化仍失效，不改写旧收据。

事务报告区分 `commandStatus`、`integrationStatus`、`remoteValidation` 与 `localRefSync`。`worktree status --batch <id>` 只读恢复，`discard` 只允许回收已确认未发布事务，推送结果不明时必须先核实远端或重试发布；v5 状态仅保存远端 ref、确认 HEAD 与 URL 指纹，不保存原始 push URL。事务 schema 见 [worktree-transaction.schema.json](../../schemas/worktree-transaction.schema.json)。

merge evidence 的必需字段：sourceBase、sourceHead、targetRef、targetBefore、targetAfter、mergeMethod、mergeCommit、patchId、taskId。单父 squash commit 的父必须等于 targetBefore，目标 ref 必须仍等于 targetAfter，sourceBase 必须是完整 source 分支的共同基点，source 与合入补丁 stable patch-id 一致；目标推进后必须重新采集证据，不能忽略漂移。`--mr <iid>` 通过已安装的 glab 只读获取，不 fetch/push、不传入或保存令牌。

收据复用除 Git 内容、命令集、环境外还记录 tracked/非忽略文件的 mtime/ctime/size 写入指纹；同内容重写也使旧收据失效。忽略的运行产物不纳入工作树完成证据；命令声明仍应显式覆盖相关外部依赖。

`worktree stage` 与 `worktree publish` 使用 `reuse:true`，但跨树逐检查复用须显式启用 tree-content 与 deterministic，且整树、命令、配置、工具链和环境等完整输入指纹一致；`--reviewed` 只记录本次检查的观察结果，不继承旧收据且不阻塞交付。候选 worktree 的受管 merge 使用空 hooks path、`LEFTHOOK=0`、`HUSKY=0` 和 `--no-verify`，避免表单/Git Hook 改写共享依赖。候选构建、验证与清理全部在仓库 FIFO 外执行，验证持有带心跳续期的候选活动租约；只有 publish 的短时 finalize 段（共享 ref 更新、非强制 push 与远端回读）持有队首租约，交付事务内的验证不再借用队列租约；`deep` 与 `resourceClass: "repo-heavy"` 声明的重型检查在候选内执行，不进入队列。仅同目标已包含全部冻结源的冗余候选才接收协作取消请求；独立任务不因基线前进被取消，活租约由原持有者释放。原生 pre-push Hook 与网络仍可延长 finalize，不能承诺固定秒级耗时。stage/publish 预检检测基线漂移、残留 candidate、依赖根与 junction 完整性，并报告 setup/merge/verify/push/local-sync/cleanup/total 与逐检查耗时。

## 恢复

### Parent 批次执行契约

`plan-units` 可选 `executionBatch`：`parentId`、全部必需叶子/聚合单元 ID 的 `members`、绝对 `worktree`、任务 `branch`、精确 `targetRef`（`refs/heads/develop`）及冻结的 `baseSha`。成员与执行单元一一对应，单元默认 `kind=write`；read/aggregate 可声明空 files，不造空提交。外部依赖使用 `externalDependencies` 的 `{id, dependsOn, result}` 快照，执行前由调用方读取 Linear 原生关系核实完整性；本地运行时不能替代实时 provider 证据。跨批交付循环、未知依赖、跨目标或非法成员 fail-closed。

既有 `task init --plan-file` 绑定批次；`task update --unit --verification --unit-status <id>:done` 在提交后校验验证收据与提交树，写入单元 `localCompletion`（commit/tree、历史 commits、计划及成员摘要、检查定义摘要和认证收据）。验证时仅完整暂存或干净快照可产生 `verifiedTree`；Hook 改树、未暂存或未跟踪内容不能被桥接为提交证据。`task check --dispatch` 接受同批祖先提交的有效证据，`--complete` 还要求现有 publish 事务的远端确认；锚点 done 不意味着 Linear Done。计划任何修订会保守使旧计划绑定失效，确认原因并 plan-sync 后重新核验相关任务，不自动迁移活动独立事务。

可选 Task DAG 的顶层 `executionBatch: {parentId, worktree}` 引用同一锚点，CLI 从真实工作区取得证据，直接输入的 localCompletion/通过标记不能代替检查。成员的 kind、Scope 和原生依赖投影须与计划一致；保持 result 枚举，all_done、批外依赖和 Parent aggregate 不使用本地放行。批次摘要加入结构哈希；无批次输入保留旧哈希与语义，不强制单 Agent 创建 DAG。

stage 只接受 Parent 唯一 source，所有成员已本地完成且分支的非合并提交均有 Issue 归属；事务 source 和 integration tasks 附带 Parent、成员、计划摘要及 Issue→提交映射。publish 再检查计划、成员与冻结源，范围变更阻断后续发布并保留事务。最终候选验证负责整批组合；Linear 回写由调用方在远端确认后逐项幂等完成，运行时不引入 Linear 客户端或第二状态库。该变更是可选契约扩展，无批次旧计划和独立交付事务不迁移。

Parent 批次 publish 确认远端后只清理内部候选，保留源任务树、分支、任务锚点和端口归属，状态为 `integrated_cleanup_pending`；同一 publish 重试也不提前回收。调用方逐项重读并补齐子任务及 Parent Done 后，显式调用已有 `worktree cleanup --batch <id> --write`；失败保留现场，仅重试清理。普通非批次事务继续按原流程清理。该顺序不引入新的 Linear 状态真值或完成凭证，实时回写确认仍由调用方负责。

`task checkpoint <id> --reason <text> [--write]` 默认 dry-run；持久内容包括 at/reason/headSha/worktree/stage/activeUnits/blockers/nextAction、工作树 fingerprint 与最后验证。

`task event <id> --reason pre-compaction|resume|continue|pre-delivery|pre-verify [--write]` 接收可观察宿主事件；continue 第二次才记录，resume 先核对当前状态，漂移 blocked，核对之后显式 checkpoint。verify 与指定 task 的 land 在受管入口尝试 checkpoint，失败只告警且不重跑验证命令。宿主没有暴露压缩或用户消息 hook 时，这些事件必须由 Agent/宿主桥接显式投递，不假设平台具备后台监听。

## 服务归属

`runtime service start --service <id> [--port <n>] --write` 使用登记端口（或显式端口），`status` 只读，`stop --write` 停止服务。主检出的 `.vibe-harness/processes.json` 记录 task/service/PID/worktree/port/startedAt/fingerprint/status/teardownStatus 与 supervisor 端点。registry 使用排他锁和原子替换；不跟随 registry 链接。只有实际启动的 supervisor 可持有子进程归属，stop 核对 PID、cwd、fingerprint、启动时间，不因 registry 写了一个 PID 就直接 kill。

健康探测仅 loopback HTTP，不跟随重定向。`stop`/`status` 对无法证明归属的服务 fail closed，不把“根 PID 不存在”当作所有后代已停止。`worktree stage`/`publish`、`worktree cleanup` 与 `worktree recover` 的服务 teardown 是 best-effort：仍尝试按登记停止服务，但无法证明停止不再阻止候选暂存、发布或工作区移除，结果写入对应步骤与结果项的 `services` 字段供人工核对。当前不提供 daemon 自动重启、凭据注入或任意进程发现。

supervisor 的生命周期为 `starting → running → stopping → stopped`；停止证明不足时进入 `blocked`，具备同一归属证明的重试可再次进入 `stopping`。启动身份采集和端点建立之间发生退出时，必须终结启动握手，不能由较早的启动续体重新发布 `running`。并发停止共享同一次清理；`stopping` 表示清理仍在进行，不等于归属不匹配或已经停止。

停止开始后不再启动成员采样，先等待在途采样结束，将最后的成员身份纳入进程树证明，并释放采样进程对 Windows 工作目录的占用，再发送终态。活动服务的 Windows 停止证明同时检查进程树与端口释放。已经确认停止的历史登记则只复核其记录的进程身份，不连接可能被重新占用的旧端点，不把新服务占用同一端口或复用 PID 误认成旧服务存活；真实旧进程仍存活或证据不可读时仍保持 `blocked`。恢复成功后清除旧失败原因。

生命周期回归以实际退出、身份采集屏障和成员采样屏障控制时序，不依赖固定等待时间。失败记录应区分启动失败、清理中、归属拒绝与进程树残留，诊断不得输出控制令牌。

## 迁移与回滚

先 dry-run 安装与配置校验，再于隔离 fixture/试点中验证。旧项目升级不会自动添加 delivery、续期例外或改变合并策略。移除新增 delivery 配置可回到旧模式，但不能借此把既有 blocked 验收改判通过。回滚实现需按本轮 diff 逐块撤销，保留其他未提交修改；已合并业务补丁依据实际 merge commit revert。

候选资源、认证证明、v6 缓存和 batch cleanup 的字段、迁移与回滚见 [worktree-collaboration-migration](worktree-collaboration-migration.md)。stage 后保留候选环境以支持原生 pre-push 精确对象证据消费；终态事务保留，重试只清理。
