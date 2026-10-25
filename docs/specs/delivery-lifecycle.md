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

`task check <id> --complete --receipt <file> --delivery <profile>` 仍是显式收据消费者可调用的检查，但普通 local-land 不要求 Receipt。新 local-land 流程分为 `worktree stage` 与 `worktree publish --batch <id>`，两者以及兼容 `land` 共用 Git common dir 下的仓库级 FIFO。stage 在队首产生验证过的 `local_staged` 私有引用，不 fetch、不移动主检出，完成后释放队列；publish 作为新请求重新排队，基于最新远端基线重建、验证、精确推送并在释放前完成安全本地同步，只有远端 SHA 回读确认候选到达远端才写 `integrated`。若另一发布在回读前继续推进目标，只要候选仍为精确远端 HEAD 的祖先，就记录实际 `remoteConfirmedHead` 与 `remoteAdvanced`，不误报分叉。主检出同步单列 `localRefSync`，清理失败单列 `integrated_cleanup_pending`。旧 `land --push` 复用同一发布器，脏主检出只延迟本地同步。

事务报告区分 `commandStatus`、`integrationStatus`、`remoteValidation` 与 `localRefSync`。`worktree status --batch <id>` 只读恢复，`discard` 只允许回收已确认未发布事务，推送结果不明时必须先核实远端或重试发布；v2 状态仅保存远端 ref、确认 HEAD 与 URL 指纹，不保存原始 push URL。事务 schema 见 [worktree-transaction.schema.json](../../schemas/worktree-transaction.schema.json)。

merge evidence 的必需字段：sourceBase、sourceHead、targetRef、targetBefore、targetAfter、mergeMethod、mergeCommit、patchId、taskId。单父 squash commit 的父必须等于 targetBefore，目标 ref 必须仍等于 targetAfter，sourceBase 必须是完整 source 分支的共同基点，source 与合入补丁 stable patch-id 一致；目标推进后必须重新采集证据，不能忽略漂移。`--mr <iid>` 通过已安装的 glab 只读获取，不 fetch/push、不传入或保存令牌。

收据复用除 Git 内容、命令集、环境外还记录 tracked/非忽略文件的 mtime/ctime/size 写入指纹；同内容重写也使旧收据失效。忽略的运行产物不纳入工作树完成证据；命令声明仍应显式覆盖相关外部依赖。

`worktree stage` 与兼容 `land` 使用 `reuse:true`，按代码树内容复用已通过的逐检查确定性证据；`--reviewed` 只记录本次检查的观察结果，不继承旧收据且不阻塞交付。候选 worktree 的受管 merge 使用空 hooks path、`LEFTHOOK=0`、`HUSKY=0` 和 `--no-verify`，避免表单/Git Hook 改写共享依赖。从创建候选与第一个受管 merge 开始，候选验证、共享 ref 更新、push 和本地 ff-only 同步共享同一仓库 FIFO；`deep`、`resourceClass: "repo-heavy"` 与 `mvn/gradle` 兼容识别均进入该队列，交付事务内的验证借用当前队首租约以避免死锁。stage/publish 预检检测基线漂移、残留 candidate、依赖根与 junction 完整性，并报告 setup/merge/verify/push/local-sync/cleanup/total 与逐检查耗时。

## 恢复

`task checkpoint <id> --reason <text> [--write]` 默认 dry-run；持久内容包括 at/reason/headSha/worktree/stage/activeUnits/blockers/nextAction、工作树 fingerprint 与最后验证。

`task event <id> --reason pre-compaction|resume|continue|pre-delivery|pre-verify [--write]` 接收可观察宿主事件；continue 第二次才记录，resume 先核对当前状态，漂移 blocked，核对之后显式 checkpoint。verify 与指定 task 的 land 在受管入口尝试 checkpoint，失败只告警且不重跑验证命令。宿主没有暴露压缩或用户消息 hook 时，这些事件必须由 Agent/宿主桥接显式投递，不假设平台具备后台监听。

## 服务归属

`runtime service start --service <id> [--port <n>] --write` 使用登记端口（或显式端口），`status` 只读，`stop --write` 停止服务。主检出的 `.vibe-harness/processes.json` 记录 task/service/PID/worktree/port/startedAt/fingerprint/status/teardownStatus 与 supervisor 端点。registry 使用排他锁和原子替换；不跟随 registry 链接。只有实际启动的 supervisor 可持有子进程归属，stop 核对 PID、cwd、fingerprint、启动时间，不因 registry 写了一个 PID 就直接 kill。

健康探测仅 loopback HTTP，不跟随重定向。`stop`/`status` 对无法证明归属的服务 fail closed，不把“根 PID 不存在”当作所有后代已停止。`worktree stage`/`publish`、兼容 `worktree land`、`worktree cleanup` 与 `worktree recover` 的服务 teardown 是 best-effort：仍尝试按登记停止服务，但无法证明停止不再阻止候选暂存、发布或工作区移除，结果写入对应步骤与结果项的 `services` 字段供人工核对。当前不提供 daemon 自动重启、凭据注入或任意进程发现。

## 迁移与回滚

先 dry-run 安装与配置校验，再于隔离 fixture/试点中验证。旧项目升级不会自动添加 delivery、续期例外或改变合并策略。移除新增 delivery 配置可回到旧模式，但不能借此把既有 blocked 验收改判通过。回滚实现需按本轮 diff 逐块撤销，保留其他未提交修改；已合并业务补丁依据实际 merge commit revert。
