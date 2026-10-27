# Git worktree 并行开发与协作审查

日期：2026-10-27。范围：governance-core、git-rules、两个显式 develop Skill、
task-decomposition、Linear/协作/测试规则，以及 runtime、Git/Agent Hooks、CI。
这是仓库实际状态审查，不是对真实 Linear 项目或远端分支保护的认证。

## 结论与本次变更

目前不需要新增调度服务、Claim、全局锁或统一审批。已有 stage/publish 将开发、
候选验证和远端更新分开，是可保留的基础。主要问题是规范仍有旧流程残留，
“低协调成本”的若干承诺没有实现支持，且候选取消和恢复存在实际缺陷。

本次已修复：

1. **P1 独立候选误取消**：旧代码只要另一事务的 base 是发布 HEAD 的祖先，
   就杀其 PID 并删除活租约；同基线的独立任务因此受影响。现在要求同 endpoint
   指纹、同 ref、全部冻结源已集成、登记的 detached 候选及有效租约归属，
   才发送协作取消请求；不杀宿主进程，不释放仍使用中的租约。
2. **P1 affected 候选验证空跑**：干净候选默认与自己的 HEAD 比较，得到空 diff，
   返回 unverified 并阻塞 stage。现在将冻结基线传入 verify；publish 重建后
   也使用新基线。测试检查实际执行脚本收到的路径与 base。
3. **P1 publish 环境失败无法恢复**：重建后超时遗留 merged 阶段，重试入口只接受
   merging 等阶段，返回 LAND_STAGE_REQUIRED。现在保存可恢复阶段与候选 HEAD，
   在基线、源提交和干净候选未变时续验原树；不重复 merge。候选脏时保留并拒绝。
4. **P2 规则与 Eval 冲突**：统一脏主检出只延迟本地同步，修正旧 land 参数说明；
   EVAL-LINEAR-043/048 不再要求脏主检出阻断或本地先同步。新增正反控，旧错误
   决策会失败；没有自动更新受保护 Eval reference。
5. **P2 拆分与重复验收**：明确切片不逐一建 Issue/worktree、复用既有单据、read
   不创建实现 worktree、只等待直接依赖；同目标已就绪节点可合批，最终候选有效
   收据已覆盖 fan-in 时直接引用。共享锁文件、生成文件、迁移有唯一 owner。
6. 校正 CI 的 develop required-gate 旧注释；用 ADR-0025 替代 ADR-0024 中的
   误取消与固定秒级承诺，保留两阶段协议和必要风险控制。

## 证据边界

- 工作区原有 `.agents/memory/CURRENT.md`、`docs/schemas/project-config.schema.json`
  和 `.claude/` 改动保留；本次不把它们当成自己的交付。
- CodeGraph 用于导航；codebase-memory 的 generation 为 2026-10-22，
  对相关代码报告 metadata_changed/not_tracked，故关键结论回退当前源码与测试。
  不因索引 ready 声称完整覆盖，不重建索引。
- 实际本机 `core.hooksPath=.husky/_`，`.husky/pre-push` 调用已安装 git-hook；
  `.githooks` 是另一入口，不能据其文件存在断言当前启用。
- 行为验证使用临时仓库和本地 bare 远端，不操作真实 Linear、远端引用、
  GitHub ruleset、生产数据库或凭据。服务器保护、实际 CI 耗时和外部状态自动化
  未经在线核验，下面标为静态结论或待验证。

## 实际端到端链路

| 环节与触发 | 输入 → 输出 | 实际实现、责任与依赖 | 阻塞范围 |
| --- | --- | --- | --- |
| 拆分：存在独立交付或实际协作 | 验收、范围、资源 → 顺序切片或 DAG | Agent 判断；task-decomposition 提供合同；linear-planning 仅估算，task-dag 仅校验，不派发 | 未定共享契约阻塞消费方；普通任务无需 DAG |
| Linear 建单：明确授权的当前计划 | 已确认节点、身份、原生依赖 → Issue ID 与读回状态 | Skill 指导宿主 MCP；仓库无持续建单/调度 worker。已有 Issue 复用，单节点无需 Parent | 未尝试写入且上下文充分可本地继续；写入结果未知先重读相关对象 |
| 创建分支/worktree：需要隔离 | canonical root、分支、冻结 base SHA → 登记 worktree | bootstrap 默认 dry-run，--write 后 add；宿主已建树可采用。任务 writer 负责；read 不建实现树 | 分支冲突、越界、缺依赖等只阻塞该任务 |
| 环境准备 | 配置、依赖、mirrors、端口/env → 可用环境 | bootstrap 链接依赖、overlay、治理面，短锁登记端口；setupCommands 显式配置 | 缺失或共享资源冲突阻塞相关任务；不是完整容器/DB 隔离器 |
| 开发与提交 | 冻结契约、writeScope → 干净源提交 | writer 只修改归属路径；pre-commit 扫 staged diff，Husky 另跑 lint-staged | 本任务检查失败或未归属改动；不触发所有任务统一等待 |
| 局部验证 | 实际改动、配置 → 检查结果/收据 | verify 默认 quick；显式层累计升级，CLI focused 与 runtime tier 不是同一选项路径 | 必需失败阻塞受影响节点及直接后继；deferred 不冒充通过 |
| 审查 | diff、验收、原始验证 → 风险发现或审查证据 | Agent 自审；GitHub PR 的 independent-review 为 required；approval 脚本默认 shadow；本地 stage 没有同等 PR job | 项目明确审批仍阻塞相应交付；不自动派发审查 Agent |
| stage：源提交干净且已就绪 | 本地 develop、一个或多个冻结源 → 合并候选、私有 ref、batchId、local_staged | detached no-ff 候选，按风险选 tier，在 FIFO 外验证；父/集成人负责最终组合 | 冲突、真实检查失败、空选择或指纹漂移；主检出脏不阻塞 |
| publish：要求远端集成 | batchId、精确目标 → integrated 或恢复状态 | 队外对账/重建/重验，finalize 入 FIFO，精确非强制 push、SHA/祖先确认；不是按任务分支先 rebase | 基线竞态有界重试；未知 push 保留现场；只影响该批 |
| 状态回写 | 已核实 Git/验收事实 → Done 或同步待处理 | Linear 操作仍由宿主执行；task anchor 是恢复导航，不能替代提供方事实 | 状态延迟不撤销 Git 集成；未知依赖写入不准猜测 ready |
| 清理与恢复 | 已确认集成、源 HEAD/dirty/资源归属 → 释放资源或 cleanup_pending | publish 队外清理；status 只读；discard 仅未发布事务；recover --task/--all 显式回收 | 残留保留资源占用，不阻塞不使用该资源的后继；未知归属不删 |

主要实现：[worktree-command](../runtime/lib/worktree-command.mjs) 的 bootstrap、
batchMergeNext、runCandidateVerification、worktreePublishReport、cleanupLand；
[队列](../runtime/lib/worktree-delivery-queue.mjs)；
[DAG 校验](../scripts/lib/task-dag.js)；[成本估算](../runtime/lib/linear-planning.mjs)。

## 仍存在的实现差距及处理建议

| 优先级 | 已核实事实、影响 | 建议与保留边界 |
| --- | --- | --- |
| P1 | publish 用普通 runGit push，Hook 从主检出执行；prePush 无条件跑 lint/typecheck/test，不读 stdin 中待推 SHA，不使用候选收据。可重跑错误工作区并长时间占队首 | 下一步实现受认证、绑定精确 SHA/tree/环境的 Hook 证据消费；无证明正常运行。不能简单 --no-verify 或自填“已验证”环境变量 |
| P1 | stage 的 highRisk 正则与 scripts/lib/verification-plan.js 分类器分离；无 full 锚点时，runtime、部分 CI/锁文件路径可留在 quick。远端重建沿用旧 tier | 统一可随 runtime 安装的风险分类器；至少在 stage 与每次重建重新判定组合影响。当前操作仍按项目规则显式 --tier standard，不能把自动默认当完整风险覆盖 |
| P1 | prepareBatchCandidate 复制第一源的端口/env，依赖及治理目录可共享链接；resourceClass=repo-heavy 只是元数据，无资源仲裁 | 不能宣称候选全资源隔离。端口/DB/schema/容器/写缓存需项目显式配置独立实例，或只串行相应检查；共享依赖变更禁用可写共享链接 |
| P2 | task-dag 的 finishDag 在任一 error 时清空全图 ready；scope/resource 冲突也属于 error | 当前按相关、完整依赖闭包作限域校验；后续区分结构无效与局部冲突，测试无关节点可派发。不能直接忽略整个命令失败 |
| P2 | chooseExecutionMode 默认要求节省 ≥45 分钟且 ≥25%，短小但有利的并行会被否；成本估算不提供调度执行或资源锁互斥 | 将其视为当前 v2 策略而非实测最优阈值，先记录真实建树/交接/fan-in 成本再调整；不为满足阈值人为扩大任务 |
| P2 | CONTRIBUTING 要求高风险本地直落也有独立审查收据；Linear 规则则称可选，runtime 不强制等同 PR 审查。independent-review required 是配置事实；high-risk-approval 的内部模式仍默认 shadow，远端 ruleset 未读取 | 此项保留为政策冲突，未静默删除高风险要求；高风险 PR 继续遵循现行 CI，直接交付前须按项目要求取得审查。后续集中为一个 delivery 策略真值 |
| P2 | archiveIntegratedTransaction 在外部已包含全部源时回收候选/ref，但未走 cleanupLand 清理源树/端口；后续入口又不接受 archived_integrated 普通 publish | 集成已成立，但资源回收闭环仍不完整；应增加幂等 cleanup-only 路径。当前保留源树并盘点，不能宣称自动彻底清理 |
| P2 | bootstrap 有端口登记，服务监督有归属检查，但未实现通用 DB、跨机锁、全局端口仲裁；候选取消只在检查之间轮询 | 真正隔离需项目 provision/服务配置；不把目录隔离当数据库隔离，不把 cancel-requested 当进程已停 |
| P2 | 线上 Linear 的回写/幂等键只是 Skill 合同，仓库没有 durable outbox 或 provider 事件消费；描述/快照/锚点都可能过期 | Linear 原生关系负责依赖，Git 负责集成，锚点只引用证据；不增加第四份状态表。未知写入先重读，普通状态延迟不回滚已集成事实 |

上述未实现项没有靠修改文案伪装完成。本次不引入未验证的凭据桥、
跨机器缓存信任机制、外部状态同步服务或共享资源调度器。

## 验证、复用与 CI 的真实边界

| 层/时机 | 当前实际行为 | 可复用条件与调度建议 |
| --- | --- | --- |
| 开发中的局部反馈 | 运行选中检查；未知影响不能视作零影响 | 同状态有效结果不重复；真实失败修复后重跑同一受影响判据 |
| 源任务 → stage | 新 detached 候选；默认 workspace 缓存通常不命中 | 相同整树且显式 tree-content + deterministic 时才可跨树命中；默认配置没有启用这一模式 |
| stage → publish，基线未动 | 使用已暂存候选结果，不重复显式 candidate verify | 保留精确候选/source/ref/endpoint 核验；原生 pre-push 仍可能重跑 |
| publish，基线前进 | 重建最终组合候选并验证；失败不放行 | 整树变更使现有 per-check tree 缓存失效；不是“只重跑受影响路径” |
| 环境失败重试 | 本次修复后，稳定候选可续验 | 必须同基线、冻结源、候选 HEAD、干净状态；代码/配置/依赖/环境变化不能复用旧通过 |
| Parent fan-in | 对照最终组合树与整体验收 | stage/publish 已有收据覆盖相同验收时直接引用；不能引用多个互不组合的子任务结果代替 |
| PR CI | change-plan 后，非 full 走 Ubuntu/Windows fast，按影响追加 integration/smoke；full 跳过这些独立 jobs，执行 full-gate | 两个 OS 提供不同覆盖，不是简单重复；未验证跨平台前不能删一个平台 |
| main/nightly/manual | FORCE_FULL，完整矩阵；独立 online Eval workflow | 深层可后台，但必需证据未完成不能合并/发布；当前 develop push 不触发 CI，不能假定“稍后 CI 会补” |

[verification-receipt](../runtime/lib/verification-receipt.mjs) 的 key 包含命令/cwd、
整树或 workspace 指纹、配置/lockfile 等 inputs、工具版本、平台、架构、运行器实现、
环境值摘要；selection 另含 tier/scope/base/changedPaths。收据有认证与 TTL。
默认环境取全部变量（排除运行 ID）；显式 envAllowlist 会缩小环境覆盖，需要项目
保证其完整。依赖安装实际内容、外部服务数据、未声明 DB/容器状态并非完整快照，
因此不能声称外部集成测试天然可跨机器复用。warm 未证明时不缓存。

CI 没有把开发机的候选证明作为可信输入，不能因 SHA 相同就跳过 CI。
full-gate 的 queue consumer 只有目录存在才执行；普通 checkout 不携带被忽略的
本地 queue，也没有在该 workflow 中上传下载队列的步骤。`--async` 因此仍需要
单独消费者，queued 不是通过，更不是后台一定会完成。

## 推荐执行顺序

1. 明确当前交付边界，复用已有 Issue/分支/环境；普通单 writer 保持顺序切片。
2. 先冻结共享接口/迁移/生成规则归属，再启动独立消费方；只等待直接依赖。
3. 各 writer 做必要局部验证，父节点按目标和共同验收合批已就绪源提交。
4. 在候选上完成必需检查；发布前发生基线前进时只在新组合上重新取得有效证据。
5. 精确远端确认后同步状态，按归属清理；同步和清理残留不反向否定已集成事实。
6. 优先修复上表 Hook、风险分类、资源隔离三项，再测真实吞吐；不先建设新流程平台。

## 本轮验证记录

已取得三个运行时修复的 RED → GREEN 证据，以及旧 Linear Eval 期望与当前
合同冲突的 RED。性能收益目前只证明减少错误取消、空范围阻塞与重复 merge，
不报告未经测量的交付提速百分比。

| 检查 | 本轮实际结果 |
| --- | --- |
| 最终聚焦回归：`node --test --test-name-pattern='保留独立候选\|冻结基线和变更路径\|publish 环境超时\|runtime help exposes\|explicit local-land decisions' tests/integration/project-worktree-command.test.js tests/integration/linear-workflow.test.js` | 5/5 passed，退出码 0；含候选被改动时保留现场并拒绝续验 |
| worktree、队列、Linear、task-dag、eval-ci 五个集成测试文件，`--test-concurrency=2 --test-timeout=600000` | 共 153 项，首次 152 passed / 1 failed，551 秒；失败为 ADR catalog 指向旧 current 条目。修正 catalog 后，安装/卸载用例单独复跑 passed，退出码 0。没有把第一次整组命令记为通过 |
| `pnpm check` | 退出码 1；lint、ESLint（0 error，有 warnings）、typecheck、validate、测试台账与 200/200 unit 通过；component 为 353/358，通过以外 5 项全部是 Eval reference / 已签入行为产物指纹漂移 |
| 最后修改后的 `pnpm typecheck` 与变更 JS 文件 ESLint | 均退出码 0；ESLint 22 warnings、0 error |
| `pnpm skills:audit` | passed，原生 16、integration 4 |
| `pnpm docs:audit`、`pnpm docs:sync` | passed；150 份文档，0 待补索引、0 manual action |
| `pnpm tests:catalog check` | passed；1431 个声明与台账一致；保留既有命名语言 warning |
| `git diff --check` | passed，退出码 0 |
| `pnpm eval:check` | failed；修改前已有 config 指纹漂移，修改后另有 rules、skills 漂移；没有重生成受保护 reference |
| 在线 Agent Eval、真实 Linear、远端 ruleset、完整 integration/e2e/matrix/smoke | 本轮未执行；五个集成文件不代表完整集成层，未声称发布就绪 |

日志保留在本地 `.vibe-harness/worktree-audit-*.log`。聚焦计划选择 standard
并将 deep 列为 deferred；计划还包含用户原有改动引起的 unknown 影响，因此
没有把计划输出当成已执行完整矩阵的证明。

Eval reference 按
[评测驱动技能](../.agents/skills/eval-driven-development/SKILL.md) 的
“reference 更新必须单独审查并显式确认”及 CONTRIBUTING 的受保护批准要求
保留原样。当前交付是本地审查报告与已验证的修复，不是全门禁通过、远端集成或
在线 Agent 提效证明；本次未提交或推送。
