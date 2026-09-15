# Git 规则

Git 规则的目标是保护用户改动、保持提交可审查，并确保 worktree 任务真正 merge-back；每个 Git 判断都以仓库实际远端事实为准，不用设想中的分支模型代替核实。

## 启动与归属

- 编辑前运行 `git status --short`；SVN 工作副本运行 `svn status`。
- 只处理当前任务路径。归属不清、任务开始前已存在或来自并发工作的改动都视为用户改动，不覆盖、不暂存、不提交。
- 仅在并发工作可能冲突、脏工作区与任务范围重叠、跨仓协作或明确需要独立构建与验证环境时使用独立 worktree；普通单 Agent 局部修复不因任务类型自动创建 worktree。
- 分批交付前再次检查 working tree 和 staged diff，明确包含、排除、验证、风险和回滚方式。

## 提交授权

当前请求必须按 Execution Envelope 分别授权 `workspaceWrite`、`gitBranch`、`gitCommit`、`gitPush`、`mergeRequestWrite` 和 `credentialUse`。

- 任一 effect 都不隐含其他 effect：实现授权不等于建分支、提交、推送或创建 PR/MR，提交授权也不等于推送或创建 PR/MR；`forbiddenEffects` 始终优先。
- 完整 mode 与 effect 枚举以 `governance-core.md` 的「授权与 Execution Envelope」条款为准；本清单是 Git 域不含 `linearWrite` 的子集。

Vibe-Harness 不通过 Stop Hook、运行时脚本或任何默认流程自动执行 `git commit` 或 `git push`。提交和推送必须由用户在当前任务中明确授权；显式调用 `$git-deliver` 或明确指定该 Skill，视为对当前仓库、当前任务相关改动的分组提交和当前分支普通推送授权。没有授权时只报告 working tree 状态和建议命令。

获得授权后仍须先给出或核对提交分组：

| 字段 | 内容 |
| --- | --- |
| 提交分组 | 验收点和建议 commit message |
| 包含文件 | 本次提交包含文件 |
| 排除文件 | 明确排除的无关改动 |
| 验证 | 已运行命令及结果 |
| 风险 | 低 / 中 / 高与理由 |
| 回滚 | 回滚方式 |

- `$git-deliver` 只在已有 upstream 时普通推送；无 upstream 时，仅在唯一明确远端为 origin 且当前分支非保护或共享分支时建立跟踪并普通推送，否则停止确认。
- main、master、develop、release、仓库识别出的保护或共享分支不得由 `$git-deliver` 自动推送。强制推送、删除远端引用和历史重写不属于该 Skill 授权范围。
- 未获提交授权时，不得把未提交状态描述为失败；应交付改动清单和验证证据。

## 提交内容与信息

- 每个 commit 只承载一个逻辑变更；重构与功能变更默认拆开，提交后的状态应能通过该变更对应的聚焦检查。
- 提交主题使用 `<type>(<scope>): <描述>`，常用类型为 feat、fix、docs、refactor、test、chore 和 eval；项目配置 commitlint 时，其配置是类型枚举、长度和大小写规则的唯一事实来源。
- 提交正文说明为什么改、影响面和被否决的方案；破坏性变更用 `feat!:` 或 `BREAKING CHANGE:` footer 显式声明，不靠正文措辞暗示。
- Issue 关联写进 PR/MR 描述与 `Refs <ISSUE-ID>` 等 trailer，closing magic word 不放进 commit；完整语义以 `linear-workflow.md`（若项目已安装该规则）为准。
- 不使用 `--no-verify` 绕过项目 Git Hook。
- 不添加未经确认的 `Co-authored-by`、`Signed-off-by` 或等价署名 trailer；需要标注 AI 参与时使用项目批准的 trailer，不伪造他人身份。
- 不把构建产物、依赖缓存、VCS 元数据、大体积二进制或用户未归属改动混入提交；行尾与二进制按 `.gitattributes` 处理，超大文件走 LFS 或外置存储。

## 分支模型与合并

分支模型、门禁边界与 `develop` 快车道的完整规范：协作工作流以 `linear-workflow.md`（若项目已安装该规则）为准，仓库侧以项目自己的发布交付文档为准；本节只保留 Git 域必须直接遵守的结论，发现与那两处不一致时按它们修正本节。

- 默认分支模型：`feat/*、fix/* → develop → main`；紧急修复：`hotfix/* → main → develop`。该模型在项目显式建立对应分支后生效；尚未创建 `develop` 或迁移未完成的仓库，以实际默认分支和已声明目标 ref 为准，不按设想中的分支开始工作。
- 普通任务 PR 使用 squash merge；`develop → main` 的发布提升与 `main → develop` 的回同步使用 merge commit。squash 在目标分支生成的提交主题来自 PR/MR 标题，因此标题与提交主题使用同一 Conventional Commit 语法。
- `main` 只接受同仓库 `develop`、`hotfix/*` 和 release-please 的 PR，不使用长期 `release/*` 分支；目标项目已配置 `release/*` 时按其保护规则处理。
- 必须有门禁效果的 required CI 只在发布边界运行：`develop → main` 提升、`hotfix/* → main` 和项目自行配置的 `release/*` 边界；边界检查的名称、聚合方式与是否为唯一 required check 以项目 CI 配置为准。
- 普通任务 PR 仍会跑不阻断合并的 advisory CI job；`develop` ruleset 不设 required status check，合入 `develop` 不要求远端 CI 或强制审批，Writer 可在 envelope 授权 `mergeRequestWrite` 后自行落地 squash merge；`Ready to Merge` 只用于带门禁目标。
- 合并前的本地验证必须建立在合并时的最新 `origin/develop` 之上：目标 ref 已前进时重跑受影响检查，或改用 merge queue 在最新 base 上重跑；高风险变更仍须按项目交付文档携带 Independent Review Receipt，shadow 模式下该检查不阻断合并，但收据缺失、与 diff 不匹配或结论为 negative 时不得自行落地合并。
- 无门禁合入以本地验证为唯一前置，因此还要能快速发现回归：使用项目已启用的 post-merge 检测或等价的合并后检查；发现回归时由落地该合并的 Writer 负责 revert 并重走修复流程，不用改写历史掩盖。

## 分支与 PR/MR

- 默认分支名使用 `<type>/<short-topic>`，只用小写字母、数字和连字符；Linear 工作流下使用 `<type>/<ISSUE-ID>-<slug>`，与项目 worktree 校验入口的分支命名校验一致；已有任务分支或用户指定分支优先。
- main、master、develop、release 和其他共享分支上的提交与推送遵循仓库保护和人工审批。
- PR/MR 包含摘要、风险、验证、回滚和审查备注；高风险 PR/MR 说明红区确认和独立审查状态。
- PR/MR 标题使用 `<type>(<scope>): <描述>`，因为 squash 合并用它生成目标分支上的提交主题。
- 单个 PR/MR 尽量只承载一个逻辑目的，超出可审查规模时拆分；确需一次交付的，在描述中说明无法拆分的原因。
- Linear 工作流下必须给出可解析的精确目标远端 ref；只有解析结果确为仓库默认分支时才可写“默认分支”。开始实现前记录目标 ref 和 base SHA，分支与 worktree 必须从该基线创建。
- Linear 普通任务默认以 `origin/develop` 为基线；只有 hotfix 以 `origin/main` 为基线。发布提升和回同步使用 `Refs <ISSUE-ID>`，不得用 closing magic word 重复关闭已完成开发 Issue。普通任务 closing PR 合入 `develop` 即为 Done，该合入不要求远端 CI。
- 顺序执行且工作区干净时，任务分支可在当前 clone 创建；并发 Agent、脏工作区、存在无关改动或明确要求隔离时，必须使用仓库外 worktree。该优化不改变“一任务一分支一 closing PR/MR”。
- 创建 PR/MR 前重新读取远端目标 ref 和 source HEAD，校验提供方所选 base 等于已声明目标 ref，并计算 merge-base。merge-base 必须等于冻结 base SHA，或是该 SHA 在同一目标 ref 历史上的已验证后代；否则停止创建并报告基线不一致。
- GitHub PR 与 GitLab MR 的标题、source、target、描述和 closing 语义都必须在创建后重读确认。Linear 分支和标题保留 Issue ID；closing 描述使用 `Fixes <ISSUE-ID>`，只有提供方配置并经重读确认的等价语法才可替代；closing 词不放在 commit 中。

## 同步与历史

- 只改写自己尚未推送的提交；共享分支上已推送的历史不得通过 rebase、amend 或 force push 修改。
- 需要同步尚未推送的分支时优先用 `--force-with-lease` 而不是 `--force`，推送前重新读取远端 SHA 确认没有被他人更新。
- 任务分支落后于目标 ref 时默认 rebase 到最新目标 ref；仓库明确要求 merge 同步时按其约定执行，并记录选择。
- 拉取更新使用 `--ff-only` 或 rebase，不用会产生隐式 merge commit 的默认 `git pull`。
- 已推到共享分支的错误变更用 revert 加修复提交处理，保留可审计历史；不使用 reset、checkout 或历史改写抹掉已发布内容。

## 安全与敏感数据

- 密码、Secret、Token、Cookie、私钥和个人敏感数据不得进入提交、提交信息、PR/MR 描述、附件或 Git 历史；需要示例时使用占位值。
- 密钥检测分层执行：本地 Hook 扫描暂存内容，CI 与服务端保护各自独立扫描。客户端 Hook 可被绕过，本地扫描通过不作为密钥未泄露的证据。
- 发现凭据已进入历史时先轮换或吊销该凭据，再按单独授权清理历史和远端引用，并通知受影响协作者；只删除文件后继续推送不算处理。

Git credential helper 只可由其已配置的 Git transport 透明调用。仅有 Git transport 授权时不得读取、解析或转用 helper 输出进行网页或 API 登录；此类转换必须另有 `credentialUse` 与对应外部写入授权。Agent 不得把 helper 输出或原始凭据写入文件，credential query、包装脚本或其他辅助文件也不得写入仓库或 worktree。

## Git Hooks

- full profile 会安装项目级 pre-commit 和 pre-push 文件，但不会修改本地或全局 Git 配置；是否启用 `core.hooksPath` 由用户决定。
- 项目可用 husky 或其他管理器激活同一批 Hook 脚本；本仓库以 `prepare: husky` 激活 pre-commit/pre-push，并叠加 lint-staged 与 commit-msg 校验。两套机制并存时以仓库实际运行的脚本为准，不重复维护逻辑。
- Hook 只承载快速、确定的本地检查（空白与冲突标记、暂存区密钥扫描、格式与 lint）；完整验证、跨平台矩阵和发布门禁由 CI 承担。
- 客户端 Hook 可被本地用户绕过，强制策略应放在 CI 和服务端保护中。

## 参考实现边界

Vibe-Harness 自身使用 Conventional Commits、commitlint、pre-commit、pre-push、lint 和测试作为可审查的参考实现；这些检查只在用户明确授权提交后由 Git 正常触发，不构成自动提交授权。

## Worktree

- 使用 worktree 时，一个隔离单元对应一个命名分支和明确写入范围；不需要隔离时直接在当前工作区保护用户改动。
- worktree 放在仓库外部，避免被构建和依赖扫描。
- 子 Agent 只在分配的 worktree、分支和写入范围内工作；审查任务默认只读。
- merge-back 完成前不清理 worktree 或删除分支。
- 清理前确认 worktree 无未提交改动，并先用 `git worktree remove` 再用 `git worktree prune`。
- 使用 `git worktree list --porcelain -z` 获取可机器解析的 worktree 清单。

## 完成定义

- 本次任务按已授权交付边界结束；本地实现可在最终验证后交付，未合并的 worktree 只阻止宣称“已集成”。
- 只有目标分支包含 merge-back 结果且验证晚于最后一次实质修改时，才能宣称“已集成”；存在未解释改动时不得宣称相应交付边界已完成。
- 工具不可用时只给出分组清单和命令建议，不声称已经提交、推送或合并。

## 禁止项

- 不使用 `git reset --hard`、`git checkout --` 或破坏性清理覆盖用户改动，除非用户明确要求。
- 不用 force push、历史改写或远端引用删除去修复共享分支上已推送的历史。
- 不以时间间隔、文件行数、变更数量或工具调用边界触发提交。
- 本地孤立分支或未合并 worktree 可以支撑已验证的本地交付，但不能据此宣称已集成、推送或发布；未验证 commit 不支撑对应完成主张。
