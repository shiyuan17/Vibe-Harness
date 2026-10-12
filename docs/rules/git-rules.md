# Git 规则

Git 规则的目的是保护用户改动、让提交可审查、确保 worktree 任务真正 merge-back；每个判断都以仓库实际远端事实为准，不用设想中的分支模型代替核实。

## Fast Path 卡片

- **默认路径**：编辑前后核对 `git status --short`，只暂存本任务改动，一个逻辑变更一个 commit；已验证且归属明确的本地提交与当前分支普通推送可按需执行，不是完成任务的默认动作；建分支、PR/MR、凭据等按各自授权边界执行。
- **提交信息**：主题 `<type>(<scope>): <描述>`，正文写为什么改与被否决的方案；不用 `--no-verify`，不伪造署名 trailer。
- **不变量**：归属不清的改动视为用户改动，不覆盖、不暂存、不提交；凭据、私钥与个人敏感数据不进入提交、提交信息或 PR/MR。
- **继续读全文的信号**：历史改写、force push、共享分支与门禁、worktree 隔离、合并落地、冲突处理、Hook 或跨仓协作。

以下为完整规则，仅当任务超出卡片或命中升级触发时继续读取。

## Delivery Profile 清理边界

managed-mr 的 land 只读取已合入 MR 的证据，不本地合并或推送；ancestor 快速路径保留。squash 清理须绑定 sourceBase/sourceHead、targetRef/targetBefore/targetAfter、mergeMethod/mergeCommit、patchId 和 taskId，并重读目标引用、核对整个 source diff 与单父 squash commit 的 stable patch-id、干净工作树以及当前完成收据；缺失、漂移或不一致一律 blocked。GitLab `--mr` 读取失败不得猜测已合并。cleanup 保留分支，不自动强删 squash source 分支。

## 显式 develop flow

仅显式 `gd-flow` / `$gd-flow` 或 `lwflow` / `$lwflow` 走此模式；普通 `$git-deliver`、普通 Linear Issue 和项目默认 delivery 不变。两者只对本次 `worktree land` 使用 `--delivery local-land`；`gd-flow` 不访问 Linear、不扫描任务队列、不创建 PR/MR，`lwflow` 的 Linear 范围见 `linear-workflow.md`（若项目已安装该规则）。本节与已安装的 `gd-flow` Skill 描述同一合同，修改须同步。

- 先确认主检出当前分支是 `develop`、工作树与暂存区都干净、远端可普通推送；已有无关改动不能被暂存、覆盖、stash 或合并进 flow。`git fetch origin develop` 后要求本地 `develop` 能仅以 fast-forward 更新到最新 `origin/develop`；失败则停止，不代替用户切换分支或处理别人的 worktree。
- 固定顺序为创建仓库外 worktree → 在其中创建任务分支 → 实现与聚焦验证 → 提交归属明确的改动 → 从最新 `origin/develop` 基线执行 `worktree land --write --delivery local-land --push` → 只有推送成功后才清理 worktree 和本地任务分支。`worktree bootstrap --task <id>:<branch> --base-ref origin/develop` 将前两步原子化；不通过手工 `git worktree remove` 绕过镜像 teardown。`worktree land --base-ref develop` 只断言主检出当前分支，不负责 checkout。
- land 前再次读取目标远端 SHA、主检出与任务分支 HEAD，并确认本轮验证针对最新目标基线；验证期间目标前进则暂停、重建候选与重验。高风险变更保留独立审查要求；land 的 relevance review、受管验证及任务锚点门禁不得跳过。不带 `--push` 的 land 不满足该 flow 完成条件。
- 合并冲突、验证失败、目标分支漂移、推送失败、清理失败或宿主 v2 证明缺失时保留可恢复现场并报告各阶段事实，不 force push、不强制删除、不自动回滚。推送成功而清理失败时属于“已推送、清理未完成”，不得重复合并。

## 启动与归属

- 编辑前运行 `git status --short`，并只处理当前任务路径。
- 归属不清、任务开始前已存在或来自并发工作的改动都视为用户改动，不覆盖、不暂存、不提交。
- 仅在并发工作可能冲突、脏工作区与任务范围重叠、跨仓协作或明确需要独立构建与验证环境时使用独立 worktree；普通单 Agent 局部修复不因任务类型自动创建 worktree。
- 分批交付前再次检查 working tree 与 staged diff，明确包含、排除、验证、风险和回滚方式。

## 提交与推送边界

当前任务范围内的本地普通提交与当前分支普通推送无需独立授权，也无需逐项登记 effect 或任务级 Execution Envelope 证明；用户显式禁止时不得执行，已有有效 Envelope 的 `forbiddenEffects` 优先。`workspaceWrite`、`gitBranch`、`mergeRequestWrite`、`credentialUse` 仍按 `governance-core.md` 独立授权。

- 提交不自动触发推送，普通任务完成也不要求提交或推送；只有交付确需远端可见、目标明确且安全时才推送，两者都不隐含建分支、PR/MR、凭据转用或发布授权。
- Hook 只豁免直接、单一、可判定的 `git commit -m`／`git push`；复合命令、危险参数、无效 Envelope、远端或目标分支无法核实时不豁免，Hook 也不能推断暂存内容归属，提交前仍须人工核对本任务 diff。
- Vibe-Harness 不通过 Stop Hook、运行时脚本或默认流程自动执行 `git commit`／`git push`；`$git-deliver` 是显式调用的分组提交与普通推送流程，不是唯一入口。
- `$git-deliver` 与 `worktree land --write --push` 只在已有 upstream 时普通推送；无 upstream 时仅在唯一明确远端为 origin 且目标分支非保护或共享分支时建立跟踪并推送，否则停止确认。`land` 不执行 commit，只把已提交内容合并进主检出当前分支；不带 `--push` 时不推送，收据只给出建议命令。
- main、master、release 与仓库识别出的保护分支不得由 `$git-deliver` 自动推送；`develop` 已移出保护清单，任务分支与 land 落地可直接 `git push`／`git push -u origin develop`，不需要人工审批或服务器端 required gate。强制推送、删除远端引用与历史重写不属于该 Skill 授权范围。
- 按需提交前须核对提交分组：验收点与建议 commit message、包含文件、排除文件、验证（命令及结果）、风险（低／中／高与理由）、回滚方式。
- 未提交不等于任务失败，应交付改动清单和验证证据；显式分组交付的步骤见已安装的 `git-deliver` Skill 入口，两者共享归属、验证和推送安全边界，修改须同步。

## 提交内容与信息

- 每个 commit 只承载一个逻辑变更；重构与功能变更默认拆开，提交后的状态应能通过该变更对应的聚焦检查。
- 提交主题使用 `<type>(<scope>): <描述>`，常用类型为 feat、fix、docs、refactor、test、chore 和 eval；项目配置 commitlint 时其配置是类型枚举、长度和大小写的唯一事实来源。
- 提交正文说明为什么改、影响面和被否决的方案；破坏性变更用 `feat!:` 或 `BREAKING CHANGE:` footer 显式声明，不靠正文措辞暗示。
- Issue 关联写进 PR/MR 描述与 `Refs <ISSUE-ID>` 等 trailer，closing magic word 不放进 commit；完整语义以 `linear-workflow.md`（若项目已安装该规则）为准。
- 不使用 `--no-verify` 绕过项目 Git Hook；不添加未经确认的 `Co-authored-by`、`Signed-off-by` 或等价署名 trailer，需要标注 AI 参与时使用项目批准的 trailer，不伪造他人身份。
- 不把构建产物、依赖缓存、VCS 元数据、大体积二进制或用户未归属改动混入提交；行尾与二进制按 `.gitattributes` 处理，超大文件走 LFS 或外置存储。

## 分支模型与合并

分支模型、合并语义与门禁边界以本节为唯一规范来源；Linear 工作流把这些机制绑定到 Issue 状态、Receipt 与分支命名，以 `linear-workflow.md`（若项目已安装该规则）为准，仓库侧以项目自己的发布交付文档为准。发现不一致时先判定条款所属域，再修正漂移一侧。

- 默认分支模型：`feat/*、fix/* → develop → main`；紧急修复：`hotfix/* → main → develop`。该模型在项目显式建立对应分支后生效，尚未创建 `develop` 或迁移未完成的仓库以实际默认分支和已声明目标 ref 为准。
- 普通任务 PR 使用 squash merge；`develop → main` 的提升与 `main → develop` 的回同步使用 merge commit。squash 在目标分支生成的提交主题来自 PR/MR 标题，因此标题与提交主题使用同一 Conventional Commit 语法。
- `main` 只接受同仓库 `develop`、`hotfix/*` 和 release-please 的 PR，不使用长期 `release/*` 分支；目标项目已配置 `release/*` 时按其保护规则处理。
- `develop` 不配置服务器端 required gate：稳定 fast gate 聚合检查不再作为集成分支的合并门禁，集成分支接受本地 `worktree land` 的 no-ff 直落与任务分支直推，质量责任由本地候选合并验证（lint、typecheck、unit，并按变更影响追加 component/integration）与提交前检查承担；发布边界继续使用完整 required CI。
- 普通任务 PR 仍可由 Writer 在 envelope 授权 `mergeRequestWrite` 后自行 squash merge；`Ready to Merge` 仍只用于带发布门禁目标。
- 合并前的本地验证必须建立在合并时的最新 `origin/develop` 之上，目标 ref 已前进时重跑受影响检查或改用 merge queue；高风险变更的 Independent Review Receipt 缺失、过期、与 diff 不匹配或结论为 negative 时不得自行落地合并。
- 任务可隔离开发但不得同时写入同一集成目标：任务 worktree 只负责开发隔离，Parent 负责依赖顺序、冲突归属和 fan-in；共享分支 PR 在远端 merge queue 以最新目标基线重验后顺序合并，队列未启用的仓库继续遵守当前授权和人工顺序集成，不得声称远端队列门禁已生效。
- 紧急旁路必须有明确过期时间、授权人和审计记录；不得以 advisory、跳过检查或本地标记静默绕过 required gate。

## 分支与 PR/MR

- 默认分支名使用 `<type>/<short-topic>`（只用小写字母、数字和连字符）；Linear 工作流下使用 `<type>/<ISSUE-ID>-<slug>`，与项目 worktree 校验入口的分支命名校验一致；已有任务分支或用户指定分支优先。
- main、master、release 及其他仍受保护分支上的提交与推送遵循仓库保护和人工审批；`develop` 不在其列，可直推与直落。
- PR/MR 包含摘要、风险、验证、回滚和审查备注，高风险 PR/MR 说明红区确认和独立审查状态；标题使用 `<type>(<scope>): <描述>`，因为 squash 合并用它生成目标分支上的提交主题。
- 单个 PR/MR 尽量只承载一个逻辑目的，超出可审查规模时拆分；确需一次交付的在描述中说明无法拆分的原因。
- Linear 工作流下必须给出可解析的精确目标远端 ref，只有解析结果确为仓库默认分支时才可写“默认分支”；开始实现前记录目标 ref 和 base SHA，分支与 worktree 必须从该基线创建。
- Linear 普通任务默认以 `origin/develop` 为基线，只有 hotfix 以 `origin/main` 为基线；发布提升和回同步使用 `Refs <ISSUE-ID>`，不得用 closing magic word 重复关闭已完成开发 Issue；普通任务 closing PR 合入 `develop` 即为 Done。
- 顺序执行且工作区干净时，任务分支可在当前 clone 创建；并发 Agent、脏工作区、存在无关改动或明确要求隔离时必须使用仓库外 worktree。该优化不改变“一任务一分支一 closing PR/MR”。
- 创建 PR/MR 前重新读取远端目标 ref 和 source HEAD，校验提供方所选 base 等于已声明目标 ref 并计算 merge-base：merge-base 必须等于冻结 base SHA，或是该 SHA 在同一目标 ref 历史上的已验证后代，否则停止创建并报告基线不一致。
- GitHub PR 与 GitLab MR 的标题、source、target、描述和 closing 语义都必须在创建后重读确认；Linear 分支与标题保留 Issue ID，closing 描述使用 `Fixes <ISSUE-ID>`，只有提供方配置并经重读确认的等价语法才可替代，closing 词不放进 commit。

## 同步与历史

- 只改写自己尚未推送的提交；共享分支上已推送的历史不得通过 rebase、amend 或 force push 修改。
- 需要同步尚未推送的分支时优先用 `--force-with-lease` 而不是 `--force`，推送前重新读取远端 SHA 确认没有被他人更新。
- 任务分支落后于目标 ref 时默认 rebase 到最新目标 ref；仓库明确要求 merge 同步时按其约定执行，并记录选择。
- 拉取更新使用 `--ff-only` 或 rebase，不用会产生隐式 merge commit 的默认 `git pull`；只读同步类命令（`git fetch`、`git ls-remote`、`git stash list`、`git submodule status`、带 `--ff-only` 的 `git pull`）由 hook 放行，`pull --ff-only` 额外要求跟踪工作区干净（脏工作区拒绝并报 `VIBE_HARNESS_SYNC_DIRTY_TREE`），裸 `git pull` 判为会写工作区的 `workspaceWrite`。
- 已推到共享分支的错误变更用 revert 加修复提交处理，保留可审计历史；不使用 reset、checkout 或历史改写抹掉已发布内容。

## 安全与敏感数据

- 密码、Secret、Token、Cookie、私钥和个人敏感数据不得进入提交、提交信息、PR/MR 描述、附件或 Git 历史；需要示例时使用占位值。
- 密钥检测分层执行：本地 Hook 扫描暂存内容，CI 与服务端保护各自独立扫描；客户端 Hook 可被绕过，本地扫描通过不作为密钥未泄露的证据。
- 发现凭据已进入历史时先轮换或吊销该凭据，再按单独授权清理历史和远端引用并通知受影响协作者；只删除文件后继续推送不算处理。
- Git credential helper 只可由其已配置的 Git transport 透明调用：仅有 Git transport 授权时不得读取、解析或转用 helper 输出进行网页或 API 登录，此类转换必须另有 `credentialUse` 与对应外部写入授权；Agent 不得把 helper 输出或原始凭据写入文件，credential query、包装脚本或其他辅助文件也不得写入仓库或 worktree。

## Git Hooks

- full profile 会安装项目级 pre-commit 和 pre-push 文件，但不修改本地或全局 Git 配置；是否启用 `core.hooksPath` 由用户决定。
- 项目可用 husky 或其他管理器激活同一批 Hook 脚本；本仓库以 `prepare: husky` 激活 pre-commit/pre-push 并叠加 lint-staged 与 commit-msg 校验，两套机制并存时以仓库实际运行的脚本为准，不重复维护逻辑。
- Hook 只承载快速、确定的本地检查（空白与冲突标记、暂存区密钥扫描、格式与 lint）；完整验证、跨平台矩阵和发布门禁由 CI 承担。
- 客户端 Hook 可被本地用户绕过，强制策略应放在 CI 和服务端保护中。

## 参考实现边界

Vibe-Harness 自身使用 Conventional Commits、commitlint、pre-commit、pre-push、lint 和测试作为可审查的参考实现；这些检查在实际提交或推送时由 Git 正常触发，不构成自动执行提交或推送的指令。

## Worktree

- 一个隔离单元对应一个命名分支和明确写入范围，worktree 放在仓库外部、数量不是并行目标；不需要隔离时直接在当前工作区保护用户改动，子 Agent 只在分配的 worktree、分支和写入范围内工作，审查任务默认只读。
- 派发前明确目标分支、依赖和共享契约的唯一写入者；writeScope 或资源重叠的任务按依赖顺序推进，过期基线与语义冲突由任务责任人解决，集成失败只暂停相关任务和后继。
- 引导、审计与清理走项目脚本入口 `node .agents/runtime/commands/run.mjs worktree <list|check|bootstrap|land|recover|cleanup> --project . --json`：默认只读，只有追加 `--write` 才落盘；`cleanup` 在分支未并入 `worktree.baseRef` 或工作区不干净时拒绝，且从不删除分支；不带 `--write` 的 `bootstrap` 是步骤计划预览，`--help` 给出该入口自身的命令面说明。该入口是安装交付内唯一的 worktree 写入面（创建、依赖链接与清理）；源仓库开发面另有只读审计 CLI（`scripts/worktree.js`，`list|check|plan`），不随安装交付，目标项目不引入第二个写入口。
- `worktree land` 把归因 worktree 闭环回收进主检出当前分支：dry-run 只出计划；`--write` 在 Git common dir 独占锁内重新核对工作区、来源与目标基线及任务锚点，在仓库外临时候选 worktree 中执行「合并（`--no-ff`，已并入则跳过）→ 验证（默认 quick，锚点 `riskLevel=full` 时 standard）」，通过且目标与来源 HEAD、主检出与候选状态均未变化后才快进主检出，随后按授权推送、清理任务 worktree 与端口登记，并仅在推送成功后删除任务分支。合并冲突或验证失败不移动主检出并保留任务 worktree；锁超时与基线变化阻塞本次落地，残留锁不自动清理。门禁 fail-closed：目标是非保护分支（main、master、release*；`develop` 由显式白名单允许直落）、关联任务锚点单元全部完成；`--base-ref` 仅作意图断言，不带 `--push` 时不推送不删分支，`--write --no-verify` 拒绝执行。
- 临时候选 worktree 只在工作区干净时自动移除，异常残留由 `worktree recover` 报告、`--write` 只清理有归因且干净的候选，脏候选与疑似残留锁由操作者核对；本地 `land` 不创建远端合并队列，也不能代替共享分支 required checks。
- 目录已消失但 Git 元数据与分支绑定仍在的 worktree 由 `worktree check` 报 `WORKTREE_PRUNABLE_RESIDUE` 并阻塞审计通过。`worktree recover --write` 按序移除不完整 worktree（端口 env 文件在位且登记在册时跳过，仅当分支未离开基线且工作区干净时连同分支与端口登记一起移除）、prunable 残留（一次 `git worktree prune`）、孤立分支与孤立端口登记；分支删除只在存在归因证据（端口登记表条目或 prunable 清单）、分支 HEAD 等于 `worktree.baseRef` 解析出的基线 SHA 且该分支不是基线本身时发生，无引用的用户占位分支、带未并入提交的分支与登记面之外的外来 worktree 一律不动。该证据门不与「merge-back 完成前不删除分支」冲突（被删分支从未持有任何提交）；另一处分支删除只发生在 `land` 推送成功之后，并使用自带未合并拒绝保险的 `git branch -d`。
- 依赖链接（`node_modules` junction 或 symlink）由 `worktree bootstrap` 建立并对每个本地包逐项 realpath 断言，断言失败时回滚本次新建的 worktree；`.bin`/`.bun`/`.pnpm` 等内容寻址 store 与各自带 `node_modules` 的 workspace 包由 overlay 投影，构建缓存 `.cache`/`.vite`/`.vite-temp` 跳过；`worktree check` 报告依赖链接缺失或指回主检出的事实。
- 多 worktree 并发时端口按登记表分段：`worktree.ports` 的 `base`、`blockSize`、`variables` 与 `envFile` 决定主检出保留 `[base, base+blockSize-1]`、第 n 个 worktree 占用 `[base+n*blockSize, base+(n+1)*blockSize-1]`、块内第 i 个变量取 `blockStart+i`；结果写主检出 `.vibe-harness/worktree-ports.json`，由 `.vibe-harness/worktree-ports.lock` 独占锁串行化，锁等待超时即 fail-closed 且不自动清理残留锁；端口冲突只按登记表与声明事实判定，不调用 `netstat`/`lsof` 推断分配。
- worktree 环境补齐是声明式的：`worktree.provision.setupCommands` 与 `envFiles` 由 `bootstrap` 按「worktree add →（主检出缺依赖时先 setup）→ 依赖链接 → 包级 overlay → 治理面镜像 → 端口与 env 文件 → 声明的 envFiles →（否则 setup）→ 工具链探针」执行，默认只出计划、追加 `--write` 才落盘，命中 `hooks.redZonePaths` 时还需 `--confirm-red-zone`。主检出缺少依赖（依赖根的 `node_modules` 不存在）时 `bootstrap` 以 `blocked` 结束并给出建议命令，仅当声明 `setupCommands` 时才允许 worktree 自行补齐依赖（此时 setup 先于依赖链接执行）；`worktree check` 只核对文件系统事实，不推断某条命令是否执行过。
- worktree 的治理面投影是声明式的：`worktree.mirrors` 的目录链接到主检出同名路径、文件在 worktree 侧缺失时从主检出复制一次，路径允许单段 `*` 通配（如 `frontend/internal/*/dist`），拒绝绝对路径、`..` 与空串。这是让 codegraph、serena、probe、codebase-memory 在 worktree 内可取用的前提：`.agents`、`.codex`、`.codegraph`、`.serena` 等被 `.gitignore` 忽略。主检出没有的镜像项记为 `skipped` 而不使 bootstrap 失败；worktree 侧已存在的实体记为 `present` 且绝不覆盖，`worktree check` 对其报 `WORKTREE_MIRROR_STALE`；`mirrors` 缺失时按空投影处理。
- 镜像目录是链接而不是副本，复制型条目（`opencode.json`、`.serena/project.yml`）留在 worktree 内由 Git 处理：移除 worktree 前必须先走 `worktree remove`/`land`/`recover` 的 teardown（先删除镜像链接再 `git worktree remove`），不要对含链接的 worktree 直接递归删除——穿过 junction 会伤到主检出的 `.agents` 或 `.codegraph`。
- 安装交付的可执行入口（`.agents/runtime/hooks/*`、`tools/rtk`、`tools/playwright-cli`、`runtime/evals/codex-runner.mjs`）按 **realpath** 判定自己是否为主模块：worktree 内经链接路径调用照常执行，只比较调用路径字符串会让 Hook 不给决策、RTK 入口空跑退出 0；新增入口沿用同一判定。
- worktree 内的写入只能由以该 worktree 为会话根（会话 cwd 即 worktree 根）的 Agent 完成；宿主边界策略的可写范围是项目根，主检出会话不得跨根写入 worktree，也不得以内联脚本、临时目录或改写路径触发方式绕过宿主边界。
- merge-back 完成前不清理 worktree 或删除分支，闭环回收按 `worktree land` 的步骤顺序执行（推送先于清理，分支删除仅在推送成功后）；清理前确认无未提交改动，先 `git worktree remove` 再 `git worktree prune`，清单以 `git worktree list --porcelain -z` 为准。

## 完成定义

- 本次任务按已授权交付边界结束；本地实现可在最终验证后交付，未合并的 worktree 只阻止宣称“已集成”。
- 只有目标分支包含 merge-back 结果且验证晚于最后一次实质修改时，才能宣称“已集成”；`worktree land` 的 passed 收据（merged、verified、pushed）是该状态的机读证据。存在未解释改动时不得宣称相应交付边界已完成。
- 工具不可用时只给出分组清单和命令建议，不声称已经提交、推送或合并。

## 禁止项

- 不使用 `git reset --hard`、`git checkout --` 或破坏性清理覆盖用户改动，除非用户明确要求。
- 不用 force push、历史改写或远端引用删除去修复共享分支上已推送的历史。
- 不以时间间隔、文件行数、变更数量或工具调用边界触发提交。
- 本地孤立分支或未合并 worktree 可以支撑已验证的本地交付，但不能据此宣称已集成、推送或发布；未验证 commit 不支撑对应完成主张。
