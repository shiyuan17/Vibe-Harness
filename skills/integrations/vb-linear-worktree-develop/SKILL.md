---
name: vb-linear-worktree-develop
description: Use only when explicitly requested as Vb Linear Worktree Develop or legacy lwflow to deliver an authorized plan or Parent batch through a shared task worktree into develop.
---

# Vb Linear Worktree Develop

调用标识：`vb-linear-worktree-develop` / `$vb-linear-worktree-develop`；显示名 Vb Linear Worktree Develop。旧触发词 lwflow / `$lwflow` 指向同一入口。

常驻合同见 `docs/rules/linear-workflow.md` 与 `docs/rules/git-rules.md`；修改须同步。local-land 只处理当前授权计划的封闭集合，不扫描或认领队列外任务，同一 Issue 不允许重复并行执行。

Linear MCP 不可用时回退到用户提供的 Issue 上下文，并明确标记未同步；不伪造写入结果。

1. 核对授权、canonicalCwd、allowedWriteRoots、Issue 和必要原生依赖；缺授权只暂停对应动作。跨边界效果需要真实 hostContext（source=host、process=isolated、observedAt），Agent 不得自造；旧 v1 Envelope 仅作 contract-only/degraded 兼容。
2. 当前计划或已授权 Parent 是执行范围；已有 Issue 直接复用，不限于本轮新建节点，不扫描或认领其他 Parent。Parent 批次开始时读取全部必需后代、原生依赖、验收、范围及精确目标 ref；随后在阶段切换、成员或依赖变化通知、恢复且事实已失效、发布前刷新。先比较当前状态/关系/版本元数据，仅对变化节点重读正文；工具不能证明未变化时扩大读取。不在每次命令或轮询重读全部正文。新增、移除成员或影响执行的依赖变化时暂停受影响步骤，确认扩围后记录原因并 plan-sync；不静默漏掉或自动认领新任务。显式执行不要求 Claim 或 Start/Terminal Receipt；历史活动记录仍参与冲突检查。
3. 同一 Parent 的全部必需子任务默认共用一个任务 worktree、一个分支和一个 Writer；以 `--task <PARENT-ID>:<branch>` 归属环境。优先复用宿主隔离树，否则 worktree bootstrap 一次。Parent 仍是 aggregate，不充当实现叶子。按原生依赖顺序实施，无依赖任务稳定串行，不为串行新增 Linear 依赖边。普通单 Agent 不创建协作 DAG 或墙钟估算；普通 Issue 不强建 Parent。仅明确独立交付或并行写入时另定隔离方案。
4. 每个代码任务暂存对应实现、测试和文档，核对工作树与 index 一致后运行必要验证，再形成带 Issue ID 的 Conventional Commit；提交后用 `task update <PARENT-ID> --unit <ISSUE-ID> --verification <report> --unit-status <ISSUE-ID>:done --write` 绑定同一提交树。Hook 改树须重验，修复追加提交并重新绑定，不改写已有 SHA。只读或已交付任务不造空提交。锚点的 done 仅是本地执行完成，不是 Linear Done / DAG succeeded；同批后继凭仍为祖先的已验证提交放行，批外仍等待正式交付。
5. 全部必需任务完成且共享工作区/index 干净后，只以 Parent 和最终 HEAD 执行一次 `worktree stage`，验证整批最终组合与 Parent fan-in，持久化 `local_staged`；不逐子任务 stage 或提前推送。随后 `worktree publish --batch <id>` 对齐唯一实际 `origin/develop`，必要时重建、重验，非强制精确推送并回读。内部临时候选 worktree 不计入任务 worktree 数量。任一必需任务未完成不部分发布；跨批依赖形成交付循环时报告并停止，不绕过依赖。
6. 推送确认后标记 Done：逐项重读并回写子任务，再确认 Parent Done；已有已交付任务只核实证据，不重做。Parent publish 保留源任务树、锚点和分支并报告 `integrated_cleanup_pending`；回写确认后才用已有 `worktree cleanup --batch <id> --write` 回收。同步失败只重试缺失状态，未知结果先重读，不重放 merge/push。主检出脏、位于其它分支或本地领先时只记录 `localRefSync` 为 `deferred` / `diverged`。清理失败保留资源占用，重试只清理。共享树存在失败遗留改动时停止后续写入；保留现场，不自动 stash、rebase、强推或破坏性清理。

`--target-mode primary` 是 `stage` 专属的意图断言，新 stage/publish 不需要；旧 `worktree land` 已移除，`--target-mode remote` 已退役。不创建 PR/MR、不改默认 delivery、不操作 main，不 force push 或重放已确认的合并与推送。普通 PR/MR 继续保留 In Review 与 closing 合并证据；独立审查可选，项目明确门禁继续生效。

验收切片不逐一建单或创建 worktree；已有 Issue 直接复用。Parent 批次在执行时仅等待直接前驱和冲突资源，发布时等待全部必需任务；同一最终候选的有效验证可同时支撑叶子交付与 Parent fan-in，不重复运行。分别报告本地提交、候选验证、远端确认、Linear 同步和资源清理，状态同步延迟不撤销已经核实的 Git 事实。

声明式候选资源采用独立工作区身份、端口块、命名空间与缓存目录。setup/teardown 成对声明且以资源身份和步骤键幂等；具名资源只在相关检查执行时加锁，repo-heavy 只是成本提示。已集成事务可用 `worktree cleanup --batch <id>` 预览，追加 `--write` 重试清理。清理残留保留归属；同一终态重试不 merge、不验证、不 push。

Linear 回写失败只标记同步待处理；恢复先读取当前 Issue/原生关系，重试缺失转换。创建或归属写入结果不明时先重读，不补建重复 Issue。最终候选验证收据直接作为 fan-in 证据，无新输入不重验。
