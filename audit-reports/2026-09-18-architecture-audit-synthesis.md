# Vibe-Harness 架构级审查三方综合 · 结论与分阶段改进路线

- 日期：2026-09-18
- 状态：综合结论与分阶段路线已评审；P0–P2 按批次另行启动，本文档本身不修改任何规则、代码或配置。
- 基线：HEAD `6bdf300`（分支 `codex/governance-audit-batch`，工作区干净）。
- 输入：三份独立审查——本仓库 ZCode 架构级审查（2026-09-18，会话内完成）、外部 gpt6 报告、外部 dsk 报告（均为用户提供的仓库外文档）。
- 方法：三份报告的关键主张逐条对照仓库复核（file:line 见附录 7.1）；仅经复核的主张进入 P0；两份外部报告的引用偏差与本文档对自身审查的修正见附录 7.3。
- 快照口径：本文所有计数与耗时均为 2026-09-18 快照，再生成方式见附录 7.2。

## 1. 综合结论

### 1.1 总判断

三份报告视角不同（ZCode 审查偏证据链与合同完整性、gpt6 偏控制面闭环与安全、dsk 偏实测成本与接线），但对短板的判定高度收敛：

**规则与 Skills 文本层的治理设计已相当成熟（三方一致认可覆盖面），真实短板是四个系统性断层——多真值源、控制面不闭环、能力已建未接线、证据链空转。修复主体是一批小改动而非重构；改进重心应从"继续写规则"转向"收敛真值、闭环控制面、接线已有能力、修复证据链"。**

### 1.2 断层一：同一概念多处声明，无单一真值源

三报告全部命中，是收敛度最高的问题域。

- **"默认验证什么"有 ≥4 个互不一致的答案**：
  1. `AGENTS.md`「验证选择」节自称"唯一规范来源"，主张普通变更跑 `pnpm check`（语法/资产扫描 + ESLint + typecheck + 结构校验 + tests-catalog + unit + component）；
  2. `AGENTS.md` 受管块「项目 verify 配置」主张 quick 层 = `lint + typecheck + test:unit + test:component`；
  3. `run.mjs` verify 默认按 `CHECK_ORDER = ['lint','typecheck','test','eval']`（`run.mjs:47`）执行——把受管块自己归入深度层的 `eval:replay` 放进默认流程、漏掉 `component`；
  4. `scripts/vibe-harness.js` verify（`vibe-harness.js:909-968`）按 quick tier 计算风险计划。
  两套引擎零共享模块，收据 schema 分别为 v1（`run.mjs:41`）与 v2（`scripts/lib/project-verification.js:431,563`），字段集不互通。
- **状态语义分叉**：`run.mjs:545` 把 `blocked` 折算进 `failed`（`['blocked','failed'].includes(item.status)`）；`--tier all` 被静默归一为 `deep`（`scripts/lib/validation-tiers.js:298`）；两个影响分类器（`verify-focused.js` 与 `verification-plan.js`）并存。
- **红区清单多处独立声明**：`scripts/lib/manifest.js:248` `RED_ZONE_PATTERNS`（15 条正则）、`runtime/hooks/lib/context.mjs:12-32` `DEFAULT_RED_ZONE_PATHS` + `:34-50` `CONTROL_PLANE_PATHS`、`scripts/lib/project-config.js:31-41` 字面量 + 适配器前缀、`adapters/install-map.json` 逐条 `redZone` 标志、`vibe-harness.config.json:65-76` 生成默认。`context.mjs:6-12` 注释自认靠人工同步。
- **规则↔Skill 双源 5 对**（dsk H2）：api-rules↔api-and-interface-design、eval-driven-development、frontend-rules↔frontend-design、git-rules↔git-deliver、linear-workflow 规则↔Skill，仅靠"修改须同步"的散文约束。
- `docs/rules/linear-workflow.md`（23,266 字节，全规则最大）重复声明状态映射与分支模型（dsk H3、ZCode M1/M10、gpt6 M-03）。

### 1.3 断层二：控制面未闭环（声明 ≠ 执行）

gpt6 报告的主贡献，本次全部复核属实。

- **`.githooks/` 不受红区保护**：`adapters/install-map.json:1082`（`.githooks/pre-commit`）与 `:1089`（`.githooks/pre-push`）无 `redZone` 标志（邻居 `.codex/hooks.json` 在 `:1097` 有），且不在 `manifest.js` 15 条正则、`context.mjs` 两个清单、`project-config.js` 默认、`vibe-harness.config.json` 任何一处。git hook 恰是持久化任意执行向量。已记录为 `docs/memory/TECH_DEBT.md:9`（TD-2026-09-02-1），未修。
- **角色权限预设只到投影层**：`docs/roles.md:26-31` 声明 5 个权限预设；`scripts/lib/role-projection.js:425` 据此生成 `sandbox_mode`/permission 块写进宿主配置，但 `runtime/hooks/lib/policy.mjs` 与 `execution-envelope.mjs` 对 `permissionPreset` 的引用数为 0，无真实宿主证据（TD-2026-09-15-2）。即"analysis 角色只读"只是写进了配置文件，Hook 执行层不感知。
- **跨宿主 Envelope 不等价**：gemini 与 opencode 声明 `envelopeVersions: []`、`highRiskEnforcement: "unsupported"`（`manifests/adapters.json:48,139`），其余 6 适配器为 `["v1","v2"]` + `host-required`；`scripts/lib/safety-posture.js` 与 `runtime-diagnostics.js:219-223` 对降级仅输出警告，无 fail-closed 行为。

### 1.4 断层三：能力已建未接线

dsk 报告的主贡献，复核属实。

- `run.mjs` 的 `task` 子命令（任务锚点）与 `verify --reuse` 已实现，但 `docs/`、`templates/`、`.agents/skills/`、`.agents/roles/` 中零引用；`docs/rules/governance-core.md:24` 只泛称"项目提供状态锚点入口时使用该入口"，不点名入口；`.vibe-harness/tasks/` 目录从未被创建；`.vibe-harness/backups/` 已累积 78 个目录。TD-2026-09-14-2 记录的 56 次压缩、>15 分钟无写入活锁即恢复机制实际失效的实例。
- `scripts/lib/rules-index.js:84` 按磁盘存在收录规则 → 安装后 `AGENTS.md` 命中了 5 条未安装的可选规则（`install-state.json` `requestedPlugins=[]`），命令清单同时缺 `codebase-memory-mcp`。
- `scripts/lib/task-dag.js` 已实现但无产品调用方（ZCode H8）。

### 1.5 断层四：证据金字塔倒挂（便宜侧冗重、昂贵侧空转）

- **便宜侧冗重**（dsk 实测，2026-09-17）：`pnpm check` ≈90s（component 31.6s、eslint 19.6s、lint 22.9s、typecheck 3.3s、unit 4.0s），是文档级变更也要付的默认门槛；hook matcher `.*` 拦截全部工具调用，实测每次 120-320ms。
- **昂贵侧空转**：nightly canary 名义 20 场景 × 3 次，实际全局预算 6 attempts（`harness-evals/runners/planner.js:25-30`，`remaining` 为跨场景共享预算）在最先调度的 2 个场景耗尽，其余 18 个场景 0 次尝试，覆盖塌缩至 ~10%；`.github/workflows/evals.yml:82` `continue-on-error: true`，且全 workflow 无任何步骤消费 `steps.harness-eval.outcome` → 永远绿灯（数据侧 `eval:health` 门禁读 runs 数据文件，弥补不了排程塌缩）；offline `eval:replay` 为 fixture 自洽（`model: "fixture"`）；`stub-behavioral` 场景无生产者（gpt6 H-05）；Skill/角色路由 eval 为零。

### 1.6 严重度统一裁决

三报告的严重度刻度不一致（gpt6 0 Critical / dsk 4 / ZCode 审查 2），根因是标准不同。统一标准：**Critical = 已证实会在当前主干静默产生错误结论、错误安全语义或不可信证据**。按此合并：

| 编号 | 问题 | 来源 | 统一定级 |
| --- | --- | --- | --- |
| C-1 | 验证真值分叉（4 处答案 + 双引擎 + blocked 折算） | dsk C1/C2、gpt6 H-04/M-08、ZCode H6/M9 | Critical |
| C-2 | 行为证据链断裂（canary 塌缩且永不阻断 + replay 自洽 + 无行为 runner） | ZCode C1/H7、gpt6 H-05 | Critical |
| C-3 | 红区 `.githooks` 全清单遗漏 + 清单单源缺失 | gpt6 H-01、ZCode H3（表述修正，见 7.3） | Critical |
| C-4 | 治理优先级合同洞："本地规则优先于 Vibe-Harness 默认规则"（`docs/rules/project-specific-rules.md:3`、`AGENTS.md` 末段）无不可让渡限定，本地规则文本可合法推翻硬边界 | ZCode C2、gpt6 H-06 | Critical |
| H-1 | 角色权限预设未进执行控制面 | gpt6 H-02、dsk M6 | High（P0/P1 首位） |
| H-2 | 跨宿主 Envelope 不等价且无 fail-closed | gpt6 H-03 | High |
| H-3 | 已建能力未接线（task/--reuse/task-dag/rules-index/命令清单） | dsk C4、gpt6 H-07、ZCode H8/H9 | High |
| H-4 | 验证成本结构倒挂（check 90s 默认门槛、hook 全拦截开销） | dsk C3/H1 | High |
| H-5 | 合并前置措辞歧义（`docs/rules/git-rules.md:56` 无限定全称可覆盖 `:55` 高风险收据要求） | ZCode H1 | High |

其余 Medium/Low 项归入第 2 节聚类表对应批次，不逐条重列。

### 1.7 三报告分歧裁决

| 分歧 | 裁决 | 理由 |
| --- | --- | --- |
| 新增 Skill：gpt6 明确反对 vs dsk 提议 +2（verification-planning、long-task-resume） | **0–2 个迭代内不新增** | verification-planning 的诉求由 P0-1"验证单轨化 + AGENTS 指针化"承担；long-task-resume 的诉求由 P0-5"接线 run.mjs task"承担；规则层修复比新 Skill 更符合单真值原则。P2 视路由 eval 数据再评估 code-review（规则、角色、插件三要素已备）。 |
| hook 是否硬拦 `pnpm test`（gpt6 提议） | **不硬拦**（采纳 dsk） | 避免误伤合法直跑；只做只读工具快速路径前移（P1-5），保留 fail-closed。 |
| `pnpm check` 定位 | **拆分 check:fast / check:full**（采纳 dsk） | check:fast ≈15-20s（lint.js+typecheck+unit），quick 层与 CI fast-gate 对齐；check:full 维持现状。 |
| `AGENTS.md` 手工验证矩阵去留 | **指针化**（采纳 dsk，与 gpt6"脚本生成 resident index"同向） | 删除第二真值，声明生成源；受管块已是生成物，手工节要么删除要么改为指针。 |

## 2. 问题聚类总表

| # | 聚类 | 来源 | 阶段 |
| --- | --- | --- | --- |
| 1 | 验证真值与双引擎 | dsk C1/C2、gpt6 H-04/M-08、ZCode H6/M9/M15 | P0 |
| 2 | 红区与控制面安全（.githooks、清单单源、角色权限、跨宿主） | gpt6 H-01/H-02/H-03、ZCode H3、dsk M6 | P0（执行化在 P1） |
| 3 | 行为证据链（canary、replay 自洽、stub-behavioral、路由 eval） | ZCode C1/H7/H12、gpt6 H-05/M-02 | P0 修复 + P1 runner |
| 4 | 治理合同（优先级、合并前置、模式组合） | ZCode C2/H1/M3、gpt6 H-06 | P0 |
| 5 | 已建能力接线（task/--reuse/task-dag/rules-index/命令清单） | dsk C4/H4/M4、ZCode H8/H9/H2、gpt6 H-07 部分 | P0 |
| 6 | 验证成本结构（check 90s、hook ".*"、CI 冗余） | dsk C3/H1、ZCode M6/M7/M8 | P1 |
| 7 | 规则层重复漂移（5 对规则↔Skill、linear-workflow 23KB） | dsk H2/H3、ZCode M1/M10、gpt6 M-03 | P1 |
| 8 | 测试台账粒度（cases.json 1013 条无 covers、三套清单） | dsk H5、gpt6 M-04、ZCode M14 | P1/P2 |
| 9 | 记忆与恢复（双记忆陈旧、锚点手动、worktree 崩溃恢复、安装器耦合） | dsk H6/M2、gpt6 M-11/H-07、ZCode H10/H11/M12 | P1 |
| 10 | 结构性债（run.mjs 2682 行、4 处 eval 目录、CLI 语义、备份 78 目录、成本遥测） | ZCode H9、gpt6 L-03/M-09/M-06、dsk M1/P2 | P2 |

## 3. P0 路线：合同与证据止血（1 个迭代，全部小改动）

> 实施约束：P0-2/P0-3/P0-4 触及 `adapters/`、`runtime/`、`docs/rules/`、`.github/workflows/`、`scripts/` 等高风险路径，按 `docs/rules/linear-workflow.md:39` 与 `docs/rules/git-rules.md:55`，PR 须携带 Risk Evidence 章节与 Independent Review Receipt（当前 shadow 模式不阻断，但收据缺失或与 diff 不匹配时不得自行落地合并）。

### 3.1 P0-1 验证真值单轨化（C-1）

**问题**：见 1.2 第一条与 1.6 C-1。

**改动**：

1. `run.mjs:545` blocked 不再折算 failed：收据将 `blocked` 单列为终态（`status: 'blocked'` 或新增 `blockedChecks` 字段），`SCHEMA_VERSION` 1→2；`--plan` 输出同步。
2. 明确两引擎边界：`run.mjs` verify 委托 `scripts/lib/project-verification.js`（统一 schemaVersion 2），或在两处收据中显式声明 `engine` 标识与适用范围；二选一，不做中间态。
3. `AGENTS.md`「验证选择」节指针化：删除重复矩阵或声明"本表由 X 生成，手改无效"，使全仓只剩一处完整验证命令清单。
4. `docs/rules/governance-core.md:19` 与 `docs/rules/test-rules.md` 的默认验证描述与 quick 层实际命令对齐（`eval:replay` 归深度层、`component` 归 quick 层）。
5. `scripts/lib/validation-tiers.js:298` `--tier all` 实义化（显式别名并文档化）或直接移除。
6. `verify-focused.js` 与 `verification-plan.js` 影响分类器合一。

**验证**：`pnpm test:unit`、`pnpm test:component`（收据与分类器契约用例）、`pnpm test:integration`（verify 集成用例）。

**完成标准**：全仓 `rg` 不存在第二处完整验证命令清单；blocked 语义有单测覆盖；两引擎收据可互认或有显式边界声明。

### 3.2 P0-2 红区单源化与 `.githooks` 补漏（C-3）

**问题**：`.githooks` 缺于全部 6 处清单（见 1.3）；清单多处独立声明靠人工同步。既有 `tests/component/red-zone-consistency.test.js` 已守护源级清单互相一致（含 4 组负控），但其结构上只能发现"清单之间不一致"，无法发现"全清单一致遗漏"——`.githooks` 正是实例（TD-2026-09-02-1 自认 `validateRedZoneConsistency` 不可见）；`project-config.js` 派生也不在其守护范围。

**改动**：

1. `adapters/install-map.json:1082,1089` 两条 `.githooks` 条目加 `redZone: true`（对齐 `:1097` 的 `.codex/hooks.json`）。
2. `.githooks/` 进入 `context.mjs` `DEFAULT_RED_ZONE_PATHS` 与 `manifest.js` `RED_ZONE_PATTERNS`——注意二者必须与第 1 步同批落地，否则 `validateRedZoneConsistency` 会报"运行时红区路径无安装期门禁"（该测试第 4 用例即为此回归设计的样板）。
3. 单源化：以一份规范清单（如 `manifests/red-zone.json`）生成 `manifest.js` 正则、`context.mjs` 默认清单、`project-config.js` 默认；安装时投影为运行时数据文件（runtime hook 不依赖源 `manifests/`，需通过 install-map 投影交付）。
4. 等值测试升级：增加"规范清单显式声明完整期望集"断言——任一派生缺项即红，使"全清单一致遗漏"可检测；`project-config.js` 派生纳入守护范围。

**验证**：`pnpm test:integration`（红区一致性与安装用例）、`pnpm smoke:lifecycle`、dry-run 写 `.githooks` 的行为证据。

**完成标准**：dry-run 写 `.githooks` 需 `--confirm-red-zone`；等值测试（含全清单遗漏负控）进入 `test:unit`/`test:component`；TD-2026-09-02-1 关闭。

### 3.3 P0-3 nightly canary 修复（C-2 的排程部分）

**问题**：见 1.5 第二条。全局预算 6 attempts + `continue-on-error` + 无 outcome 消费 = 永远绿灯的空转 canary。

**改动**：

1. `harness-evals/runners/planner.js:25-30`：`remaining` 全局预算改为每场景预算（`--attempts` 语义 per-scenario，可选保留全局上限开关）。
2. `.github/workflows/evals.yml:82`：移除 `continue-on-error`，或新增引用 `steps.harness-eval.outcome` 的显式门禁步骤（推荐后者，保留夜间调度不中断的观测性）。
3. `HARNESS_EVAL_ATTEMPTS`（`evals.yml:85`，默认 '6'）语义随第 1 步修正并同步文档。
4. blocked≠failed 语义联动 P0-1（eval 收据与 verify 收据共用状态枚举）。
5. 补一条"排程塌缩下数据侧信号不失真"的用例：`eval:health` 门禁在 0-attempt 场景存在时的行为有断言。

**验证**：`pnpm eval:check`、`pnpm test:integration`（eval-ci 用例断言 workflow 内容）、`node scripts/harness-evals.js plan --tier nightly` 输出核对。

**完成标准**：nightly 计划显示 20 场景 × 3 = 60 attempts；人为注入失败时 workflow 必红。

### 3.4 P0-4 治理合同小修（C-4 + H-5）

**问题**：优先级条款无不可让渡限定（C-4）；`git-rules.md:56` 无限定全称与 `:55` 高风险收据要求形成文内歧义（H-5）；`response-modes.md:20` 组合规则引用不存在的"主任务模式/表达修饰模式"分类（18 个模式目录无此分组）。

**改动**：

1. `docs/rules/project-specific-rules.md:3` 与 `AGENTS.md` 规则优先级段加限定："不得让渡 `governance-core.md` 的授权边界、红区与证据标准"。
2. 落地统一优先级矩阵（写入 `governance-core.md` 硬边界节或单独 ADR）：平台系统与宿主约束 > 用户本轮明确指令 > governance-core 硬边界（授权、红区、证据标准——不可被下述任何层让渡或弱化）> 目标项目本地规则 > Vibe-Harness 领域规则 > Skill/角色/模式层 > 任务记录/记忆/三方插件输出。
3. `docs/rules/git-rules.md:56` 加"变更不含高风险路径时"限定，与 `:55` 收据要求显式衔接。
4. `docs/rules/response-modes.md:20` 修正：为模式目录补主/修饰分类，或简化为"至多组合两个模式且同组不叠加"。

**验证**：`pnpm check`（内含文档校验）；涉及 `docs/rules/` 高风险路径按本节开头约束携带收据。

**完成标准**：三处优先级表述（模板、AGENTS 投影、governance-core）逐字一致或显式引用同一来源；`git-rules` 两行合读无歧义；模式组合规则可执行。

### 3.5 P0-5 已建能力接线与文档同步（H-3）

**问题**：见 1.4。

**改动**：

1. `docs/rules/governance-core.md:24` 泛称改为具名入口：`node .agents/runtime/commands/run.mjs task init|update`、`verify --reuse`、`.vibe-harness/tasks/` 路径；`AGENTS.md` 受管块命令清单同步。
2. `AGENTS.md` 命令清单补 `codebase-memory-mcp`；`scripts/lib/rules-index.js:84` 按 `install-state.json` `requestedPlugins` 过滤（或在 AGENTS 中逐条标注"未安装即跳过"，二选一，倾向前者）。
3. `skills/core/systematic-debugging/find-polluter.sh` 修 3 处缺陷：`SKILL.md:18` 用法与实际签名对齐（`<file_or_dir_to_check> <test_pattern>`，见脚本 `:3,:9`）；测试命令参数化替代硬编码 `npm test`（`:42`）；找到污染者时 `exit 1` 的退出码语义文档化（`:57`，或改为 `exit 0` 并在输出中标记，二选一但须与 SKILL.md 一致）。
4. `scripts/lib/task-dag.js`：接入产品调用方，或在文件头与 `AGENTS.md` 显式标注"预留未启用"，消除静默死代码。

**验证**：`pnpm check`；`rg` 核对 task/--reuse 在 governance-core 与 AGENTS 有具名引用；重装投影后 AGENTS 不再列出未安装规则。

**完成标准**：接线断言进入 `tests/component/docs-projection.test.js` 或 rules-index 用例；下一个长任务实际创建 `.vibe-harness/tasks/`。

## 4. P1 路线：控制面闭环与成本结构（1-2 个迭代）

1. **角色权限执行化**（H-1）：`policy.mjs`/`execution-envelope.mjs` 消费 `permissionPreset`（read-only 预设 → deny 写 effects）；≥1 个真实宿主负控测试（如 test-lead 尝试写被拒）；关闭 TD-2026-09-15-2。
2. **跨宿主 fail-closed**（H-2）：unsupported envelope 在 install/verify 报告中显式降级状态 + 高风险操作默认拒绝选项；`runtime-diagnostics.js` 的 `HOOK_ENFORCEMENT_UNVERIFIED` 从纯警告升级为可配置阻断。
3. **stub-behavioral 最小 runner**（C-2 的生产者侧）：先覆盖 3-5 个核心场景（红区拒绝、blocked 语义、优先级让渡），关闭 gpt6 H-05。
4. **check:fast / check:full 拆分**（H-4 便宜侧）：check:fast ≈15-20s（lint.js + typecheck + unit）；quick 层与 CI fast-gate 对齐 check:fast。
5. **hook 只读快速路径前移**（H-4）：bootstrap 内联只读工具白名单判定，写类工具才进入完整 policy；保留 fail-closed 与 10s 宿主超时预算。
6. **规则↔Skill parity 测试 + linear-workflow 瘦身**（聚类 7）：建立映射表与 parity 测试（含负控）；`linear-workflow.md` 状态映射指向 `ai-collab-rules.md`、分支模型指向 `git-rules.md`（遵守 `pack-validation.js:482-500` 长段落重复门禁，改表格/引用而非复制）。
7. **memory 单入口 + 新鲜度**（聚类 9）：`CURRENT.md` 唯一入口、`PROJECT_STATE.md` 引用不复制；新鲜度与 HEAD 绑定检查。
8. **worktree 崩溃恢复 + 安装器解耦**（聚类 9）：crash-safe bootstrap（残留检测、孤立分支清理）；安装器退出工具运行时管理。
9. **双调试技能判别 + 路由 eval**（聚类 3）：debugging/bug-finding 描述显式分工；路由 eval 达到最小覆盖。
10. **CI 去冗余**（聚类 6）：docs-only 变更跳过 eslint/typecheck（变更路径过滤）；release-verify 复用 change-plan 产物。

## 5. P2 路线：结构性收敛（按排期）

- `run.mjs`（2682 行）/ `install-planner` / `vibe-harness.js` 拆分；4 处 eval 目录（`evals/`、`harness-evals/`、`runtime/evals/`、`.agents/evals/`）收敛为一。
- `tests/cases.json`（1013 条）加 `covers` 字段 → `verify:focused` 从整层聚焦到文件级；测试台账瘦身。
- `manifests/roles.json` routingOrder 对齐（senior-engineer 作为默认实现角色不应排最后）；角色共享前导（`roles/base.md` ×7 复制）生成化。
- response-modes 18 个模式收敛为少数核心、显式为主；长任务模糊门槛量化（60 分钟/压缩次数 → 上下文水位信号）。
- 备份滚动保留（78 目录/18.7MB → 保留策略）；成本遥测（gpt6 M-06）；offline/online 指纹统一 asset registry（gpt6 M-07）；CLI 语义统一 `--project/--target/--targets`（gpt6 M-09）。
- code-review Skill 条件评估：路由 eval 显示缺口才新增，其余维持不新增。

## 6. 生效度量

| 维度 | 现状（2026-09-18） | 目标 |
| --- | --- | --- |
| canary 排程 | nightly 计划 6 attempts / 20 场景，~10% 覆盖 | 60 attempts，20 场景全覆盖 |
| canary 门禁 | `continue-on-error`，无 outcome 消费 | 注入失败必红 |
| 验证命令清单处数 | ≥4 处互不一致 | 1 处（其余为指针） |
| blocked 语义 | 折算为 failed | 单列终态，有单测 |
| `.githooks` 保护 | 6 处清单全部缺失 | 写入需 `--confirm-red-zone`；全清单遗漏负控入测试 |
| 接线 | task/--reuse 零文档引用 | governance-core 与 AGENTS 具名引用；长任务实际创建 `.vibe-harness/tasks/` |
| 快速验证成本 | `pnpm check` ≈90s | check:fast ≤20s（dsk 实测基准） |

## 7. 附录

### 7.1 已复核证据索引（file:line，基线 6bdf300）

| 主张 | 证据 |
| --- | --- |
| run.mjs 固定命令序、无 tier | `.agents/runtime/commands/run.mjs:47`（`CHECK_ORDER`）、`:348-362`（`configuredChecks`）、`:41`（`SCHEMA_VERSION = 1`） |
| blocked 折算为 failed | `run.mjs:545`（`['blocked','failed'].includes(item.status)`）、`:549` |
| vibe-harness verify tier 计划与 schema v2 | `scripts/vibe-harness.js:909-968`、`scripts/lib/project-verification.js:431,563`、`scripts/lib/validation-tiers.js:27`（默认 quick） |
| `--tier all` 归一为 deep | `scripts/lib/validation-tiers.js:298` |
| `.githooks` 无 redZone 标志 | `adapters/install-map.json:1082,1089`（对照 `:1097` `.codex/hooks.json` 有） |
| `.githooks` 缺于运行时清单 | `runtime/hooks/lib/context.mjs:12-32`（`DEFAULT_RED_ZONE_PATHS`）、`:34-50`（`CONTROL_PLANE_PATHS`） |
| `.githooks` 缺于安装期正则 | `scripts/lib/manifest.js:248`（`RED_ZONE_PATTERNS`，15 条，`/\/hooks\.json$/u` 不覆盖 `.githooks/pre-commit`） |
| `.githooks` 缺于项目默认 | `scripts/lib/project-config.js:31-41`、`vibe-harness.config.json:65-76` |
| 红区一致测试存在及其盲区 | `tests/component/red-zone-consistency.test.js`（互一致 + 4 组负控；不含 project-config 派生，不能发现全清单一致遗漏） |
| 角色预设只到投影层 | `scripts/lib/role-projection.js:425`（生成 `sandbox_mode`）、`docs/roles.md:26-31`（5 预设）；`policy.mjs`/`execution-envelope.mjs` 中 `permissionPreset` 出现 0 次 |
| gemini/opencode 无 envelope | `manifests/adapters.json:48,139`（`envelopeVersions: []`、`highRiskEnforcement: "unsupported"`）；`scripts/lib/runtime-diagnostics.js:219-223` 仅警告 |
| canary 全局预算 | `harness-evals/runners/planner.js:1`（`FAST_SCENARIOS` 6 个）、`:5`（nightly 默认 3 次）、`:25-30`（`remaining` 跨场景共享） |
| canary 永不阻断 | `.github/workflows/evals.yml:80`（step id）、`:82`（`continue-on-error: true`）、`:85`（attempts 默认 '6'）；全文件无 `steps.harness-eval.outcome` 消费 |
| task/--reuse 零文档引用 | `docs/`、`templates/`、`.agents/skills/`、`.agents/roles/` 中 `rg` 零命中；`docs/rules/governance-core.md:24` 仅泛称 |
| `.vibe-harness/tasks/` 不存在 | `.vibe-harness/` 顶层 13 项无 `tasks/`；`backups/` 78 个目录 |
| cases.json 无 covers | `tests/cases.json` 1013 条，`covers` 字段 0 条（现有字段 `id/layer/file/ordinal/name/legacy/risk/owner/source/status/addedAt`） |
| find-polluter 签名不符 | `skills/core/systematic-debugging/SKILL.md:18` vs 脚本 `:3,:9`；`:42` 硬编码 `npm test`；`:57` 找到污染者 `exit 1` |
| 优先级条款无不可让渡限定 | `docs/rules/project-specific-rules.md:3`、`AGENTS.md`「规则优先级」段 |
| 合并前置文内歧义 | `docs/rules/git-rules.md:55`（高风险收据要求）vs `:56`（无限定全称） |
| 模式组合规则不可执行 | `docs/rules/response-modes.md:20`（主/修饰分类不存在于 18 模式目录） |
| 技术债对应 | `docs/memory/TECH_DEBT.md:9`（TD-2026-09-02-1）、`:44`（TD-2026-09-14-2 活锁）、`:75`（TD-2026-09-15-2） |

### 7.2 快照数据与再生成方式（2026-09-18，基线 6bdf300）

| 数据 | 值 | 来源 | 再生成方式 |
| --- | --- | --- | --- |
| `pnpm check` 耗时及分层 | ≈90s（component 31.6s / eslint 19.6s / lint 22.9s / typecheck 3.3s / unit 4.0s） | dsk 实测 | 分别计时 `pnpm test:component`、`pnpm lint:eslint` 等 |
| hook 单次调用开销 | 120-320ms（冷 318ms/热 120-161ms） | dsk 实测 | 在目标项目计时 `codex-hook.mjs` 单次调用 |
| `linear-workflow.md` 大小 | 23,266 字节 | dsk 实测 | `wc -c docs/rules/linear-workflow.md` |
| `run.mjs` 行数 | 2682 行 | ZCode 审查 | `wc -l .agents/runtime/commands/run.mjs`（安装投影对应源 `runtime/commands/run.mjs`） |
| cases.json 规模 | 1013 条 / 0 covers | 本次复核 | `node -e` 统计 `tests/cases.json` |
| backups 目录数 | 78 | 本次复核 | `ls .vibe-harness/backups \| wc -l` |
| canary 覆盖 | 6 attempts / 20 场景 | 本次复核 | `node scripts/harness-evals.js plan --tier nightly --attempts 6` |
| AGENTS 未安装规则 | 5 条（requestedPlugins=[]） | ZCode 审查 | 对照 `.vibe-harness/install-state.json` 与 `AGENTS.md` 命中索引 |

### 7.3 引用修正与自我修正

对两份外部报告的引用偏差（不改变结论，仅修正定位）：

1. gpt6 报告将 envelope 声明定位到 `adapters/` 目录；实际位于 `manifests/adapters.json:48,139`。
2. gpt6 报告称角色权限预设 3 个；`docs/roles.md:26-31` 实际声明 5 个（analysis、implementation、verification、security-review、release-readiness）。
3. dsk C2 的"run.mjs verify 默认含 eval:replay"属实；补充：`AGENTS.md` 受管块自身将 `eval:replay` 归入深度层，属多层表述互相矛盾，不止两处。

对 ZCode 审查（本输入第三份）的自我修正：

4. 原 H3 表述"红区四列表手工同步、无等值测试"中"无等值测试"不准确：`tests/component/red-zone-consistency.test.js` 已守护源级清单互一致并含 4 组负控。准确表述为：清单仍多处独立声明靠人工同步（`context.mjs:6-12` 注释自认），既有测试不能发现"全清单一致遗漏"（`.githooks` 即实例）且不覆盖 `project-config.js` 派生。C-3 定级维持——缺口本身（静默错误安全语义）成立。

### 7.4 与既有记录的衔接

| 既有记录 | 对应批次 |
| --- | --- |
| TD-2026-09-02-1（.githooks 红区缺口） | P0-2 |
| TD-2026-09-14-2（56 次压缩活锁） | P0-5（接线）+ P1 长任务自动锚点（gpt6 H-07 的 hook 触发方案） |
| TD-2026-09-15-2（角色预设未进执行层） | P1-1 |
| TD-2026-09-15-3/4/5/7（角色能力证据缺口） | P1-1 / P1-2 |
| TD-2026-09-15-8（wall-clock 断言误报） | P1 测试稳定性（随 P0-1 收据改造一并处理） |
| `docs/inventory/governance-audit-2026-09.md`（2026-09-15 治理审计） | 本文为其后续：该审计的 P0/P1 处置不与本文冲突，本文新增四断层视角与外部双报告交叉验证 |
