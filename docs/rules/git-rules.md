# Git 规则

Git 规则的目的是保护用户改动、让提交可审查、确保 worktree 任务真正 merge-back；本地操作以本地 Git 事实为准，远端交付才核对远端事实，不用设想中的分支模型代替核实。

本规则与 `vb-git-split-push`、`vb-git-develop-flow` Skill 共享 Git 安全边界，修改须同步。

## Fast Path 卡片

- **默认路径**：编辑前后核对 `git status --short`，只暂存本任务改动，一个逻辑变更一个 commit；已验证且归属明确的本地提交与当前分支普通推送可按需执行，不是完成任务的默认动作；建分支、PR/MR、凭据等按各自授权边界执行。
- **提交信息**：主题 `<type>(<scope>): <描述>`，正文写为什么改与被否决的方案；不用 `--no-verify`，不伪造署名 trailer。
- **不变量**：归属不清的改动视为用户改动，不覆盖、不暂存、不提交；显式 split-push 调用将调用时已有修改纳入交付范围，按「启动与归属」核对排除项。凭据、私钥与个人敏感数据不进入提交、提交信息或 PR/MR。
- **任务与证据**：develop-flow 在实施前按可观察验收映射文件、关联输入、排除项及检查，小任务可一个切片；已有实现从 diff 重建。映射可随发现更新，不是永久白名单，不自动触发 DAG、Issue、多 worktree 或审批。实施用显式 paths，stage 以真实最终差异校正；有效原子结果只复用、只补缺口，不按阶段固定重跑。明确授权不因阶段、会话、重试失效，仅目标／效果／风险扩大才补充。
- **继续读全文的信号**：历史改写、force push、共享分支与门禁、worktree 隔离、合并落地、冲突处理、Hook 或跨仓协作。

以下为完整规则，仅当任务超出卡片或命中升级触发时继续读取。

## 本地 Worktree 合并

显式 `vb-git-develop-flow` 与 `vb-linear-worktree-develop` 使用 local-land：任务完成阶段验证，提交与合并阶段不重复质量验证，不访问远端，不推送。

1. 先核对源分支、HEAD、任务范围与干净工作树；主检出必须在本地 `develop`，不自动切换分支。
2. `worktree stage --task <id>:<branch> --base-ref develop --write` 记录事务和合并前 HEAD。dirty develop 自动 `git add -A` 并提交 `chore(worktree): checkpoint local develop before merge`，然后执行 no-ff 本地合并。
3. 冲突保留在主检出，解决并暂存后用 `stage --resume <id> --write` 完成 merge commit；不通过禁用 Hook 绕过安全拒绝。
4. 成功记录 `localMergeCommit` 与 `localIntegrated: true`。只自动清理 Harness 创建且归属明确、干净、分支 HEAD 未漂移并已合入的源树和分支；宿主、用户及未知归属资源保留。
5. 清理失败报告 `local_integrated_cleanup_pending`，不撤销合并。`cleanup --batch <id> --write` 只重试清理，不再次合并或验证。

`status --batch <id>` 只读展示本地 HEAD、冲突与清理。`discard --batch <id> --write` 只安全中止当前未完成合并，保留 checkpoint 和已完成提交，不 reset。仓库级短时锁串行化本地变更；冲突编辑期间不持锁，未完成事务阻止新事务抢占。

事务 v6 保存在 Git common dir。旧远端事务只读展示、恢复冲突或安全丢弃，提示“旧远端事务需迁移”，不自动访问远端。原有普通 push 与 `vb-git-split-push` 不受此本地模式改造。

显式 Parent 批次以 Parent ID 为唯一 source；全部必需成员先逐项验证和提交。本地事务保留成员提交映射，`task check --complete` 核对这些提交和 `localMergeCommit` 已是本地 develop 的祖先，返回 `deliveryStatus: local_integrated`，源树清理后仍可读取。若项目已安装该规则，Linear 写后确认、超时重读与失败恢复见 `linear-workflow.md`。

完成表述统一为“本地已合并，不代表远端已推送”；后续推送须独立显式执行。

## 启动与归属

- 编辑前运行 `git status --short`，并只处理当前任务路径。
- 普通任务中，归属不清、任务开始前已存在或来自并发工作的改动都视为用户改动，不覆盖、不暂存、不提交。用户显式调用 `$vb-git-split-push` 时，默认分析并交付调用时已有的已暂存、未暂存和未跟踪修改，不因早于本次会话而重复确认归属；用户明确限定的范围优先。冻结起始清单与内容，明确排除项、并发新增或变化、敏感内容及生成垃圾仍保留，不混入提交。
- 仅在并发工作可能冲突、脏工作区与任务范围重叠、跨仓协作或明确需要独立构建与验证环境时使用独立 worktree；普通单 Agent 局部修复不因任务类型自动创建 worktree。
- 分批交付前再次检查 working tree 与 staged diff，明确包含、排除、验证、风险和回滚方式。

## 提交与推送边界

当前任务范围内的本地普通提交与当前分支普通推送无需独立授权，也无需逐项登记 effect 或任务级授权凭证；用户显式禁止时不得执行。`workspaceWrite`、`gitBranch`、`mergeRequestWrite`、`credentialUse` 仍按 `governance-core.md` 独立授权。

- 提交不自动触发推送，普通任务完成也不要求提交或推送；只有交付确需远端可见、目标明确且安全时才推送，两者都不隐含建分支、PR/MR、凭据转用或发布授权。
- Hook 只豁免直接、单一、可判定的 `git commit -m`／`git push`；复合命令、危险参数、远端或目标分支无法核实时不豁免，Hook 也不能推断暂存内容归属，提交前仍须人工核对本任务 diff。
- 除显式 local-land 的本地 checkpoint 和 merge commit 外，Vibe-Harness 不通过 Stop Hook 或默认流程自动提交或推送；`$vb-git-split-push` 是显式调用的分组提交与普通推送流程，不是唯一入口。
- split-push 从已核实 upstream 解析唯一实际 push URL 与精确 ref；无 upstream 仅在唯一 origin 且非保护目标时显式建立跟踪。冻结 SHA，用 `git push --no-force <actual-push-url> <sha>:<exact-ref>` 并重读远端 SHA；拒绝多地址、mirror 和目标不明。
- 显式 split-push 可直接在当前 `develop` 分组提交，不创建任务分支或 worktree，不逐组请求确认。本地提交完成后允许同步当前分支的精确远端目标：从实际 push URL fetch 精确 ref 并冻结 SHA；工作区及暂存区干净且无进行中的 merge/rebase 时，相等或本地领先则继续，纯落后用 `git merge --ff-only <remote-sha>`，分叉用 `git merge --no-edit <remote-sha>`。保留已有提交 SHA，不自动 rebase、stash、解决冲突或合入其他任务分支；无共同祖先、冲突或 Hook 拒绝时保留现场并停止。有排除项或并发改动只阻止同步及推送，不撤销已完成组。
- split-push 同步改变最终树后只核对 Git 状态与最终 SHA，不追加质量验证。明确非快进拒绝时重新 fetch、安全合并、推送，最多三轮；网络失败或结果不明先回读对账，不能证明则停止。回读同一地址的精确远端 SHA，与待推 SHA 相等或经祖先检查证明包含后才确认推送成功，不据此声称产品验收通过。
- main、master、release 与实际目标的保护/共享分支不得由 split-push 自动推送；不能仅凭当前分支名判断。develop 仍遵循项目实际保护策略，任何普通推送须核实精确目标；强推、远端删除和历史重写不在范围。
- 提交前核对分组范围、Conventional Commit 主题、排除项与风险；普通 split-push 不运行 lint、typecheck、测试、Eval、构建、formatter、commitlint、验证计划或收据流程，不以历史测试日志冒充当前通过。
- 实施或受管交付需要分批验证时，证据必须绑定 staged snapshot，复用仅覆盖相同完整输入。普通 split-push 不执行该验证流程，只核对暂存范围与冻结内容、代码及对应文件齐全；暂存空白和安全扫描由 pre-commit 执行，无该 Hook 时才显式运行 `git diff --cached --check`。不创建测试候选或安装依赖，提交后记录实际 commit SHA。
- 未提交不等于任务失败。split-push 只暂存明确文件或补丁，不混入排除项；普通提交／推送不要求质量验证，也不自动修代码、修测试、同步台账或展开排障。安全拒绝、合并冲突和服务器拒绝只停止相关动作，保留已完成组；分别报告分组 SHA、合并结果和远端确认，并标注未运行质量验证。已安装 Skill 与本规则同步。

不使用 `--no-verify` 绕过项目 Git Hook；不伪造署名。独立安全检查、红区、角色权限、凭据保护与破坏性 Git 限制继续生效。

## 提交内容与信息

- 每个 commit 只承载一个逻辑变更；重构与功能变更默认拆开，提交后的状态应能通过该变更对应的聚焦检查。
- 分批提交前读取项目 Git 规范；同一逻辑能力的代码、测试、配置和必要文档一起提交，不按目录机械拆组。紧密耦合的修改合组，复用已有暂存先复核范围。默认逐组提交后统一推送；显式逐批推送时按用户范围执行，不为普通分组增加动态验收或验证门槛。
- split-push 的高风险合并包括保护分支、发布／生产分支、其他任务分支、无共同祖先及需要改变业务语义的冲突解决。先说明源、目标、影响和风险，请用户授权确认；当前 Skill 调用不隐含这些授权，已有明确覆盖授权不重复索取。冲突保留现场，未获授权不自动解决；授权不绕过宿主或服务器保护，不等于授权发布、强推或历史改写。
- 提交主题使用 `<type>(<scope>): <描述>`，常用类型为 feat、fix、docs、refactor、test、chore 和 eval；项目配置 commitlint 时其配置是类型枚举、长度和大小写的唯一事实来源。
- 提交正文说明为什么改、影响面和被否决的方案；破坏性变更用 `feat!:` 或 `BREAKING CHANGE:` footer 显式声明，不靠正文措辞暗示。
- Issue 关联写进 PR/MR 描述与 `Refs <ISSUE-ID>` 等 trailer，closing magic word 不放进 commit；完整语义以 `linear-workflow.md`（若项目已安装该规则）为准。
- 不把构建产物、依赖缓存、VCS 元数据、大体积二进制或用户未归属改动混入提交；行尾与二进制按 `.gitattributes` 处理，超大文件走 LFS 或外置存储。

本仓库 develop 的服务器 fast gate 不再作为集成分支的合并门禁；本地 no-ff 集成由显式白名单允许直落 develop，不扩展到 main/master/release。项目实际保护继续独立生效。

## 分支模型与合并

分支模型、合并语义与门禁边界以本节为唯一规范来源；Linear 的 Issue 状态、Receipt 与分支命名绑定见 `linear-workflow.md`（若项目已安装该规则）。仅远端交付核对实际远端分支、保护配置、required checks 和合并策略；不以文档声明代替已生效配置。发现不一致时先判定条款所属域，再修正漂移一侧。

- 默认分支模型：`feat/*、fix/* → develop → main`；紧急修复：`hotfix/* → main → develop`。该模型在项目显式建立对应分支后生效，尚未创建 `develop` 或迁移未完成的仓库以实际默认分支和已声明目标 ref 为准。
- 普通任务 PR 使用 squash merge；`develop → main` 的提升与 `main → develop` 的回同步使用 merge commit。squash 在目标分支生成的提交主题来自 PR/MR 标题，因此标题与提交主题使用同一 Conventional Commit 语法。
- `main` 只接受同仓库 `develop`、`hotfix/*` 和 release-please 的 PR，不使用长期 `release/*` 分支；目标项目已配置 `release/*` 时按其保护规则处理。
- 普通任务 PR 仍可由 Writer 在 envelope 授权 `mergeRequestWrite` 后自行 squash merge；`Ready to Merge` 仍只用于带发布门禁目标。
- 不同写节点可在各自 worktree 并行实现与聚焦验证；共享契约只设一名 writer。目标 ref 最终化按短租约串行，Parent 只对最终组合行为做必要的 fan-in 验证，不重复每个只读节点的矩阵；远端 merge queue 未启用不得声称已有队列门禁。
- 紧急旁路必须有明确过期时间、授权人和审计记录；不得以 advisory、跳过检查或本地标记静默绕过 required gate。

## 分支与 PR/MR

- 默认分支名使用 `<type>/<short-topic>`（只用小写字母、数字和连字符）；Linear 工作流下使用 `<type>/<ISSUE-ID>-<slug>`，与项目 worktree 校验入口的分支命名校验一致；已有任务分支或用户指定分支优先。
- main、master、release 及其他仍受保护分支上的提交与推送遵循仓库保护和人工审批；`develop` 不在其列，可直推与直落。
- PR/MR 包含摘要、风险、验证、回滚和审查备注，高风险 PR/MR 引用 Planner 风险与必要自动验证结果；标题使用 `<type>(<scope>): <描述>`，因为 squash 合并用它生成目标分支上的提交主题。
- 单个 PR/MR 尽量只承载一个逻辑目的，超出可审查规模时拆分；确需一次交付的在描述中说明无法拆分的原因。
- Linear 工作流下必须给出可解析的精确目标远端 ref，只有解析结果确为仓库默认分支时才可写“默认分支”；开始实现前记录目标 ref 和 base SHA，分支与 worktree 必须从该基线创建。
- Linear 普通任务默认以 `origin/develop` 为基线，只有 hotfix 以 `origin/main` 为基线；发布提升和回同步使用 `Refs <ISSUE-ID>`，不得用 closing magic word 重复关闭已完成开发 Issue；普通任务 closing PR 合入 `develop` 即为 Done。
- 创建 PR/MR 前重新读取远端目标 ref 和 source HEAD，校验提供方所选 base 等于已声明目标 ref 并计算 merge-base：merge-base 必须等于冻结 base SHA，或是该 SHA 在同一目标 ref 历史上的已验证后代，否则停止创建并报告基线不一致。
- GitHub PR 与 GitLab MR 的标题、source、target、描述和 closing 语义都必须在创建后重读确认；Linear 分支与标题保留 Issue ID，closing 描述使用 `Fixes <ISSUE-ID>`，只有提供方配置并经重读确认的等价语法才可替代，closing 词不放进 commit。

## 同步与历史

- 只改写自己尚未推送的提交；共享分支上已推送的历史不得通过 rebase、amend 或 force push 修改。
- 需要同步尚未推送的分支时优先用 `--force-with-lease` 而不是 `--force`，推送前重新读取远端 SHA 确认没有被他人更新。
- 任务分支落后于目标 ref 时默认 rebase 到最新目标 ref；仓库明确要求 merge 同步时按其约定执行，并记录选择。
- 拉取更新使用 `--ff-only` 或 rebase，不用会产生隐式 merge commit 的默认 `git pull`；显式 split-push 按「提交与推送边界」使用精确 fetch 与显式 merge 同步当前远端目标。只读同步类命令（`git fetch`、`git ls-remote`、`git stash list`、`git submodule status`、带 `--ff-only` 的 `git pull`）由 hook 放行，`pull --ff-only` 额外要求跟踪工作区干净（脏工作区拒绝并报 `VIBE_HARNESS_SYNC_DIRTY_TREE`），裸 `git pull` 判为会写工作区的 `workspaceWrite`。
- 已推到共享分支的错误变更用 revert 加修复提交处理，保留可审计历史；不使用 reset、checkout 或历史改写抹掉已发布内容。

## 安全与敏感数据

- 密码、Secret、Token、Cookie、私钥和个人敏感数据不得进入提交、提交信息、PR/MR 描述、附件或 Git 历史；需要示例时使用占位值。
- 密钥检测分层执行：本地 Hook 扫描暂存内容，CI 与服务端保护各自独立扫描；客户端 Hook 可被绕过，本地扫描通过不作为密钥未泄露的证据。
- 发现凭据已进入历史时先轮换或吊销该凭据，再按单独授权清理历史和远端引用并通知受影响协作者；只删除文件后继续推送不算处理。
- Git credential helper 只可由其已配置的 Git transport 透明调用：仅有 Git transport 授权时不得读取、解析或转用 helper 输出进行网页或 API 登录，此类转换必须另有 `credentialUse` 与对应外部写入授权；Agent 不得把 helper 输出或原始凭据写入文件，credential query、包装脚本或其他辅助文件也不得写入仓库或 worktree。

## Git Hooks

- full profile 会安装项目级 pre-commit 和 pre-push 文件，但不修改本地或全局 Git 配置；是否启用 `core.hooksPath` 由用户决定。
- 项目可用 husky 或其他管理器激活受管安全 Hook；普通 commit/merge/push 不自动调用 lint-staged、commitlint 或产品检查。项目外部 Hook 和服务器强制检查不绕过，失败只报告，不自动修复或关闭。
- 暂存区空白检查失败时报告安全的文件、行号和检查类别，保持非零退出；不输出 Git 附带的原始代码行或完整 diff。无法识别的错误保留拒绝，并指向仓库内的只读诊断命令。
- 客户端 Hook 可被本地用户绕过，强制策略应放在 CI 和服务端保护中。

## 参考实现边界

## Worktree

- 一个隔离单元对应一个命名分支和明确写入范围，worktree 放在仓库外部、数量不是并行目标；宿主创建的 worktree 可用 `--task <id>:<branch>` 直接归因，`worktree bootstrap` 只作为无宿主管理或需要受管端口时的 fallback。不需要隔离时直接在当前工作区保护用户改动，子 Agent 只在分配的 worktree、分支和写入范围内工作，审查任务默认只读。
- 派发前明确目标分支、依赖和共享契约的唯一写入者；writeScope 或资源重叠的任务按依赖顺序推进，过期基线与语义冲突由任务责任人解决，集成失败只暂停相关任务和后继。
- 引导、审计、交付与清理走项目脚本入口 `node .agents/runtime/commands/run.mjs worktree <list|check|bootstrap|stage|status|discard|cleanup|recover> --project . --json`：默认只读，只有追加 `--write` 才落盘；不带 `--write` 的 `bootstrap` 是步骤计划预览，`--help` 给出入口说明。该入口是安装交付内唯一的 worktree 写入面。
- `worktree stage` 要求主检出位于本地 `develop`，自动 checkpoint 后直接 no-ff 合并任务分支并记录 `localMergeCommit`，不 fetch、不读取远端、不进入发布队列、不推送；冲突通过 `--resume` 恢复。`status` 只读报告本地事实，`discard` 只允许 abort 未完成冲突事务；清理失败保留归属并只重试清理。
- 多任务 stage 按稳定顺序合并；冲突只在主检出 develop 解决。任务完成证据不触发重复质量检查。Harness 归属明确且干净的源树自动清理，宿主树和归属不明树保留。
- 依赖链接（`node_modules` junction 或 symlink）由 `worktree bootstrap` 建立并对每个本地包逐项 realpath 断言，断言失败时回滚本次新建的 worktree；`.bin`/`.bun`/`.pnpm` 等内容寻址 store 与各自带 `node_modules` 的 workspace 包由 overlay 投影，构建缓存 `.cache`/`.vite`/`.vite-temp` 跳过；`worktree check` 报告依赖链接缺失或指回主检出的事实。
- 多 worktree 并发时端口按登记表分段：`worktree.ports` 的 `base`、`blockSize`、`variables` 与 `envFile` 决定主检出保留 `[base, base+blockSize-1]`、第 n 个 worktree 占用 `[base+n*blockSize, base+(n+1)*blockSize-1]`、块内第 i 个变量取 `blockStart+i`；结果写主检出 `.vibe-harness/worktree-ports.json`，由 `.vibe-harness/worktree-ports.lock` 独占锁串行化，锁等待超时即 fail-closed 且不自动清理残留锁；端口冲突只按登记表与声明事实判定，不调用 `netstat`/`lsof` 推断分配。
- worktree 环境补齐是声明式的：`worktree.provision.setupCommands` 与 `envFiles` 由 `bootstrap` 按「worktree add →（主检出缺依赖时先 setup）→ 依赖链接 → 包级 overlay → 治理面镜像 → 端口与 env 文件 → 声明的 envFiles →（否则 setup）→ 工具链探针」执行，默认只出计划、追加 `--write` 才落盘，命中 `hooks.redZonePaths` 时还需 `--confirm-red-zone`。主检出缺少依赖（依赖根的 `node_modules` 不存在）时 `bootstrap` 以 `blocked` 结束并给出建议命令，仅当声明 `setupCommands` 时才允许 worktree 自行补齐依赖（此时 setup 先于依赖链接执行）；`worktree check` 只核对文件系统事实，不推断某条命令是否执行过。
- worktree 的治理面投影是声明式的：`worktree.mirrors` 的目录链接到主检出同名路径、文件在 worktree 侧缺失时从主检出复制一次，路径允许单段 `*` 通配（如 `frontend/internal/*/dist`），拒绝绝对路径、`..` 与空串。这用于投影被 `.gitignore` 忽略的 `.agents`、`.codex` 等治理配置；不隐含外部工具或索引管理。主检出没有的镜像项记为 `skipped` 而不使 bootstrap 失败；worktree 侧已存在的实体记为 `present` 且绝不覆盖，`worktree check` 对其报 `WORKTREE_MIRROR_STALE`；`mirrors` 缺失时按空投影处理。
- 安装交付的可执行入口（`.agents/runtime/hooks/*`、`tools/playwright-cli`、`runtime/evals/codex-runner.mjs`）按 **realpath** 判定自己是否为主模块：worktree 内经链接路径调用照常执行，只比较调用路径字符串会让 Hook 不给决策、工具入口空跑退出 0；新增入口沿用同一判定。
- worktree 内的写入只能由以该 worktree 为会话根（会话 cwd 即 worktree 根）的 Agent 完成；宿主边界策略的可写范围是项目根，主检出会话不得跨根写入 worktree，也不得以内联脚本、临时目录或改写路径触发方式绕过宿主边界。

## 完成定义

- 本次任务按已授权交付边界结束；本地实现可在最终验证后交付，未合并的 worktree 只阻止宣称“已集成”。
- 本地 `develop` 已产生 merge commit 且事务记录为 `local_integrated` 时，可以宣称“本地已集成”；不得据此宣称远端已推送或远端已集成。存在未解释改动时不得宣称相应本地交付完成。
- 工具不可用时只给出分组清单和命令建议，不声称已经提交、推送或合并。

## 禁止项

- 不使用 `git reset --hard`、`git checkout --` 或破坏性清理覆盖用户改动，除非用户明确要求。
- 不用 force push、历史改写或远端引用删除去修复共享分支上已推送的历史。
- 不以时间间隔、文件行数、变更数量或工具调用边界触发提交。
- 本地 merge commit 可以支撑本地交付和 Linear `local_integrated` 完成证据，但不能据此宣称已推送或发布。

声明式候选资源采用独立工作区身份、端口块、命名空间与缓存目录。setup/teardown 成对声明且以资源身份和步骤键幂等；具名资源只在相关检查执行时加锁，repo-heavy 只是成本提示。已集成事务可用 `worktree cleanup --batch <id>` 预览，追加 `--write` 重试清理。清理残留保留归属；同一终态重试不 merge、不验证、不 push。

显式 Parent 批次的本地 stage 在 merge commit 后记录 `local_integrated`；逐项确认子任务及 Parent Done 后仅重试清理残留。状态回写失败只补写缺失状态，不重复 merge。
