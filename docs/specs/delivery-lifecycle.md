# 交付生命周期与兼容迁移

状态：Implemented

## 本地 Worktree 合并

显式 `vb-git-develop-flow` 与 `vb-linear-worktree-develop` 使用 local-land：任务完成阶段验证，提交与合并阶段不重复质量验证，不访问远端，不推送。

1. 先核对源分支、HEAD、任务范围与干净工作树；主检出必须在本地 `develop`，不自动切换分支。
2. `worktree stage --task <id>:<branch> --base-ref develop --write` 记录事务和合并前 HEAD。dirty develop 自动 `git add -A` 并提交 `chore(worktree): checkpoint local develop before merge`，然后执行 no-ff 本地合并。
3. 冲突保留在主检出，解决并暂存后用 `stage --resume <id> --write` 完成 merge commit；不通过禁用 Hook 绕过安全拒绝。
4. 成功记录 `localMergeCommit` 与 `localIntegrated: true`。只自动清理 Harness 创建且归属明确、干净、分支 HEAD 未漂移并已合入的源树和分支；宿主、用户及未知归属资源保留。
5. 清理失败报告 `local_integrated_cleanup_pending`，不撤销合并。`cleanup --batch <id> --write` 只重试清理，不再次合并或验证。

`status --batch <id>` 只读展示本地 HEAD、冲突与清理。`discard --batch <id> --write` 只安全中止当前未完成合并，保留 checkpoint 和已完成提交，不 reset。仓库级短时锁串行化本地变更；冲突编辑期间不持锁，未完成事务阻止新事务抢占。

事务 v6 保存在 Git common dir。旧远端事务只读展示、恢复冲突或安全丢弃，提示“旧远端事务需迁移”，不自动访问远端。原有普通 push 与 `vb-git-split-push` 不受此本地模式改造。

显式 Parent 批次以 Parent ID 为唯一 source；全部必需成员先逐项验证和提交。本地事务保留成员提交映射，`task check --complete` 核对这些提交和 `localMergeCommit` 已是本地 develop 的祖先，返回 `deliveryStatus: local_integrated`，源树清理后仍可读取。若项目已安装该规则，Linear 写后确认、超时重读与失败恢复见 `linear-workflow.md`。

完成表述统一为“本地已合并，不代表远端已推送”；后续推送须独立显式执行。

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

`reviewPolicy` 只取 `required` 或 `none`。内置及自定义 `local-land` 配置未声明该字段时按 `none` 处理；其他 profile 未声明时仍按 `required`。验证入口的 `--reviewed` 是观察元数据，不参与本地 stage。项目明确规定的审批、Hook 与分支保护继续独立生效。

## 收据与 squash

`verify --delivery managed-mr --plan` 预览命令。需要 completion receipt 的显式消费者仍可读取 stage=verify 的草稿并补入 MR、浏览器、数据库等真实验收；不能删除仍未通过的必需项。收据包含 status、delivery.profile/stage、非空 acceptance（id/status/command 或 criterion/scope）、unverified、remainingRisks、rollback、source/target HEAD 或指纹、verification。

任务锚点使用短时锁、读取版本比较和原子替换；冲突时重读后重试，不覆盖新状态。前一有效快照保存在同路径 `.previous`，恢复时先核对真实工作区，不能据旧快照重放结果不明的外部操作。计划文本 revision 与合同 digest 分开：围栏外独立单行 HTML 说明注释不撤销证据，单元合同绑定共享正文、范围、对应验收及递归前驱。plan-sync 保留认证历史，只对合同变化的单元及消费者撤销历史放行；无法归属的共享正文变化保守扩大，检查定义变化仍失效，不改写旧收据。

merge evidence 的必需字段：sourceBase、sourceHead、targetRef、targetBefore、targetAfter、mergeMethod、mergeCommit、patchId、taskId。单父 squash commit 的父必须等于 targetBefore，目标 ref 必须仍等于 targetAfter，sourceBase 必须是完整 source 分支的共同基点，source 与合入补丁 stable patch-id 一致；目标推进后必须重新采集证据，不能忽略漂移。`--mr <iid>` 通过已安装的 glab 只读获取，不 fetch/push、不传入或保存令牌。

收据复用除 Git 内容、命令集、环境外还记录 tracked/非忽略文件的 mtime/ctime/size 写入指纹；同内容重写也使旧收据失效。忽略的运行产物不纳入工作树完成证据；命令声明仍应显式覆盖相关外部依赖。

## 恢复

### Parent 批次执行契约

`plan-units` 可选 `executionBatch`：`parentId`、全部必需叶子/聚合单元 ID 的 `members`、绝对 `worktree`、任务 `branch`、精确 `targetRef`（`refs/heads/develop`）及冻结的 `baseSha`。成员与执行单元一一对应，单元默认 `kind=write`；read/aggregate 可声明空 files，不造空提交。外部依赖使用 `externalDependencies` 的 `{id, dependsOn, result}` 快照，执行前由调用方读取 Linear 原生关系核实完整性；本地运行时不能替代实时 provider 证据。跨批交付循环、未知依赖、跨目标或非法成员 fail-closed。

可选 Task DAG 的顶层 `executionBatch: {parentId, worktree}` 引用同一锚点，CLI 从真实工作区取得证据，直接输入的 localCompletion/通过标记不能代替检查。成员的 kind、Scope 和原生依赖投影须与计划一致；保持 result 枚举，all_done、批外依赖和 Parent aggregate 不使用本地放行。批次摘要加入结构哈希；无批次输入保留旧哈希与语义，不强制单 Agent 创建 DAG。

`task checkpoint <id> --reason <text> [--write]` 默认 dry-run；持久内容包括 at/reason/headSha/worktree/stage/activeUnits/blockers/nextAction、工作树 fingerprint 与最后验证。

`task event <id> --reason pre-compaction|resume|continue|pre-delivery|pre-verify [--write]` 接收可观察宿主事件；continue 第二次才记录，resume 先核对当前状态，漂移 blocked，核对之后显式 checkpoint。verify 在受管入口尝试 checkpoint，失败只告警且不重跑验证命令。宿主没有暴露压缩或用户消息 hook 时，这些事件必须由 Agent/宿主桥接显式投递，不假设平台具备后台监听。

## 服务归属

`runtime service start --service <id> [--port <n>] --write` 使用登记端口（或显式端口），`status` 只读，`stop --write` 停止服务。主检出的 `.vibe-harness/processes.json` 记录 task/service/PID/worktree/port/startedAt/fingerprint/status/teardownStatus 与 supervisor 端点。registry 使用排他锁和原子替换；不跟随 registry 链接。只有实际启动的 supervisor 可持有子进程归属，stop 核对 PID、cwd、fingerprint、启动时间，不因 registry 写了一个 PID 就直接 kill。

supervisor 的生命周期为 `starting → running → stopping → stopped`；停止证明不足时进入 `blocked`，具备同一归属证明的重试可再次进入 `stopping`。启动身份采集和端点建立之间发生退出时，必须终结启动握手，不能由较早的启动续体重新发布 `running`。并发停止共享同一次清理；`stopping` 表示清理仍在进行，不等于归属不匹配或已经停止。

停止开始后不再启动成员采样，先等待在途采样结束，将最后的成员身份纳入进程树证明，并释放采样进程对 Windows 工作目录的占用，再发送终态。活动服务的 Windows 停止证明同时检查进程树与端口释放。已经确认停止的历史登记则只复核其记录的进程身份，不连接可能被重新占用的旧端点，不把新服务占用同一端口或复用 PID 误认成旧服务存活；真实旧进程仍存活或证据不可读时仍保持 `blocked`。恢复成功后清除旧失败原因。

生命周期回归以实际退出、身份采集屏障和成员采样屏障控制时序，不依赖固定等待时间。失败记录应区分启动失败、清理中、归属拒绝与进程树残留，诊断不得输出控制令牌。

## 迁移与回滚

先 dry-run 安装与配置校验，再于隔离 fixture/试点中验证。旧项目升级不会自动添加 delivery、续期例外或改变合并策略。移除新增 delivery 配置可回到旧模式，但不能借此把既有 blocked 验收改判通过。回滚实现需按本轮 diff 逐块撤销，保留其他未提交修改；已合并业务补丁依据实际 merge commit revert。

本地事务 v6、创建归属、旧事务边界与安装回滚见 [worktree-collaboration-migration](worktree-collaboration-migration.md)。终态事务保留成员提交映射；清理重试不再合并，也不执行远端动作。
