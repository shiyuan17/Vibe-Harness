---
name: linear-workflow
description: Use for authorized Linear reads, explicit execution, completion, or plan sync.
---

# Linear 工作流

常驻合同见 `docs/rules/linear-workflow.md`；修改须同步。只执行用户明确授权的具体 Issue、当前计划或宿主明确启动的既有委派 Issue；不扫描 Ready 队列，不自动抢单，同一 Issue 不允许重复并行执行。

Linear MCP 不可用时回退到用户提供的 Issue 上下文，并明确标记未同步；不伪造写入结果。

## 执行顺序

1. 先核对任务、授权、工作区和必要关系；`allowedEffects`、`allowedWriteRoots` 越界或身份不符时只暂停对应写入。worktree 生命周期按本地 Git 事实处理；优先接收宿主创建的隔离树并用 `--task <ISSUE-ID>:<branch>` 归因，没有可用树时使用 `worktree bootstrap`。跨边界效果需要真实 hostContext（source=host、process=isolated、observedAt）；Agent 不得自造，旧 v1 Envelope 仅作 contract-only/degraded 兼容。
2. 读取当前 Issue 的 Goal、上下文、精确目标 ref、Scope、验收、Verification 和原生 blocked-by / blocks。已有 Linear DAG 必须遵循；普通 Issue 不要求 Parent、DAG 或墙钟规划，不要求墙钟估算。
3. 显式执行不要求 Claim 或 Start/Terminal Receipt。历史活动 Receipt、Delegate 和现有 worktree 仍参与冲突检查；结果不明先重读，不接管活动任务。
4. 普通 PR/MR 保留 In Review 和 closing 合并证据。显式 local-land 先用 `worktree stage` 从本地 `develop` 快照完成 no-ff 合并验证并持久化 `local_staged`，再用 `worktree publish --batch <id>` 对齐最新 `origin/develop`、按需重建验证、精确推送并回读；`local_staged` 不单独支撑 Done。独立审查可选。单 Agent 是默认执行模式，真实多 Agent 时才读取按需拆分 reference。
5. 推送确认即代码集成完成；`integrated_cleanup_pending` 不阻塞 Done、succeeded 或依赖后继，但残留资源继续占用。主检出的本地同步独立报告，不反向否定远端集成。读取节点以约定输出和 Verification 完成；aggregate Parent 以全部必需后代成功和一次 fan-in 验证完成。
6. Linear 尚未尝试写入且上下文充分时，可继续本地工作并标记 `unregistered / Linear 未同步`。写入已尝试但结果不明、部分登记或重读失败时保留现场并停止受影响节点。

显式 Parent 批次按 `linear-workflow.md` 的「Parent 单 worktree 批次」执行：同一 Writer 共用任务树和分支，逐 Issue 验证及本地提交，同批依赖凭提交证据放行，整批 stage/publish 后才统一 Done。普通 PR/MR、独立 Issue 和批外依赖的完成语义保持原合同。

分支基线为 `feat/*、fix/* → develop → main`，紧急修复为 `hotfix/* → main → develop`；develop 的本地质量责任由真实候选验证承担，不要求服务器 fast gate。项目明确的审查和分支保护继续生效。

## 停止边界

不创建 PR/MR、不操作 main、不改变普通 closing PR 的 Done 语义，不重放已确认的合并或推送。早期探查只在入口或环境存在实质不确定性时选填，首轮默认限时 30 分钟；普通 REPL 和受管 Micro 不能替代正式 Verification。缺授权、缺必要产品和契约决定、目标基线无法确认时停止受影响节点；不伪造 Linear、Git、验证或清理结果。
