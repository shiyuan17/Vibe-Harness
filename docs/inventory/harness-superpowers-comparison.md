# Vibe-Harness 与 Superpowers 系统审查

审查日期：2026-09-05，处置状态更新：2026-09-14。受众：Vibe-Harness 维护者。

> 快照口径：本文全部计数为 2026-09-05 快照（处置状态栏为 2026-09-14），再生成方式为各条目引用的审计与测试命令；后续计数口径以 governance-audit-2026-09.md 的快照基准为准。

## 处置状态（2026-09-14）

审查结论中的证据基础设施缺陷已在后续批次处理，本节是唯一的处置台账；下方 Finding 正文保留 2026-09-05 的原始判定，不回溯改写。

| 条目 | 状态 | 处置证据 |
| --- | --- | --- |
| F-01 独立项目命令稳定性收据假阳性 | 已修复 | `runtime/commands/run.mjs` 的 `gitFingerprint()` 除 HEAD 与 porcelain 状态外还哈希每个变化路径的内容；`tests/project-commands.test.js` 的「verify detects a content change to an already-dirty file」锁定回归。 |
| F-02 Windows 上误判 Node 缺失 | 已修复 | `runtime/commands/run.mjs` 的 `probeExecutable()` 对绝对路径改用 `access()`，只对裸程序名调用平台 locator（`where.exe`/`which`）。 |
| F-03 Eval 指纹随结账换行形式漂移 | 已修复 | `scripts/lib/eval-assets.js` 新增 `canonicalAssetBytes()`（文本按 Git 语义 CRLF→LF，含 NUL 或非合法 UTF-8 的内容保持原字节），`scripts/harness-evals.js` 的 harness 资产哈希复用同一规则；`tests/eval-assets.test.js` 锁定「LF/CRLF 同指纹、真实文本变更仍漂移、二进制字节变更仍漂移」；reference 经 `eval reference --write --confirm-reference-update` 再生后 `eval run` 的资产诊断清零、`reference.status` 为 matched。 |
| F-04 `stub-behavioral` 是文档化 proof 但无生产者 | 已处置（文档降级 + 记账） | `docs/evals.md` 改为逐条标注生产者与边界，`stub-behavioral` 标为「无生产者、保留的合同位、属未实现计划」，资产敏感度由 Harness Evals RED 阶段承担；实现决策转为 R-03（deferred，见 R-03 行）。 |
| F-05 checkpoint 真实压缩恢复证据薄 | 已修复（2026-09-14） | 新增宿主受控压缩用例 `EVAL-EXEC-COMPACT-001`：driver 把 fixture 初始化为确定性 Git 仓库并注入携带过期 checkpoint 的 Execution Envelope v2，runner 从隔离 session store 实测宿主客户端 token 记账后把 `model_auto_compact_token_limit` 收敛到窄区间，再用 `codex exec resume` 执行第二轮；`compaction-observed` 只接受真实的 `compacted`/`context_compacted` 记录。本机实测（WSL + codex-cli 0.153.4 + deepseek-flash）：1 条真实压缩记录、隐藏测试通过、HEAD 不变、score 1；`tests/eval-runner.test.js` 与 `tests/eval-execution.test.js` 锁定 fail-closed 与「摘要不得进提示」合同。 |

## 结论先行

Vibe-Harness 与 Superpowers 已经走向两种不同但互补的成熟路径：Vibe-Harness 更像跨宿主的治理与交付内核，强项是授权边界、项目级安装事务、跨宿主能力降级、验证收据和结构化 Eval 合同；Superpowers 更像面向编码任务的方法论与行为实验室，强项是从需求到实现的连续工作法、细粒度任务执行、独立上下文审查、压缩恢复以及真实 Agent 压力评测。

当前不应把 Superpowers 的强制流程链、全任务 TDD、默认 worktree 或逐任务子 Agent 原样移植。Vibe-Harness 已有意去除固定 Planner/Reviewer 门禁，且其使用面包含安装、审计、外部工作流和多宿主治理，照搬会让简单任务重新仪式化。真正值得借鉴的是四类可嵌入现有机制的能力：

1. 用行为压力场景验证 Skill，而不只验证资产合同。
2. 在已触发拆分或协作时使用可恢复的执行账本、任务证据包和有上限的修复循环。
3. 将规格符合性与代码质量合并为一次独立复审的两个结论。
4. 用真实压缩事件验证 checkpoint 恢复，而不只模拟压缩后的单轮选择题。

本轮同时发现三个应先修复的 Vibe-Harness 当前缺陷：独立项目命令在 Windows 上误判 Node 不可用；其工作树稳定性指纹无法发现“同一已脏文件在验证期间再次变化”；Eval 资产指纹直接哈希工作树字节，导致 CRLF 结账可使批准 reference 在无语义变更时失效。修好这些证据基础设施，比增加新流程优先级更高。

## 范围、基准与证据等级

### 固定基准

| 对象 | 固定版本 | 说明 |
| --- | --- | --- |
| Vibe-Harness | `f561d4a704ac64da5c389675bcb7e64044c59bf0` | 审查开始时 HEAD；`git status --short` 为空 |
| Superpowers | [`b36e0829c6d0140e93cfef2ca599b1b07d4a7797`](https://github.com/obra/superpowers/tree/b36e0829c6d0140e93cfef2ca599b1b07d4a7797) | 默认分支 `main`，版本 6.3.0 |
| Superpowers Evals | [`bdb502f95ce8c9d6dfcde895429a652370e5cd00`](https://github.com/prime-radiant-inc/superpowers-evals/tree/bdb502f95ce8c9d6dfcde895429a652370e5cd00) | 评测仓库最新 `main`；独立于 Superpowers 主仓库发布节奏 |

Superpowers 主仓库当前不固定评测仓库为受管子模块，而是在 README 中要求单独克隆到被忽略的 `evals/`。因此本报告把主仓库 6.3.0 的产品能力与评测仓库最新能力分开归因，后者不能自动证明 6.3.0 已通过所有最新场景。

### 证据等级

- **已确认事实**：当前文件、固定提交内容或本轮命令输出直接支持。
- **静态结论**：规则、代码、测试与 CI 共同支持，但本轮未执行真实模型或对应宿主行为。
- **待验证假设**：方案合理但尚无本项目行为证据，不能用于完成声明。
- **验证受阻**：检查因平台、运行时或基础设施未形成有效通过证据。

成熟度分五级：未发现证据、规范化、实现化、已验证、持续改进。这里评价的是机制成熟度；只有真实 Agent 的可比行为结果才能把“实际效果”推进到已验证或持续改进。

## 关键发现

### F-01 高：独立项目命令的稳定性收据可能给出假阳性

**证据。** `runtime/commands/run.mjs` 的 `gitFingerprint()` 只哈希 HEAD 与 `git status --porcelain` 返回的状态和路径。一次性 Git 项目中，验证开始前 `data.txt` 已是 ` M`，验证命令再次改写该文件后，前后状态仍是同一个 ` M data.txt`；命令返回 `status: passed`、`stable: true`、`verification.status: verified`。主 CLI 使用的 `scripts/lib/project-verification.js` 会额外哈希变化路径的文件内容，相关 21 个收据与事务恢复聚焦测试全部通过。

**影响。** 安装到目标项目的独立命令入口可能把验证期间发生的真实内容变化描述为稳定，直接削弱“结果晚于最后一次实质修改”和 verification receipt 的完成主张。

**原因。** 两套验证实现发生能力漂移，独立运行器没有复用主验证器的内容快照逻辑。

**路径。** P0 统一两套快照实现；增加“验证前已脏、验证中再次改写同一路径”的回归测试；保持 CLI 输出字段不变。

### F-02 高：独立项目命令在 Windows 上误判 Node 缺失

**证据。** `runtime/commands/run.mjs` 把 `node` 映射为 `process.execPath` 后交给 `where.exe`。Windows `where.exe C:\Program Files\nodejs\node.exe` 把带冒号的绝对路径按 `path:pattern` 解析并返回错误。一次性项目中的 `node --version` 因而被标为 `MISSING_EXECUTABLE`；`tests/project-commands.test.js` 的两个用例在本轮 `pnpm check` 中分别得到 `blocked`，而预期是 `planned` 和 `passed`。

**影响。** Windows 目标项目即使使用当前 Node 运行 Vibe-Harness，也可能无法预览或执行最基本的 Node 验证命令。

**路径。** P0 对绝对可执行路径使用 `access`/`stat`，只对裸程序名调用平台 locator；补 Windows 绝对路径和含空格路径测试，并与主验证器的 `executableFor()` 形成一份共享实现。

### F-03 中：Eval reference 指纹受工作树换行形式影响

**证据。** `scripts/lib/eval-assets.js` 直接读取工作树字节。当前仓库语义内容与 HEAD 相同，但部分受管文件在工作树中是 CRLF；`pnpm test:eval` 的两个用例和 `pnpm eval:replay` 因 config、rules、skills 三组指纹不一致而失败。诊断将文本统一为 LF，或直接读取 `git show HEAD:<path>` 的字节后，三组哈希都与已提交 reference 完全一致。Hook 组无 CRLF 差异并正常匹配。

**影响。** 同一提交在不同结账状态下可能得到不同 Eval 结果，跨平台复现性不足；维护者可能误把字节形式漂移当成规则行为漂移。

**路径。** P0 按 `.gitattributes`/Git 规范化语义计算文本资产指纹，二进制保持原始字节；用 LF、CRLF、mixed 三种夹具断言同一规范内容产生相同指纹。修复后按既有 reference 人工确认流程更新基准，不能直接提升当前 reference。

### F-04 中：`stub-behavioral` 是文档化 proof，但没有生产者

**证据。** `docs/evals.md` 与两个 schema 将 proof 分为 `contract-replay`、`stub-behavioral`、`online-canary`。仓库搜索只找到前者的 `buildOfflineRun()` 和后者的 online/project evaluation 生产路径，没有找到生成 `stub-behavioral` run 的 runner。当前 38 个 core case 的 offline replay 证明 suite、oracle、scoring 与 reference 自洽，并不执行当前规则或 Skill。

**影响。** “加载当前规则、Skill、Hook 和配置并执行变异检查”的能力描述高于实际实现。规则修改在 online canary 之外缺少低成本行为层回归，恰好是 Superpowers 压力测试最值得借鉴的部分。

**路径。** P1 二选一：实现最小 `stub-behavioral` 生产路径，或在实现前把文档状态明确标为 planned/unsupported。建议复用当前 fixture、observer、allowedWritePaths 和 scoring，不引入第二套评测运行器。

### F-05 中：checkpoint 合同强，但真实压缩恢复证据薄

**证据。** Vibe-Harness v2 Execution Envelope 保存 `headSha`、`continuationCount`、`blockerCount`、目标、已完成事实和下一动作；Hook 测试覆盖 checkpoint 过期与工作区漂移。`linear-workflow-online.json` 有一个“压缩后首次决策”的单轮模拟 case，但本轮没有发现强制真实上下文压缩、恢复并检测重复任务的 execution case。Superpowers 为 Pi 在 `session_compact` 后重新注入 bootstrap，并有 `sdd-survives-compaction` 场景检查四个任务恰好执行一次。

**影响。** Vibe-Harness 能证明恢复数据结构和选择规则，尚不能证明长会话在真实压缩后不会重复执行、扩大授权或丢失未决依赖。

**路径。** P1 为支持可控压缩的宿主增加一个 execution case：压缩前完成部分任务并写入 checkpoint，压缩后从 checkpoint 与 Git 事实恢复，只执行未完成节点；断言无重复写、无新增 effect、HEAD 与 write roots 未漂移。无需增加新的常驻提示或全宿主 SessionStart Hook。

### F-06 低：协作规范精确，但缺少可复用的任务级执行证据包

**证据。** `docs/rules/ai-collab-rules.md` 已定义 Task DAG、writeScope、resourceLocks、依赖触发、失败传播和父 Agent fan-in，且测试和 online canary 覆盖这些判定。`templates/task.md` 是可选人读记录，项目不解析它；本轮未发现像 Superpowers `task-brief`、`review-package`、per-plan ledger 那样，把一个任务的要求、diff、验证和修复轮次绑定为可恢复证据包的工具。

**影响。** 对普通任务没有问题；一旦已明确触发多 Agent 或跨压缩执行，父 Agent 仍需依赖宿主状态和自由文本完成 task-to-diff-to-review 对账。该空缺不应通过恢复全局强制 Reviewer 门禁解决。

**路径。** P2 先做可选实验：只在 `SPLIT_IMPLEMENTATION`、`SPLIT_WITH_DEPENDENCIES` 或显式多 Agent 时生成临时证据包，记录任务 ID、base/head、验证 ID、审查两个结论和修复轮次。普通直接实施路径完全不进入该机制。

## 八维对比与成熟度

| 维度 | Vibe-Harness | Superpowers 6.3.0 与 Evals | 判断 |
| --- | --- | --- | --- |
| 流程设计 | 单一循环，按风险决定事实、实施与验证强度；小改动直接执行，复杂任务才规划 | brainstorming 已有 spike/bounded/architectural 三路，但三路都保留人工批准；随后 worktree、计划、TDD、执行、复审、分支收尾 | Vibe-Harness 对混合任务更轻、更通用；Superpowers 对完整功能开发的连续性更强。Vibe-Harness：已验证（规则/测试），实际 Agent 效果待 online 证据；Superpowers：持续改进（体系），本轮未跑 live eval |
| 规则约束 | 规则优先级、红区、Execution Envelope、Hook fail-closed、宿主能力降级明确 | 以强制 Skill 与提示 hard gate 驱动方法论；Hook 主要负责 bootstrap，不提供 Vibe-Harness 等价的 effect 授权合同 | Vibe-Harness 在安全与授权上明显更强；Superpowers 在流程遵从提示上更具体，但更多依赖模型遵从。前者已验证，后者实现化到持续改进 |
| 任务拆解 | 按公共契约、迁移、混合改动、上下文规模等触发拆分；DAG 处理依赖和写冲突，模板按可独立验收任务拆分 | writing-plans 强调任务自身测试周期与审查价值，步骤细到 2-5 分钟；SDD 有计划预检、task brief 和任务账本 | Vibe-Harness 的依赖与资源冲突模型更成熟；Superpowers 的执行颗粒、计划自审和恢复链更成熟。Vibe-Harness 实现化/部分已验证；Superpowers 已验证/持续改进 |
| 验证机制 | 聚焦风险计划、验证 ID、时间与 Git 指纹、passed/failed/blocked/unverified、事务恢复、offline/online Eval | 强制 RED-GREEN-REFACTOR、完成前重新验证、任务复审和最终复审；Quorum 合并 LLM QA 与确定性 post-check，缺证据为 indeterminate | Vibe-Harness 的收据和失败语义更适合平台；Superpowers 的开发过程验证和压力测试更强。Vibe-Harness 因 F-01..03 暂降为实现化；主验证器本身已验证。Superpowers 体系持续改进，但 Windows 全量门禁受阻 |
| 多 Agent 协作 | 默认单 Agent；独立并行或高风险复审才启用；DAG 精确限制范围、资源锁、派生深度和 fan-in | SDD 为每个独立任务使用新 implementer，一个 reviewer 同时给规格与质量结论，最多五轮修复并最终整体验收；同形小任务合并派发 | Vibe-Harness 的并发安全和低开销更好；Superpowers 的任务执行闭环、审查职责和成本经验更具体。Vibe-Harness 实现化，Superpowers 已验证/持续改进 |
| 上下文管理 | Skill 按 description 精确选择一个；checkpoint、Memory 边界、子 Agent 证据指针和压缩前收敛规则较强 | bootstrap 在支持的宿主启动/压缩后注入；SDD 每计划独立 ledger，任务 brief/report/diff 落盘，禁止把历史重新灌入子 Agent | 两者都重视最小上下文。Vibe-Harness 更重权限与信息边界；Superpowers 更重长任务实际恢复和 token 成本。Vibe-Harness 实现化，Superpowers 已验证 |
| 失败恢复 | 未知根因走系统排障；三次同 blocker 停止；验证区分失败与受阻；安装器有锁、preimage、事务 recovery/rollback | 系统排障四阶段；SDD 修复轮次、换 Agent/模型、breaker 与 ledger 恢复；执行计划路径遇阻会请求人工 | Vibe-Harness 的文件与授权恢复更可靠；Superpowers 的 Agent 工作循环恢复更细。Vibe-Harness 已验证，Superpowers 已验证；两者可互补 |
| 评测与持续改进 | 38 个 core offline case、30 个 online canary、7 个 execution case，reference 审批、多轮指标、隐藏测试、定时健康与 7+7 日比较；目前 online 主要绑定 Codex | 最新实验室有 86 个场景，覆盖多 Agent CLI、真实会话轨迹、前后置检查、三态 verdict、成本、并发、provenance、压缩和反迎合；live eval 与公共 CI 隔离 | Superpowers 的行为场景、跨 Agent 适配和实验运营领先；Vibe-Harness 的项目内合同、脱敏和安全约束更紧。Vibe-Harness 已验证但受 F-03/F-04 限制；Superpowers 持续改进，跨 Windows 的本轮全量验证受阻 |

## 双方优势与代价

### Vibe-Harness 的优势

- Execution Envelope v2 把授权来源、effect、工作区身份、外部目标、风险等级和 checkpoint 放在一个可验证合同里，这是 Superpowers 方法论层没有的能力。
- 安装、升级、卸载与 rollback 共用事务和 owner 模型；路径逃逸、reparse point、红区确认与用户文件保护形成了实际工程边界。
- 多宿主能力用 stable/preview/unsupported 显式降级，不把提示约束描述为 Hook 或 sandbox 的等价保护。
- 验证计划、收据、指纹、时间和失败分类适合跨项目交付，也比“刚运行了测试”更容易审计。
- 默认单 Agent 与按风险聚焦验证适合大多数日常改动，成本和用户等待更可控。

### Vibe-Harness 的短板

- 主验证器与安装后的独立项目命令重复实现，已经出现安全关键语义漂移。
- Eval 合同设计比当前执行面更完整，`stub-behavioral` 尚未落地；offline replay 对规则是否真正改变 Agent 行为没有证明力。
- checkpoint 与 DAG 更像正确的合同，还缺一次真实长会话、真实压缩、无重复执行的闭环证明。
- Review 是按需角色或规则选择，缺少在“已经使用多 Agent”这一窄场景中的标准任务证据包与修复循环。

### Superpowers 的优势

- 从需求澄清、设计、计划、实现、审查到分支收尾形成一条连贯方法论，任务边界和每一步产物都很明确。
- 最新 SDD 已吸收成本教训：同形小任务批量派发、实现任务串行、一个 reviewer 给两个结论、任务历史落盘而不是重复放进上下文。
- `receiving-code-review` 明确要求先验证反馈，再接受、拒绝或基于 YAGNI 推回；评测场景也故意混入正确、错误和过度设计建议。
- Skill authoring 使用“无 Skill 基线失败 -> 有 Skill 压力通过 -> 堵住新借口”的行为 TDD，比单纯 frontmatter/引用审计更能证明教学效果。
- Quorum 将 grader、确定性检查、轨迹缺失、成本和 provenance 分开，基础设施失败返回 indeterminate，适合持续实验。

### Superpowers 的代价与限制

- 即使 bounded 和 spike 已缩短，所有创造性任务仍要求一次人工批准；对已经清晰授权的微小改动，这比 Vibe-Harness 的直接执行增加往返。
- “所有功能/修复/重构都先写失败测试”“先写代码就删除重来”等规则对配置、迁移、遗留系统和探索性维护过于刚性；例外仍要求人工批准。
- 方法论 hard gate 主要由提示和 bootstrap 保证，不等价于 Vibe-Harness 对外部写入、凭据、红区和工作区的运行时 effect enforcement。
- 默认 worktree 和任务级 Agent 工作流适合计划化开发，不适合所有审计、文档、运维和外部系统任务。
- 本轮主仓库 SDD workspace 测试在 Windows Git Bash 下有 4 个路径形式断言失败；最新 Evals 的全量 `bun run check` 也出现多处 POSIX/Windows 路径与权限假设失败。其 Linux 容器是 live eval 主运行环境，跨 Windows 采用前必须单独适配。

## 值得借鉴的机制及落地路线

### P0：先修证据基础设施

| 建议 | 现有能力重叠与最小落点 | 触发条件与成本 | 验收 | 撤回条件 |
| --- | --- | --- | --- | --- |
| R-01 合并验证快照与可执行探测 | 以 `scripts/lib/project-verification.js` 的内容哈希和 Windows shim 处理为真值，供 `runtime/commands/run.mjs` 复用；不改公开 CLI/schema | 所有项目 `verify`；中等实现成本，降低重复维护 | 已脏文件在检查中再次变化必须失败；Windows `node --version` 计划与执行通过；现有收据字段保持兼容 | 若共享模块显著扩大安装闭包，则提取更小的 portable snapshot/probe 模块，不恢复两套逻辑 |
| R-02 规范化 Eval 文本指纹（已实施 2026-09-14） | 修改 `scripts/lib/eval-assets.js` 的资产读取层，服从 Git 文本规范；保留分组与 aggregate 合同 | 所有 offline/online run；低到中成本 | LF/CRLF/mixed 夹具哈希一致，二进制字节变化仍触发漂移；Windows/Linux replay 同一提交一致 | 若规范化掩盖有意义的字节合同，只对 `.gitattributes` 标为 text 的资产启用，并将其余路径列入 raw-byte 组 |

### P1：增强现有 Eval，不新建方法论栈

| 建议 | 现有能力重叠与最小落点 | 触发条件与成本 | 验收 | 撤回条件 |
| --- | --- | --- | --- | --- |
| R-03 实现最小 `stub-behavioral`（deferred 2026-09-14：暂由 Harness Evals RED 阶段承担资产敏感度，实现决策待定） | 复用当前 eval runner、fixture、observer、allowedWritePaths 和 scoring；先覆盖 `clarify-requirements`、`systematic-debugging` 和 task split | 仅规则/Skill/Hook 行为变更；中等成本，无真实模型费用 | 同一压力场景能记录无资产基线失败、有资产通过；非法写入仍 fail-closed；proof 确实产出为 `stub-behavioral` | 若 stub 与真实 Agent 的方向性一致率不足，降为开发诊断并从正式成熟度证据中移除 |
| R-04 增加真实压缩恢复 case（已实施 2026-09-14） | 在现有 online execution suite 增加宿主可控压缩场景，使用 Execution Envelope v2 checkpoint 和 Git 事实 | 长计划、跨上下文恢复；中等运行成本（本机实测单轮约 2.5 分钟） | 已完成任务恰好一次，未完成任务继续；effect、write roots、目标与 HEAD 不扩大；旧摘要不能覆盖实时状态。本机实测：`records=1`、HEAD 不变、score 1 | 宿主无法在「低于续跑携带量、高于压实后常驻量」区间内压缩时保留为 capability-gated，不用人为摘要冒充真实压缩。实测补充：fixture 首轮上下文过小时压实后立即再次触顶，模型会在重读/遗忘之间空转（曾观测到 56 条压缩记录仍无写入），因此用例必须让首轮真实读完一份足够大的计划文件 |
| R-05 增加 review-feedback 压力 case | 将“验证反馈、修正确问题、拒绝错误建议、拒绝无需求抽象”作为 online case；规则可放入现有 coding/review 约束，不新增流程 Skill | 用户明确要求 address review 时；低规则成本、中等 Eval 成本 | 混合三条反馈场景中只落实正确项，并给出可核实的拒绝理由 | 若误拒率高，先只作为诊断，不设置 critical gate |

### P2：在已拆分任务中试点，不影响直接实施

| 建议 | 现有能力重叠与最小落点 | 触发条件与成本 | 验收 | 撤回条件 |
| --- | --- | --- | --- | --- |
| R-06 可选 task evidence packet | 扩展现有可选任务记录或生成到 gitignored 临时目录：任务 brief、base/head、verification ID、diff、review verdict、fix round；父 Agent 仍是唯一完成责任人 | 只在明确拆分/协作时；中等实现与上下文节省收益 | 压缩恢复后不重复已完成节点；review 能从一个包完成 task-to-diff 对账；包不成为授权根 | 若包维护成本大于重复任务损失，保留 ledger 的 task/status/head 最小子集 |
| R-07 一次独立审查给两个结论 | 在显式多 Agent、高风险二次复审或用户要求 Review 时，让同一 reviewer 分别输出 spec compliance 与 code quality；发现修复后只复审 fix diff | 已经需要独立复审时；低成本，减少双 reviewer 扇出 | 两个结论均有 file/line 证据；修复循环使用现有三次同 blocker 停止规则；父 Agent重跑最终集成验证 | 若单 reviewer 的两个结论显著互相污染，再针对高风险变更拆成两个独立 reviewer |
| R-08 采集成本与过度派发信号 | 在 online 评测报告层增加 token、subagent dispatch、总轮次等诊断，不立即设门禁 | 仅可比模型/宿主/任务；中到高成本，可能涉及 schema 兼容 | 相同配置和场景可比较；缺失成本显式 unknown；至少积累两个窗口再定阈值 | 指标不可比或诱导模型优化轨迹而损害结果时移除门禁，仅保留诊断 |

## 明确不采用

| Superpowers 机制 | 决定 | 理由 |
| --- | --- | --- |
| 所有创造性任务都必须先获设计批准 | 暂不采用 | 与 action-leaning/balanced 姿态及清晰小任务直接实施冲突；只保留高影响产品决定与完整档确认 |
| 全任务强制 TDD 和删除先写实现 | 暂不采用 | Vibe-Harness 已按改动类型选择测试；缺陷修复先复现测试即可，配置、文档、生成物和探索不应统一套用 |
| 每个计划默认 worktree | 暂不采用 | 当前项目已用 canonical workspace 与 envelope 约束高风险执行；worktree 应由宿主能力、并发写入和用户偏好触发 |
| 每个任务都派 implementer 与 reviewer | 暂不采用 | 对简单任务成本过高，也与默认单 Agent 相冲突；只在已拆分或显式复审时借鉴证据包与双结论 |
| 整体引入 Quorum | 暂不采用 | Vibe-Harness 已有 Eval schema、runner、hidden tests、report、health 与 CI；应补行为场景、三态证据和成本诊断，避免第二套运行器 |
| 所有宿主统一 SessionStart/compact 注入 | 暂不采用 | 宿主 Hook 能力不一致，Superpowers 自身在 Codex 6.3.0 也用 `hooks: {}` 禁止错误自动发现；应做 capability-gated 恢复测试 |

## 验证记录

### Vibe-Harness

| 命令 | 状态 | 结果 |
| --- | --- | --- |
| `pnpm check` | failed | lint 与 validate 通过；unit 215/217，通过之外的 2 项为 F-02 的 Windows Node locator 问题 |
| `pnpm skills:audit` | passed | 12 个 Skill，0 finding；9 native、3 integration |
| `pnpm eval:check` | passed | Eval schema、引用与合同检查通过 |
| `pnpm test:eval` | failed | 其余相关用例执行；2 项 offline replay 因 F-03 的资产指纹不一致失败 |
| `node --test ... tests/project-verification.test.js tests/transaction-recovery.test.js` | passed | 21/21，通过主验证收据、超时/取消、内容快照、事务 recovery/rollback |
| 一次性项目稳定性探针 | failed behavior | 同一已脏文件再次变化后独立命令仍报告 `stable: true`，确认 F-01 |
| 文本规范化指纹探针 | confirmed | config/rules/skills 的 LF 规范化与 HEAD 字节哈希均等于批准 reference |

`pnpm check` 的两个失败在报告写入前后均可复现；`pnpm test:eval` 的两个失败在报告写入前取得。报告完成后的文档审计不能替代这两项失败。未更新 Eval reference，也未弱化或删除断言。

### 复审更新（2026-09-14）

| 命令 | 状态 | 结果 |
| --- | --- | --- |
| `pnpm check` | passed | 298/298：语法/资产扫描、ESLint、typecheck、结构校验与 unit 全绿，含 F-01/F-02 的 Windows 回归用例 |
| `pnpm eval:check` | passed | Eval schema、引用与合同检查通过 |
| `pnpm eval:replay` | passed | 确定性重放通过（`criticalPassRate` 1、`overallScore` 1） |
| `pnpm test:eval` | passed | 206 pass / 0 fail / 1 既有跳过；F-03 消除后原先失败的 2 项指纹断言恢复 |
| `vibe-harness eval run --project . --mode offline --dry-run` | passed | 资产诊断为空、`reference.status` 为 matched，是 F-03 的关闭证据 |
| `node --test tests/tooling-modules.test.js` | passed | 全文件通过；i18n 提交（9a33ee1）后残留的两处英文文案断言改为断言 `action`/`phase` 与 summary 结构后转绿 |

F-03 关闭时已按 test-rules「reference 更新必须单独审查并显式确认」再生成 reference（`eval reference --from <run> --write --confirm-reference-update`，旧文件存 .vibe-harness/backups/），diff 仅含 `approvedAt` 与 hash 行，交维护者在提交前复核。F-01/F-02 的修复证据见上节处置台账，本报告不重复执行 2026-09-05 的对照实验。

### Superpowers 与 Superpowers Evals

| 命令 | 状态 | 结果 |
| --- | --- | --- |
| `node --test tests/pi/test-pi-extension.mjs` | passed | 6/6，覆盖启动注入与 `session_compact` 后恢复 |
| `tests/hooks/test-session-start.sh` | passed | Claude/Cursor/Copilot 的启动 Hook 输出 6 项通过 |
| `tests/claude-code/test-sdd-workspace.sh` | failed on Windows | 9 项通过、4 项路径形式断言失败；功能产物创建成功但 `/tmp` 与 Windows 路径表示不一致 |
| `bun run test test/composer.test.ts` | passed | 21/21，覆盖 pass/fail/indeterminate 和空轨迹防误判 |
| `bun run quorum check`（Evals） | failed on Windows | credentials 与 arms/suites 合同通过；86/86 场景的 Bash 语法检查因 Windows 路径未转换而失败 |
| `bun run check`（Evals） | aborted after failures | lint 通过；全量测试出现大量 POSIX 路径、权限和 appliance 环境假设失败，取得充分平台失败证据后中止，不能形成跨平台通过证据 |

本轮没有运行任何 live eval、真实 Agent CLI、模型 API 或外部写入，因此不对两套 Harness 的实际成功率、成本或模型遵从率作数值排名。

## 最终成熟度判断

Vibe-Harness 的整体工程成熟度是“已验证”。2026-09-05 判定完成证据基础设施因 F-01 至 F-03 应暂按“实现化”处理，这三项已于 2026-09-14 修复并有复审记录，F-04 转为文档降级记账，因此完成证据基础设施恢复为“已验证”；行为层证据中 F-05/R-04 也已于 2026-09-14 落地为真实宿主压缩用例并取得本机实测证据，仅 R-03 stub-behavioral 仍属“实现化”。它在安全、授权、安装事务、验证收据和跨宿主降级方面比 Superpowers 更成熟；在真实长任务行为、Skill 压力测试和多 Agent 执行闭环方面落后一个层级。

Superpowers 6.3.0 的方法论与主流开发循环达到“已验证”，其独立 Evals 体系在 Linux 主运行环境中呈现“持续改进”特征。它不能替代 Vibe-Harness 的治理内核：提示 hard gate、流程批准和 TDD 纪律不是 effect enforcement、事务回滚或跨宿主安全合同。本轮 Windows 检查也说明，其脚本与实验室能力需要按 Vibe-Harness 的跨平台标准重新实现，不能直接复制。

建议的顺序是：先修 R-01/R-02，使证据可靠；再实现 R-03/R-04，让现有 Eval 真正测到规则行为与恢复行为；最后只在已经拆分或协作的任务中试点 R-06/R-07。R-01、R-02、R-04 已于 2026-09-14 完成（见处置台账），R-03 转为 deferred、其资产敏感度暂由 Harness Evals RED 阶段承担，因此下一步是 R-05（review-feedback 压力 case）。这样可以吸收 Superpowers 最成熟的学习闭环，同时保留 Vibe-Harness 已证明有效的低仪式执行路径。
