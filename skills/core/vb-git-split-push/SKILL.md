---
name: vb-git-split-push
description: Use only when explicitly requested as Vb Git Split Push, $vb-git-split-push, or legacy $git-deliver to commit task changes in logical groups and push the current branch; excludes worktree delivery.
---

# Vb Git Split Push

调用标识：`vb-git-split-push` / `$vb-git-split-push`；显示名：`Vb Git Split Push`。兼容旧触发词 git-deliver / `$git-deliver`，均选择本 Skill，不安装重复入口。

显式调用本 Skill 才启用分组提交并普通推送的交付流程；普通提交与当前分支普通推送本身不以此 Skill 为唯一入口，也不需要独立授权。同步归属：`docs/rules/git-rules.md`，两者修改须同步。用户显式禁止、红区、凭据、生产或不可逆操作缺授权时停止受影响动作；普通提交/推送不需要任务级 Envelope 或 execute 模式，但不能绕过宿主、Git Hook 或服务端限制。

独立的 vb-git-develop-flow / $vb-git-develop-flow 才启用 worktree → `develop` 本地 land；普通 `$vb-git-split-push` 不切换该模式、不创建 worktree 或合并。

## 执行

1. 检查工作区、当前分支、远端、upstream 和相关 diff；把任务前已有、并发产生或归属不明的改动排除，无法安全拆分时停止。
2. 先读取项目 Git 规范及 commitlint 配置，按独立逻辑变更形成提交组；功能、重构、测试和文档按语义拆分，支撑同一变更的测试和文档随该变更提交，不按文件类型机械拆散。每组列出包含、排除、验证、风险、回滚和 Conventional Commit 主题。
3. 对每组只暂存明确文件或补丁并冻结 staged snapshot（记录暂存 diff 的文件清单与 blob/patch 指纹），复核 staged diff 后再运行聚焦验证。验证命令读取工作树而非 index；因此须确认验证相关路径的工作树内容与 index 一致，否则先用补丁拆分或隔离 checkout 让验证对象匹配 staged snapshot，不得把对未暂存内容的结果算作该快照的证据。提交后记录 commit SHA，后续批次不得把前一批验证结果当作当前批次或当前工作树的证据；工作树/暂存区发生变化时必须针对新的快照重跑。Hook 失败时暂停提交，在授权内修复本轮问题并重跑；权限拒绝不重试绕过，不使用 no-verify。
4. 逐组提交后复核提交历史和剩余工作区；不得混入构建产物、依赖缓存、VCS 元数据或用户未归属改动。
5. 默认逐组提交、全部验证通过后统一普通推送；只有明确要求才逐批推送。由已核实 upstream 解析精确目标 ref 与唯一实际 push URL；无 upstream 仅在唯一 origin 且非保护目标时建立跟踪。核验实际目标保护属性，不能仅看当前分支名。拒绝多 push URL、mirror 或无法证明唯一目标的配置；冻结实际地址、目标 ref 与当前 commit SHA。
6. 使用显式非强制 refspec `git push --no-force --no-mirror --no-follow-tags --recurse-submodules=no <actual-push-url> <frozen-sha>:<exact-ref>`，不依赖裸 push、pushRemote、pushDefault 或默认 refspec。返回成功仍须 git ls-remote 精确地址/ref 确认 SHA；结果未知先重读，不宣称完成。推送失败保留提交，不 reset/rebase/force push；目标变化须重新核验。
## 停止边界

- 不在 main、master、release 或仓库识别出的保护/共享分支上自动推送；develop 可直推，但仍须核实当前仓库的分支保护与远端事实。
- 不执行 force push、历史改写、远端引用删除、PR 创建、合并、打标签或发布；这些操作需要独立明确授权。
- 未显式调用本 Skill 时，不自动选择分组交付流程；普通提交或推送按任务需要执行上述归属、分支、验证和失败保留检查。

## 交付

报告各 commit 的哈希与主题、包含和排除文件、验证结果、推送目标与结果，以及仍未提交或未推送的改动。
