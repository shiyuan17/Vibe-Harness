---
name: vb-git-split-push
description: Use only when explicitly requested as Vb Git Split Push, $vb-git-split-push, or legacy $git-deliver to commit task changes in logical groups and push the current branch; excludes worktree delivery.
---

# Vb Git Split Push

调用标识：`vb-git-split-push` / `$vb-git-split-push`；显示名 Vb Git Split Push。旧触发词 git-deliver / `$git-deliver` 指向同一入口。

这是显式分组提交与普通推送入口，不创建 worktree、不合并 `develop`；local-land 交付使用显式 develop flow 的 `stage`/`publish`。常驻合同见 `docs/rules/git-rules.md`；修改须同步。

## 执行

1. 核对工作区、当前分支、upstream 和 diff，排除任务前已有或归属不明的改动。
2. 按独立逻辑变更形成提交组。每组列出包含/排除文件、验证、风险和 Conventional Commit 主题；只暂存明确文件或补丁。
3. 验证 staged 对应的工作树快照并提交；不使用 `--no-verify`。Hook、权限或项目审查失败时停止受影响提交。
4. 从已核实 upstream 解析唯一实际 push URL 与精确目标 ref；拒绝多地址、mirror、保护目标未知或无法唯一证明的目标。
5. 用显式非强制 refspec 推送冻结 SHA，返回成功仍须重读精确远端 SHA。默认全部提交验证通过后统一推送；失败保留本地提交，不 reset、rebase 或 force push。

## 停止边界

不自动推送 main、master、release 或仓库声明为保护的共享分支；不删除远端引用、不改历史、不创建 PR/MR。未显式调用本 Skill 时不启用分组交付流程。
