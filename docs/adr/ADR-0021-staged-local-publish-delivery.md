---
id: ADR-0021
title: 本地暂存与远端发布两阶段 worktree 交付
status: superseded
date: 2026-10-24
review-date: 2027-04-24
owner: vibe-harness-maintainers
decision-makers: [vibe-harness-maintainers]
consulted: [vibe-harness-contributors]
informed: [linear-workflow-users]
supersedes: [ADR-0020]
superseded-by: ADR-0022
---

# 本地暂存与远端发布两阶段 worktree 交付

## Context and Problem Statement

local-land 过去把“本地候选完成”“主检出一致”“远端已集成”和“清理
完成”压在同一个 `land` 调用里。主检出有无关改动、远端在验证期间
前进，或用户暂时不希望发布时，已经验证的任务仍无法得到一个可恢复
的本地完成状态。主检出先本地快进再推送也扩大了锁持有时间，并把用户
工作区与远端竞态耦合在一起。

## Decision Drivers

- 任务完成后应尽快得到一个不依赖远端时序的本地稳定结果。
- 发布前仍必须基于最新远端基线重建和验证，不能把过期候选直接推送。
- 主检出中的用户改动不得被 stash、覆盖、提交或夹带。
- 状态恢复必须依赖不可变 Git 对象和私有引用，而不是脆弱目录。
- 状态文件、日志和错误不得保存含凭据的远端 URL。
- 旧 `land` 调用方需要兼容窗口，不能静默改变既有语义。

## Considered Options

- 保持 `land` 先本地 ff-only、再 fetch 合并、再推送：拒绝，会制造第二
  次 merge、扩大主检出耦合，并留下 fetch 到 push 的竞态窗口。
- 只做本地合并并称完成：拒绝，本地结果不能证明远端集成。
- 分成 `stage` 与 `publish`，在发布时从最新远端基线重建最终候选：
  采纳。

## Decision Outcome

新增兼容式命令面：

```text
worktree stage   --task <id> --delivery local-land --write --json
worktree publish --batch <batch-id> --delivery local-land --write --json
worktree status  --batch <batch-id> --json
worktree discard --batch <batch-id> --write --json
```

`stage` 不 fetch，不要求主检出干净，也不移动主检出或远端。它从本地
`develop` 快照建立 detached candidate，no-ff 合入冻结的源提交，验证后
把候选提交保存到 `refs/vibe-harness/staged/<batch-id>`，返回
`integrationStatus: "local_staged"`。源 worktree 和分支保留，临时候选
目录清理失败不否定已持久化的本地暂存。

`publish` 读取暂存事务并查询冻结的精确 `origin/develop`。远端基线
前进时，它从新基线重新合入同一组冻结源提交并重新验证最终组合树，不在
旧候选上追加第二次 merge。短目标锁内重新核对远端 SHA、暂存引用、源
提交、租约和事务锁，然后执行非强制精确 refspec 推送并回读远端 SHA。
只有回读确认候选已到达远端后才进入 `integrated`；若另一发布在回读前已把
目标继续向前推进，只要候选仍是精确远端目标 HEAD 的祖先，就记录
`remoteAdvanced: true` 并按实际远端 HEAD 完成本地同步，不把已集成误报为分叉。

发布后本地主检出同步是独立结果：主检出在目标分支且干净时尝试
ff-only 到实际确认的远端 HEAD；否则返回 `localRefSync: "deferred"` 或 `"diverged"`，不修改
用户改动。代码已在远端集成不因本地同步延迟而被否定。`remoteValidation`
与 `integrationStatus` 分开；没有配置远端门禁时使用 `not_required`。

`discard` 只允许丢弃未发布事务。它只清理候选目录和
`refs/vibe-harness/` 私有引用，保留源 worktree、源分支和主检出改动；
推送结果不明时拒绝丢弃，必须先核实精确远端或重试发布。已知推送被拒绝
且远端已前进时，事务回到 `local_staged` 以便下一次发布从新基线重建。
`status` 只读报告暂存引用有效性、源提交漂移和三类交付状态。

事务 v2 状态只保存 `remote: "origin"`、精确目标 ref 和远端地址
SHA-256 指纹，不保存原始 push URL。旧 v1 事务可继续由旧 `land`
恢复读取；新 stage/publish 事务使用 v2。旧 `land` 命令保持原语义，
不在本次迁移中改变其调用方。

## Consequences

- 任务完成后可以先结束本地等待，远端发布可在稍后基于最新基线完成。
- 远端前进的代价是最终候选重建和必要验证，而不是无限等待。
- 主检出脏不再是 stage 的阻塞，也不会被自动 stash 或覆盖。
- 失败、推送结果不明和清理残留都保留可恢复事务，不重放不明确的推送。
- 本地锁只串行同机操作，不能声称是跨机器 CAS；远端 SHA 回读仍是最终
  事实。
- 清理已确认发布后的源分支时，若本地目标暂时落后，可先证明源提交是
  发布候选祖先，再执行受保护的 `git branch -D`。

## Confirmation

真实 Git 集成测试覆盖脏主检出下 stage、远端前进后 publish 重建、发布
后本地同步延迟、status/discard、持久引用恢复和状态 URL 脱敏。运行时
仍以候选验证、非强制推送、远端 SHA 回读和源提交归属作为证据。

## Review Trigger

- 公开命令、状态文件名、事务 schema 或兼容窗口变化；
- 远端平台改为 merge queue 或强制 PR/MR；
- 发布后本地同步语义、分支回收条件或凭据处理变化；
- 需要跨机器原子发布或不同目标 ref。

## More Information

- 当前规则与操作顺序见 `docs/rules/git-rules.md` 的 stage/publish 协议。
- 事务字段与状态见 `schemas/worktree-transaction.schema.json`。
- 实现位于 `runtime/lib/worktree-command.mjs`；集成覆盖位于
  `tests/integration/project-worktree-command.test.js`。
