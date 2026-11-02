---
name: vb-linear-worktree-develop
description: Use only when explicitly requested as Vb Linear Worktree Develop or legacy lwflow to deliver an authorized plan or Parent batch through a shared task worktree into develop.
---

# Vb Linear Worktree Develop

调用标识：`vb-linear-worktree-develop` / `$vb-linear-worktree-develop`；显示名 Vb Linear Worktree Develop。旧触发词 lwflow / `$lwflow` 指向同一入口。

常驻合同见 `docs/rules/linear-workflow.md` 与 `docs/rules/git-rules.md`；修改须同步。local-land 只处理当前授权计划的封闭集合，不扫描或认领队列外任务，同一 Issue 不允许重复并行执行。

Linear MCP 不可用时回退到用户提供的 Issue 上下文，并明确标记未同步；不伪造写入结果。

1. 核对授权、工作区、Issue 和必要原生依赖；依据本轮用户请求和宿主实际权限执行；不建立项目级授权凭证，不要求 Envelope 或 hostContext。Agent 不得自造授权；缺授权只暂停受影响动作。 Linear 不要求预登记 Issue、Team 或 Project 白名单，仍只同步当前授权计划。
2. 当前计划或已授权 Parent 是执行范围；已有 Issue 直接复用，不限于本轮新建节点，不扫描无关队列、不认领或修改其他 Parent；允许在账号权限内只读核对当前任务必需的跨 Parent 前驱。Parent 批次开始时读取全部必需后代、原生依赖、验收、范围及精确目标 ref；随后在阶段切换、成员或依赖变化通知、恢复且事实已失效、发布前刷新。先比较当前状态/关系/版本元数据，仅对变化节点重读正文；工具不能证明未变化时扩大读取。不在每次命令或轮询重读全部正文。新增、移除成员或影响执行的依赖变化时暂停受影响步骤，确认扩围后记录原因并 plan-sync；不静默漏掉或自动认领新任务。显式执行不要求 Claim 或 Start/Terminal Receipt；历史活动记录仍参与冲突检查。
3. 同一 Parent 的全部必需子任务默认共用一个任务 worktree、一个分支和一个 Writer；以 `--task <PARENT-ID>:<branch>` 归属环境。优先复用宿主隔离树，否则 worktree bootstrap 一次。Parent 仍是 aggregate，不充当实现叶子。按原生依赖顺序实施，无依赖任务稳定串行，不为串行新增 Linear 依赖边。普通单 Agent 不创建协作 DAG 或墙钟估算；普通 Issue 不强建 Parent。仅明确独立交付或并行写入时另定隔离方案。
4. 每个代码任务暂存对应实现、测试和文档，核对工作树与 index 一致后运行必要验证，再形成带 Issue ID 的 Conventional Commit；提交后用 `task update <PARENT-ID> --unit <ISSUE-ID> --verification <report> --unit-status <ISSUE-ID>:done --write` 绑定同一提交树。Hook 改树须重验，修复追加提交并重新绑定，不改写已有 SHA。只读或已交付任务不造空提交。锚点的 done 仅是本地执行完成，不是 Linear Done / DAG succeeded；同批后继凭仍为祖先的已验证提交放行，批外仍等待正式交付。
5. 全部必需任务完成后，只以 Parent 和最终 HEAD 执行一次 `worktree stage`；主检出自动 checkpoint 后直接 no-ff 合并到本地 `develop`，不 fetch、不检查远端、不推送。冲突保留现场并用 `--resume` 继续；本地合并成功持久化 `local_integrated`。
6. 本地合并确认后标记 Done：读取 `localMergeCommit`，逐项重读并回写子任务，再确认 Parent Done；本地已合并，不代表远端已推送。只自动清理 Harness 归属明确的源树；宿主树保留并报告。清理失败只重试清理，不重复 merge、验证或推送。

主检出必须位于本地 `develop`；不自动切换分支、不操作 `main`、不创建 PR/MR、不 force push。普通 PR/MR 继续保留 In Review 与 closing 合并证据；独立审查可选，项目明确门禁继续生效。

验收切片不逐一建单或创建 worktree；已有 Issue 直接复用。Parent 批次等待全部必需任务；任务完成验证收据只作为完成事实和 fan-in 依据，本地 stage 不重复运行同一检查。分别报告本地 checkpoint、merge commit、Linear 同步和资源清理，不报告远端确认。

声明式候选资源采用独立工作区身份、端口块、命名空间与缓存目录。setup/teardown 成对声明且以资源身份和步骤键幂等；具名资源只在相关检查执行时加锁，repo-heavy 只是成本提示。已集成事务可用 `worktree cleanup --batch <id>` 预览，追加 `--write` 重试清理。清理残留保留归属；同一终态重试不 merge、不验证、不 push。

Linear 回写失败只标记同步待处理；恢复先读取当前 Issue/原生关系，重试缺失转换。创建或归属写入结果不明时先重读，不补建重复 Issue。本地 merge commit 作为 `local_integrated` 完成证据；没有新的用户要求或输入变化，不启动额外质量验证。
