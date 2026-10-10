# 交付生命周期与兼容迁移

状态：Implemented

## 配置

```json
{
  "delivery": {
    "default": "managed-mr",
    "profiles": {
      "managed-mr": { "merge": "squash", "cleanup": "evidence-compatible", "requireReceipt": true },
      "local-land": { "merge": "no-ff", "cleanup": "ancestor", "requireReceipt": true },
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

## 收据与 squash

`verify --delivery managed-mr --plan` 预览命令；实际验证输出 completion 草稿且 stage=verify。调用者将 MR、浏览器、数据库等真实验收补入 acceptance；不能删除仍未通过的必需项。完成收据必须包含 status、delivery.profile/stage、非空 acceptance（id/status/command 或 criterion/scope）、unverified、remainingRisks、rollback、source/target HEAD 或指纹、verification。

完成检查为 `task check <id> --complete --receipt <file> --delivery <profile>`。worktree cleanup 使用同一判据，另验证干净树和当前 source 指纹。新模式不接受缺收据；旧任务缺收据只 warning，不重写历史。

merge evidence 的必需字段：sourceBase、sourceHead、targetRef、targetBefore、targetAfter、mergeMethod、mergeCommit、patchId、taskId。单父 squash commit 的父必须等于 targetBefore，目标 ref 必须仍等于 targetAfter，sourceBase 必须是完整 source 分支的共同基点，source 与合入补丁 stable patch-id 一致；目标推进后必须重新采集证据，不能忽略漂移。`--mr <iid>` 通过已安装的 glab 只读获取，不 fetch/push、不传入或保存令牌。

收据复用除 Git 内容、命令集、环境外还记录 tracked/非忽略文件的 mtime/ctime/size 写入指纹；同内容重写也使旧收据失效。忽略的运行产物不纳入工作树完成证据；命令声明仍应显式覆盖相关外部依赖。

## 恢复

`task checkpoint <id> --reason <text> [--write]` 默认 dry-run；持久内容包括 at/reason/headSha/worktree/stage/activeUnits/blockers/nextAction、工作树 fingerprint 与最后验证。

`task event <id> --reason pre-compaction|resume|continue|pre-delivery|pre-verify [--write]` 接收可观察宿主事件；continue 第二次才记录，resume 先核对当前状态，漂移 blocked，核对之后显式 checkpoint。verify 与指定 task 的 land 在受管入口自动 checkpoint。宿主没有暴露压缩或用户消息 hook 时，这些事件必须由 Agent/宿主桥接显式投递，不假设平台具备后台监听。

## 服务归属

`runtime service start --service <id> [--port <n>] --write` 使用登记端口（或显式端口），`status` 只读，`stop --write` 停止服务。主检出的 `.vibe-harness/processes.json` 记录 task/service/PID/worktree/port/startedAt/fingerprint/status/teardownStatus 与 supervisor 端点。registry 使用排他锁和原子替换；不跟随 registry 链接。只有实际启动的 supervisor 可持有子进程归属，stop 核对 PID、cwd、fingerprint、启动时间，不因 registry 写了一个 PID 就直接 kill。

健康探测仅 loopback HTTP，不跟随重定向。服务异常退出或 supervisor 不可达时 fail closed，不把“根 PID 不存在”当作所有后代已停止。stopOnTeardown=false 的活跃服务会阻止工作区清理，不静默留下进程。当前不提供 daemon 自动重启、凭据注入或任意进程发现。

## 迁移与回滚

先 dry-run 安装与配置校验，再于隔离 fixture/试点中验证。旧项目升级不会自动添加 delivery、续期例外或改变合并策略。移除新增 delivery 配置可回到旧模式，但不能借此把既有 blocked 验收改判通过。回滚实现需按本轮 diff 逐块撤销，保留其他未提交修改；已合并业务补丁依据实际 merge commit revert。
