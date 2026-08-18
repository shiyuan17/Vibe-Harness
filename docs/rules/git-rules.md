# Git 规则

Git 规则的目标是保护用户改动、保持提交可审查，并确保 worktree 任务真正 merge-back。

默认分支模型为 <code>feat/*、fix/* → develop → main</code>，紧急修复为 <code>hotfix/* → main → develop</code>。普通任务 PR 使用 squash merge；<code>develop → main</code> 的发布提升与 <code>main → develop</code> 的回同步使用 merge commit。<code>main</code> 只接受同仓库 <code>develop</code>、<code>hotfix/*</code> 和 release-please 的 PR，不使用长期 <code>release/*</code> 分支。

## 启动与归属

- 编辑前运行 <code>git status --short</code>；SVN 工作副本运行 <code>svn status</code>。
- 只处理当前任务路径。归属不清、任务开始前已存在或来自并发工作的改动都视为用户改动，不覆盖、不暂存、不提交。
- 仅在并发工作可能冲突、脏工作区与任务范围重叠、跨仓协作或明确需要独立构建与验证环境时使用独立 worktree；普通单 Agent 局部修复不因任务类型自动创建 worktree。
- 分批交付前再次检查 working tree 和 staged diff，明确包含、排除、验证、风险和回滚方式。

## 提交授权

当前请求必须按 Execution Envelope 分别授权 <code>workspaceWrite</code>、<code>gitBranch</code>、<code>gitCommit</code>、<code>gitPush</code>、<code>mergeRequestWrite</code> 和 <code>credentialUse</code>。任一 effect 都不隐含其他 effect：实现授权不等于建分支、提交、推送或创建 PR/MR，提交授权也不等于推送或创建 PR/MR；<code>forbiddenEffects</code> 始终优先。

Vibe-Harness 不通过 Stop Hook、运行时脚本或任何默认流程自动执行 <code>git commit</code> 或 <code>git push</code>。提交和推送必须由用户在当前任务中明确授权；显式调用 `$git-deliver` 或明确指定该 Skill，视为对当前仓库、当前任务相关改动的分组提交和当前分支普通推送授权。没有授权时只报告 working tree 状态和建议命令。

获得授权后仍须先给出或核对提交分组：

| 字段 | 内容 |
| --- | --- |
| 提交分组 | 验收点和建议 commit message |
| 包含文件 | 本次提交包含文件 |
| 排除文件 | 明确排除的无关改动 |
| 验证 | 已运行命令及结果 |
| 风险 | 低 / 中 / 高与理由 |
| 回滚 | 回滚方式 |

- 每个 commit 只承载一个逻辑变更；重构与功能变更默认拆开。
- 提交主题使用 <code>&lt;type&gt;(&lt;scope&gt;): &lt;描述&gt;</code>，常用类型为 feat、fix、docs、refactor、test、chore 和 eval。
- 不使用 <code>--no-verify</code> 绕过项目 Git Hook。
- `$git-deliver` 只在已有 upstream 时普通推送；无 upstream 时，仅在唯一明确远端为 origin 且当前分支非保护或共享分支时建立跟踪并普通推送，否则停止确认。
- main、master、develop、release、仓库识别出的保护或共享分支不得由 `$git-deliver` 自动推送。强制推送、删除远端引用和历史重写不属于该 Skill 授权范围。
- 未获提交授权时，不得把未提交状态描述为失败；应交付改动清单和验证证据。

## 分支与 PR/MR

- 默认分支名使用 <code>&lt;type&gt;/&lt;short-topic&gt;</code>；已有任务分支或用户指定分支优先。
- main、master、develop、release 和其他共享分支上的提交与推送遵循仓库保护和人工审批。
- PR/MR 包含摘要、风险、验证、回滚和审查备注；高风险 PR/MR 说明红区确认和独立审查状态。
- Linear 工作流下必须给出可解析的精确目标远端 ref；只有解析结果确为仓库默认分支时才可写“默认分支”。开始实现前记录目标 ref 和 base SHA，分支与 worktree 必须从该基线创建。
- Linear 普通任务默认以 <code>origin/develop</code> 为基线；只有 hotfix 以 <code>origin/main</code> 为基线。发布提升和回同步使用 <code>Refs &lt;ISSUE-ID&gt;</code>，不得用 closing magic word 重复关闭已完成开发 Issue。
- 顺序执行且工作区干净时，任务分支可在当前 clone 创建；并发 Agent、脏工作区、存在无关改动或明确要求隔离时，必须使用仓库外 worktree。该优化不改变“一任务一分支一 closing PR/MR”。
- 创建 PR/MR 前重新读取远端目标 ref 和 source HEAD，校验提供方所选 base 等于已声明目标 ref，并计算 merge-base。merge-base 必须等于冻结 base SHA，或是该 SHA 在同一目标 ref 历史上的已验证后代；否则停止创建并报告基线不一致。
- GitHub PR 与 GitLab MR 的标题、source、target、描述和 closing 语义都必须在创建后重读确认。Linear 分支和标题保留 Issue ID；closing 描述使用 <code>Fixes &lt;ISSUE-ID&gt;</code>，只有提供方配置并经重读确认的等价语法才可替代；closing 词不放在 commit 中。

Git credential helper 只可由其已配置的 Git transport 透明调用。仅有 Git transport 授权时不得读取、解析或转用 helper 输出进行网页或 API 登录；此类转换必须另有 <code>credentialUse</code> 与对应外部写入授权。Agent 不得把 helper 输出或原始凭据写入文件，credential query、包装脚本或其他辅助文件也不得写入仓库或 worktree。

## Git Hooks

full profile 会安装项目级 pre-commit 和 pre-push 文件，但不会修改本地或全局 Git 配置。是否启用 <code>core.hooksPath</code> 由用户决定。客户端 Hook 可被本地用户绕过，强制策略应放在 CI 和服务端保护中。

## 参考实现边界

Vibe-Harness 自身使用 Conventional Commits、pre-commit、pre-push、lint 和测试作为可审查的参考实现；这些检查只在用户明确授权提交后由 Git 正常触发，不构成自动提交授权。

## Worktree

- 使用 worktree 时，一个隔离单元对应一个命名分支和明确写入范围；不需要隔离时直接在当前工作区保护用户改动。
- worktree 放在仓库外部，避免被构建和依赖扫描。
- 子 Agent 只在分配的 worktree、分支和写入范围内工作；审查任务默认只读。
- merge-back 完成前不清理 worktree 或删除分支。
- 清理前确认 worktree 无未提交改动，并先用 <code>git worktree remove</code> 再用 <code>git worktree prune</code>。
- 使用 <code>git worktree list --porcelain -z</code> 获取可机器解析的 worktree 清单。

## 完成定义

- 采纳的 worktree 提交必须合并回声明的精确目标 ref。
- 目标分支未包含 merge-back 结果、验证早于最后一次实质修改或存在未解释改动时，不得宣称完成。
- 工具不可用时只给出分组清单和命令建议，不声称已经提交、推送或合并。

## 禁止项

- 不使用 <code>git reset --hard</code>、<code>git checkout --</code> 或破坏性清理覆盖用户改动，除非用户明确要求。
- 不把构建产物、依赖缓存、VCS 元数据或用户未归属改动混入提交。
- 不以时间间隔、文件行数、变更数量或工具调用边界触发提交。
- 不把本地孤立分支、未合并 worktree 或未验证 commit 当作完成状态。
