---
name: vb-git-develop-flow
description: Use only when explicitly invoked for development in a task worktree and local integration into develop; never push.
---

# 本地 Develop Flow

显式调用 `vb-git-develop-flow`（别名 gd-flow）执行 local-land。常驻合同见 `docs/rules/git-rules.md`，修改须同步。

1. 核对用户授权范围和工作区，按可观察验收映射文件、关联输入、排除项及聚焦检查；小任务一个切片即可，不自动创建 DAG 或审批。
2. 复用宿主提供的任务 worktree；没有可用隔离树时用 `worktree bootstrap`。在任务树完成实现、验证与普通提交，不在交付时重复质量验证。
3. 主检出必须在本地 `develop`。运行 `worktree stage --project <main-repo> --task <task-id>:<branch> --base-ref develop --delivery local-land --write --json`；dirty develop 自动提交固定 checkpoint，再 no-ff 本地合并，不访问远端、不推送。
4. 冲突在主检出解决并暂存，再用 `stage --resume <batchId> --write` 完成 merge commit。Hook、红区、角色权限与用户改动保护继续生效；不禁 Hook、不 reset、不 stash。
5. 报告 `localMergeCommit` 和 `local_integrated`；只自动清理 Harness 创建且归属明确、干净并已合入的源树与分支。宿主树保留；清理失败用 `cleanup --batch <id> --write` 重试。

`status --batch <id>` 只读恢复；`discard --batch <id> --write` 只中止未完成合并，不回滚 checkpoint 或已完成提交。旧远端事务需迁移，不自动执行旧动作。

交付说明必须区分本地合并、清理与远端交付：“本地已合并，不代表远端已推送”。独立推送不属于本流程。
