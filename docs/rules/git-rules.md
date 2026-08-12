# Git 规则

Git 规则的目标是保护用户改动、保持提交可审查，并确保 worktree 任务真正 merge-back。

## 启动与归属

- 编辑前运行 <code>git status --short</code>；SVN 工作副本运行 <code>svn status</code>。
- 只处理当前任务路径。归属不清、任务开始前已存在或来自并发工作的改动都视为用户改动，不覆盖、不暂存、不提交。
- 运行时代码、共享契约、构建、跨仓、多 Agent 或脏工作区无法隔离时使用独立 worktree。
- 分批交付前再次检查 working tree 和 staged diff，明确包含、排除、验证、风险和回滚方式。

## 提交授权

Vibe-Harness 不通过 Stop Hook、运行时脚本或任何默认流程自动执行 <code>git commit</code> 或 <code>git push</code>。提交和推送必须由用户在当前任务中明确授权；没有授权时只报告 working tree 状态和建议命令。

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
- 不自动 push。涉及共享分支、红区、强制推送、删除远端引用或历史重写时必须再次获得人工确认。
- 未获提交授权时，不得把未提交状态描述为失败；应交付改动清单和验证证据。

## 分支与 PR

- 默认分支名使用 <code>&lt;type&gt;/&lt;short-topic&gt;</code>；已有任务分支或用户指定分支优先。
- main、master、develop、release 和其他共享分支上的提交与推送遵循仓库保护和人工审批。
- PR 包含摘要、风险、验证、回滚和审查备注；高风险 PR 说明红区确认和独立审查状态。
- Linear 工作流下分支和 PR 保留 Issue ID；closing 词只用于 closing PR。

## Git Hooks

full profile 会安装项目级 pre-commit 和 pre-push 文件，但不会修改本地或全局 Git 配置。是否启用 <code>core.hooksPath</code> 由用户决定。客户端 Hook 可被本地用户绕过，强制策略应放在 CI 和服务端保护中。

## 参考实现边界

Vibe-Harness 自身使用 Conventional Commits、pre-commit、pre-push、lint 和测试作为可审查的参考实现；这些检查只在用户明确授权提交后由 Git 正常触发，不构成自动提交授权。

## Worktree

- 一个实现任务对应一个命名分支 worktree，低风险例外除外。
- worktree 放在仓库外部，避免被构建和依赖扫描。
- 子 Agent 只在分配的 worktree、分支和写入范围内工作；审查任务默认只读。
- merge-back 完成前不清理 worktree 或删除分支。
- 清理前确认 worktree 无未提交改动，并先用 <code>git worktree remove</code> 再用 <code>git worktree prune</code>。
- 使用 <code>git worktree list --porcelain -z</code> 获取可机器解析的 worktree 清单。

## 完成定义

- 采纳的 worktree 提交必须合并回声明的目标分支。
- 目标分支未包含 merge-back 结果、验证早于最后一次实质修改或存在未解释改动时，不得宣称完成。
- 工具不可用时只给出分组清单和命令建议，不声称已经提交、推送或合并。

## 禁止项

- 不使用 <code>git reset --hard</code>、<code>git checkout --</code> 或破坏性清理覆盖用户改动，除非用户明确要求。
- 不把构建产物、依赖缓存、VCS 元数据或用户未归属改动混入提交。
- 不以时间间隔、文件行数、变更数量或工具调用边界触发提交。
- 不把本地孤立分支、未合并 worktree 或未验证 commit 当作完成状态。
