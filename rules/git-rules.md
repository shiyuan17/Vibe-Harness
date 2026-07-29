# Git 规则

Git 规则的目标是保护用户改动、保持提交可审查、确保 worktree 任务真正 merge-back。

## 启动门禁

- 每次编辑前先运行 `git status --short`。
- 若目标项目是 SVN 工作副本，运行 `svn status`；若同时存在 Git/SVN 痕迹，先确认当前改动实际归属的工作副本。
- 只处理当前任务路径；归属不清的改动视为用户改动，不覆盖。
- 低风险文档/只读任务可以不建 worktree；运行时代码、共享契约、构建、跨仓、多 Agent 或当前工作区脏且无法隔离时必须使用独立 worktree。

## AI 提交分组

AI 准备提交前先给出提交分组：

| 字段 | 内容 |
| --- | --- |
| 提交分组 | 验收点和建议 commit message |
| 包含文件 | 本次提交包含文件 |
| 排除文件 | 明确排除的无关改动 |
| 验证 | 已跑命令和结果 |
| 风险 | 低 / 中 / 高与理由 |
| 回滚 | 回滚方式 |
| 是否需要人工确认 | 是否需要人工确认 |

低风险可自动提交；中风险需说明验证和风险；高风险、红区或用户要求等待时必须暂停。

## 自动提交与推送触发器

自动提交推送以「逻辑变更完成」为主触发器、以「验证通过」为门禁，不使用与语义无关的时间或行数阈值。可自动提交的改动仍须先满足上方「AI 提交分组」的风险分级：低风险可自动，中风险需说明验证和风险，高风险、红区或用户要求等待时暂停。

### 触发条件

自动提交必须同时满足以下两个条件：

- 任务完成触发：一个 Todo 项或一个逻辑变更完成、且已通过聚焦验证后，才可自动提交。
- 验证通过门禁：自动提交前必须通过 pre-commit（密钥、红区、禁止路径、聚焦测试标记）和 pre-push（lint、test）钩子；验证未通过不得提交，也不得用 `--no-verify` 绕过。

禁止以下触发方式，因为它们会产生与逻辑变更无关的垃圾提交：

- 不按固定时间间隔（如每 N 分钟）触发。
- 不按文件变更数量或行数阈值触发。
- 不按每次工具调用边界（如每次 Edit 后）触发；同一逻辑变更的多个编辑须聚合为一次提交。

### commit 与 push 分级

| 目标分支 | auto-commit | auto-push | 说明 |
| --- | --- | --- | --- |
| `cognis/<scope>-<short-topic>` 任务分支 | 可自动 | 可自动 | 私有分支，push 仅为备份与触发 CI |
| main / 集成分支 | 可自动 | 禁止自动 | 必须走 PR + 人工确认 + CI 门禁 |
| 涉及红区文件的改动 | 禁止自动 | 禁止自动 | 必须人工确认（沿用现有红区规则） |

任务分支上的自动 push 是可接受的：它是私有分支，强推只影响自己，主要价值是备份改动与触发 CI。main 及集成分支永远不自动 push，合并回这些分支必须经 PR 与人工确认。

### 自动提交的强制约束

- commit message 沿用现有 `<type>(<scope>): <中文描述>` 规范，不得因自动化而降级为 `update`、`fix bug`、`phase 1` 等不可检索描述。
- 不得带 `--no-verify`、`--force`、`--force-with-lease`、`--delete`；这些标志会被安全 hook 拦截，且属于禁止项。
- 自动提交前先 `git status --short` 复核 working tree；若存在非本任务的未归属改动，先单独提交或 stash，不混入自动提交，让人与 AI 的改动在历史中可分。
- 一个自动提交只承载一个逻辑变更，沿用「一个 commit 一个逻辑变更」规则；重构与功能变更默认拆开。

### 自动提交失败处理

- 若 pre-commit 或 pre-push 钩子失败，不得强行绕过；报告失败原因并保留改动。
- 已自动提交但尚未 push 的，可用 `git reset --soft HEAD~1` 回退（禁止 `--hard`）。
- 已 push 的回退走 `git revert`，不走 `reset` 加强制推送。

## 分支 / 提交 / PR

- 分支：默认使用 `cognis/<scope>-<short-topic>`；已有任务分支或用户指定分支优先。
- 提交主题格式为 `<type>(<scope>): <中文描述>`，其中 scope 可选；类型前缀和可选 scope 保持英文，主题、正文和人工编写的说明使用中文。
- 常用类型包括 `feat`、`fix`、`docs`、`refactor`、`test` 和 `chore`。例如：`feat: 增加项目基线快照`、`fix(installer): 修复强制覆盖前未备份的问题`、`docs: 补充基线与工具配置说明`、`refactor: 简化安装计划生成逻辑`、`test: 覆盖中文提交规范`、`chore: 更新开发依赖`。
- 中文描述使用祈使句，说明一个可验收改动；`feat: add project baseline snapshots` 不符合本规范，也应避免 `fix bug`、`update`、`phase 1` 这类不可检索描述。
- Git 自动生成且无需人工编辑的 merge 或 revert 信息不受此限制；人工修改时仍使用中文描述。
- PR：包含摘要、风险、验证、回滚和审查备注；高风险 PR 必须说明红区确认和独立审查状态。
- 一个 commit 只承载一个逻辑变更；重构和功能变更默认拆开。
- 分批交付前检查 working tree 和 staged diff，明确包含文件、排除文件、验证证据、风险和回滚方式；工具不可用时只给出分组清单和命令建议，不声称已经提交。
- SVN 项目不输出 Git 分支、commit 或 PR 结论；改为报告 `svn status`、修改文件清单、验证证据和提交建议。

## Worktree

- 一个实现任务对应一个 worktree + 分支，除非明确命中低风险例外。
- worktree 不放在仓库内部，避免被构建或依赖扫描；建议放在仓库同级目录，命名形如 `<repo>-worktrees/<task-scope>`。
- 实现任务的 worktree 必须基于命名分支；`git worktree add -d` 的 detached HEAD 仅用于一次性、实验性改动，因为它让 merge-back 难以追踪。
- 子 Agent 只能在指定 worktree、分支和写入范围内工作。
- 审查 Agent 默认只读，不暂存、不提交、不合并。
- 脚本解析 worktree 列表时使用 `git worktree list --porcelain -z`，跨版本稳定且能处理路径中的换行。
- 项目使用子模块时慎用多 worktree 并发检出超级项目；官方标注子模块支持不完整，含子模块的 worktree 无法用 `git worktree move` 迁移。

## Merge-back 完成定义

- worktree 中采纳的提交必须合并回当前集成分支或任务声明目标分支。
- 目标分支未包含 merge-back 结果前，不得宣称任务完成。
- 验证只来自临时 worktree、目标分支未复核或存在未解释改动时，不得宣称完成。
- merge-back 前不得清理 worktree 或删除分支。
- 主 Agent 负责检查 diff、处理冲突、排除无关改动、统一验证和交付说明。

## Worktree 生命周期 / 清理

- 仅在 merge-back 完成、目标分支确认包含结果后才清理 worktree。
- 清理顺序：先 `git -C <worktree> status --short` 确认无未提交改动，再 `git worktree remove <path>` 移除；脏 worktree 需先 stash 或显式确认丢弃并加 `--force`。
- worktree 移除后运行 `git worktree prune` 清理残留 administrative 文件；只删目录而不 `remove` 会留下失效条目。
- 仅当目标分支已合并或确认不再需要时才删除分支；删除前用 `git branch --merged` 复核。
- 跨主机或可移动存储上的 worktree 用 `git worktree lock --reason <说明>` 防止被误 prune；手动移动 worktree 后用 `git worktree repair` 重建链接。
- 主 Agent 定期审计 `git worktree list`，识别残留 detached HEAD 或未合并 worktree，按上述顺序处置。

## 禁止项

- 不使用 `git reset --hard`、`checkout --` 或破坏性清理覆盖用户改动，除非用户明确要求。
- 不用 `--no-verify` 绕过 hook；确需绕过必须人工确认并说明原因。
- 不把本地孤立分支、未合并 worktree 或未验证 commit 当作完成状态。
- 不把构建产物、依赖缓存、VCS 元数据或用户未归属改动混入提交分组。
- 不以时间间隔、文件行数或变更数量阈值作为自动提交触发条件，避免产生与逻辑变更无关的垃圾提交。
- 自动提交与推送不得使用 `--no-verify`、`--force`、`--force-with-lease`；涉及红区文件的改动不得自动提交或推送。
