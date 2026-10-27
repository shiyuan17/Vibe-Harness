# Vibe-Harness 贡献指南

本文件说明仓库贡献流程。README 面向使用者，`docs/architecture.md` 说明当前实现，`docs/archive/` 只保存历史。

## 默认流程

1. 阅读 `AGENTS.md`，运行 `git status --short`，保护现有改动。
2. 从代码、manifest、schema 和当前文档获取可信事实，使证据强度与行动风险匹配。
3. 路由剩余歧义，并在授权范围内判定和完成最小实现。
4. 只运行与变更和交付主张匹配的验证。
5. 简洁报告结果、实际变更和本轮验证；仅在存在时补充风险或后续动作。

风险档位只影响审批和验证强度，不创建任务合同、审查角色或完成门禁。Review、浏览器检查和 Eval 仅在用户明确要求或变更本身需要对应产品能力时显式运行。

## 文档职责

| 位置 | 职责 |
| --- | --- |
| `AGENTS.md` | Agent 常驻安全边界和命令速查 |
| README 中英文 | 当前用户能力与命令 |
| `docs/architecture.md` | 当前组件、数据流、profile 和安全模型 |
| `docs/specs/` | 当前产品规格 |
| `docs/inventory/` | 来源与收敛依据 |
| `docs/archive/` | 被取代或已结束的历史 |
| `docs/catalog.json` | 文档路径、角色和状态 |

新增、移动或退役文档时同步 catalog 与 `docs/README.md` / `docs/archive/README.md`。

修改 docs/rules/*.md 后校验单一规则目录及其文档关系；pnpm check 已包含文档审计，未运行 check 时再显式运行 pnpm docs:audit。

## 命令边界

- 项目路径只通过 `--project <path>` 传入，`--target` 只选择 adapter；多宿主目标在配置 `targets` 数组声明，`--targets` 仅 `init` 使用。
- dry-run 不写入；真实修改必须使用 `--write`。`--apply`、`codex-internal` 和 `codex-minimal` 已移除。
- Codex full 写红区需要 `--confirm-red-zone`。
- `pnpm task-dag check --file <dag.json>`（可选 `--require-ready`、`--json`）是派发前校验入口，由 task-decomposition Skill 和在线 canary 按需调用；runtime 不自动调用它。
- `validate --project` 只检查安装一致性；`verify --project` 不带 `--tier` 时默认只执行快速层（层命令来自配置声明或按包脚本推导，完全推导不出层时退回 `auto` 风险计划），收据标注部分范围；`--tier standard|deep` 按层累计显式升级，`--plan` 只预览计划，`--full` 显式执行完整验证矩阵并与 `--tier` 互斥。`minimal/core/full/docs-only` 仍表示安装能力范围，不表示验证风险等级。
- 项目内安装副本入口为 `node .agents/runtime/commands/run.mjs verify`；两个引擎的收据以 `engine` 字段区分（`vibe-harness-cli` / `vibe-harness-runtime`），命令同源于项目配置。

verify 输出本轮 ID、时间和可用的 Git 工作树指纹；检查期间工作树变化时收据失效且命令返回非零。

## 规则中的仓库私有事实

`docs/rules/*.md` 会随 pack 安装到目标项目，因此规则正文只写可移植的中立措辞，本仓库的具体路径、脚本与门禁名集中登记在这里（`project-specific-rules.md` 是渲染产物，例外）：

| 规则中的中立措辞 | 本仓库事实 |
| --- | --- |
| 项目在发布边界配置的 required check | `.github/workflows/ci.yml` 的聚合 job `merge-gate`，它是 main ruleset 的唯一 required check，详见 `docs/github-delivery.md` |
| 项目自己的发布交付文档 | `docs/github-delivery.md` |
| 项目记录该门禁决策的决策记录 | `docs/adr/ADR-0006-release-gated-ci-writer-landed-merges.md` |
| 项目提供的聚焦验证入口 | `pnpm verify:focused`；常规门禁仍是 `pnpm check` |
| 项目提供的 DAG 校验入口 | `pnpm task-dag check --file <dag.json> --node <id> [--require-ready]` |
| 项目提供的隔离核对入口 | `pnpm worktree list\|check\|plan` |
| 宿主 Skill 根目录下已安装的 Skill 入口 | `.agents/skills/<id>/SKILL.md` |
| 以其 ADR 索引作为触发清单与流程来源 | `docs/adr/README.md`，字段见 `templates/adr/adr-template.md` 与 `schemas/adr.schema.json` |
| 项目提供的状态锚点入口与锚点存放目录 | `.vibe-harness/tasks/`（task 命令 `node .agents/runtime/commands/run.mjs task <init|update|status|list>` 读写） |
| 规则中的「宿主 worktree 能力」 | Codex 的 worktree 创建与会话切换入口（把会话根切到该 worktree）；项目需要镜像、端口分段或依赖链接时由 `run.mjs worktree bootstrap` 承担同一入口 |
| 项目自己的贡献指南和测试配置 | 本文件的「测试实现（本仓库）」一节 |

`pnpm validate` 的规则可移植性门禁与规则交叉引用门禁会阻止这些私有事实回流到规则正文，也会阻挡指向不存在规则文件的同目录引用。

## 验证选择

验证命令与成本层的单一真值源是 `vibe-harness.config.json` 的 `validationCommands`（含 `tiers`）；`AGENTS.md` 的「验证选择」一节只保留默认门槛、`pnpm verify:focused` 用法和计划外的治理性追加表。本节只说明与贡献流程相关的边界。

普通变更运行：

```bash
pnpm check:fast
git diff --check
```

证据层级 L0-L6、成本档 quick/standard/deep 与运行范围 affected/layer/full 是三个独立维度；测试目录按 unit/component/integration/e2e/matrix 分类，不构成另一套证据层级或改变 `vibe-harness.config.json` 的命令归属。

普通变更的默认门禁是 `pnpm check:fast`（语法/资产扫描、typecheck、单元测试，与 `vibe-harness verify` 快速层同一定义）；`pnpm check` 是 `pnpm check:full` 的别名，在 `check:fast` 之上追加 ESLint、安装结构校验、测试台账校验与组件测试（L2），升级到阶段收尾、合并前或高风险边界运行。CI 的 fast 门禁执行 `pnpm lint:eslint` 与 `pnpm check:fast`，full 门禁执行完整 `pnpm check`，本地不再与远端门禁存在覆盖差异。集成（L4）、端到端关键路径（L5）与全量矩阵（L6）按需显式运行，具体层级与成本档见 `docs/rules/test-rules.md`。

installer 集成验证应覆盖已有文件拒写、红区确认、目标路径逃逸和事务回滚边界。

不要为了满足固定流程运行无关 Review/Test。没有本轮输出时，不得复用历史结果声称通过。角色包、角色路由或宿主投影变更还必须运行 pnpm roles:audit，并按影响范围补充宿主生命周期测试。

风险计划的 `unknown` 分支必须 fail-safe 回退到 high；普通文档、单个测试文件和纯函数脚本不得仅因目录名自动触发 integration/smoke。验证收据保留 `riskLevel`、`planMode`、`impactGroups`、`selectedChecks`、`skippedChecks`、`executionTier`、`tierSource`、`scopeStatus`、`deferredChecks`、`nextTier`、`tierFallback`、`fallbackUsed` 和 `selectionReasons`。

### Hook 配置变更交付示例

例如移除项目级 Codex 临时调试 probe：先确认覆盖该红区修改的明确授权，只删除独立调试处理器，保留受管 `PreToolUse`、`PermissionRequest` 的命令、匹配规则、超时与失败拒绝逻辑。比较解析后的配置而非 JSON 排版；历史日志、全局配置和用户其他改动不在该修复范围。

先运行 Codex adapter、Hook bootstrap、Hook runtime 与 enforcement gate 的聚焦用例，再运行 `node .agents/runtime/commands/run.mjs verify --project . --tier standard --json`。新增用例同步台账，并执行 `pnpm tests:catalog check`、`pnpm docs:audit` 和 `git diff --check`。最后一次实质修改使旧证据失效；复用只能经过现有收据指纹校验，不手工修改生成收据的审定或接受状态。

按 [交付模板](templates/delivery.md) 的现有 completion 字段记录以下内容，不新增 schema；表内是填写要求，不是已通过的执行记录：

| 现有字段 | 本例应填写的证据与边界 |
| --- | --- |
| `delivery.profile/stage`、`status` | 沿用实际交付模式；验证草稿保持 `stage=verify`，不因测试通过自动改成完整完成。 |
| `acceptance` | 分别记录配置移除、隐私与拒绝回归、宿主生效；每项绑定实际命令或人工判据、范围及 `passed/failed/blocked/unverified`。 |
| `verification` | 引用本轮 `id`、`finishedAt`、检查集合、选择理由、相关性审定、前后修订与指纹、`snapshotComparison`；失败时保留诊断和最终状态的同检查复验。 |
| `source/target` | 使用实际来源和目标指纹；无远端证据时不声称已合并或发布。 |
| `unverified`、`remainingRisks` | 列出深度层延期、未审定检查及未观察的宿主激活；`unreviewed/blocked/stale/queued/running` 均不能转述为通过。 |
| `rollback` | 只恢复受管安全处理器，不恢复原始输入 probe，不降低沙箱或处理旧日志。 |

宿主生效独立于 CLI 用例：按宿主支持的方式重新加载配置后，用无副作用调用核对实际应用；合成拒绝输入仅验证处理器，不执行被测危险指令。无法观察宿主激活时交付为“配置修复及本地验证完成，宿主激活未验证”。短任务不因此强制创建任务锚点；已有锚点沿用 `task check <id> --complete --receipt <file>`，缺证据不得绕过完成门。

本次优化的后续观察与修复交付分开：交付后 14 天内，在前 3 个自然发生的代码变更任务中沿用现有交付记录，记录最终变更与相关验证是否绑定、失败是否经诊断并复验、本地验证与实际接受是否区分。不制造任务、不新增自动监控或台账；目标是样本中没有无证据完成主张。至少两个独立可比任务才评估实际使用；缺少修复前可比基线时不宣称效率提升，窗口结束仍缺样本则记录“证据不足”。

## 测试实现（本仓库）

### 减少返修试点

新验收覆盖诊断先全部告警观察，不改变既有退出码、完成收据或阻断条件。`task plan-check` 的 `acceptanceCoverage` 只检查受管计划的声明映射；`task check --complete` 补充单元与证据缺口，`--unit` 只代表该单元。缺失计划、旧执行块、人工判据与证据不可用均明确说明；映射或收据有效不证明需求语义已完整覆盖，不据此声称行为通过。

工程验证后，以自然发生的最多 30 个任务或 4 周（先到者为准）进行人工观察；每个交付任务保留 7 天反馈窗口，未结束窗口单列。沿用现有任务/交付记录，按任务类型、风险、模型条件记录首次验收、交付后返修、耗时、同类复发与总成本。新增需求不算原任务质量返修；无反馈记未确认，未知耗时不填零。没有可比基线或样本不足只报告证据不足，不启动后台监控、不自动读取历史聊天或 Memory、不自动启用阻断门禁。

H24-H29 为显式选择的在线试点，不进入默认或影响面派生的夜间门禁。前后固定 fixture、runner、模型、预算及评分；修改前已有未提交改动无法映射到不可变 RED 基线时，保留指纹并将比较记为 blocked，不换用不同历史状态。工程落地、在线行为验证、真实返修改善三层结论分别交付；reference 更新继续单独批准。

`docs/rules/test-rules.md` 是运行器无关的行为契约；以下事实只描述 Vibe-Harness 自身仓库，随规则安装到目标项目时不构成对运行器、依赖或超时的要求：

- 使用 Node.js 内置测试运行器和 node:assert/strict，不引入第三方测试依赖。
- 测试按 `docs/rules/test-rules.md` 的五层划分目录与脚本：`tests/unit/`（`test:unit`）、`tests/component/`（`test:component`）、`tests/integration/`（`test:integration`）、`tests/e2e/`（`test:e2e`）、`tests/matrix/`（`test:matrix`）；`tests/helpers/` 与 `tests/fixtures/` 不属任何层。`test` 入口按 unit → component → integration → e2e → matrix 顺序聚合。
- `pnpm check` 覆盖 L0 静态检查与 L2 受影响单元/组件行为；L1 Micro 仅在项目声明且适用时显式执行。L3 模块/切片/契约与 L4 受影响集成按任务范围在 worktree、任务边界或提交前选择；L5（真实浏览器与真实服务的关键端到端主流程）仅在 CI full 门禁（main 推送、夜间调度或高风险计划）、发布边界或深度层显式升级时执行，标准 PR 不要求 e2e；L6 全量回归/矩阵/Eval 在发布边界运行。低层通过不得替代高层结论；跳层必须在完成主张里写明理由。
- 当前失败兜底为 unit/component 30 秒、integration/e2e 120 秒、matrix 600 秒；集成与端到端因共享临时状态使用并发度 2 或更低。
- 顶层 test 描述行为，不使用 describe 套件；基准路径用 import.meta.dirname。
- 一个用例只暴露一个失败原因；命名描述行为而非实现；表驱动用例必须参数化命名（把参数写进用例名），使失败摘要能直接定位用例。
- 断言失败要能定位到输入与期望值，不用只断言「返回了对象」的空断言。
- 临时目录用 mkdtemp，并在 try/finally 中清理。
- 条件跳过使用选项对象或运行时 skip，不残留 only 或无理由 skip。
- 已知负载敏感的集成测试可用有界重试标记（例如 `{ retry: 2 }`），注释必须写明技术债 ID 与关闭条件，记录见 docs/memory/TECH_DEBT.md。
- 同一层内不得重复覆盖同一行为；退役或隔离用例必须回写 `tests/cases.json`（`pnpm tests:catalog sync --write`），`status: quarantined` 必须绑定 `techDebtId`。
- 新增或重写用例的 `name` 用项目 `language`（本仓库 `zh-CN`）描述，且能定位被验证的行为；迁移批次存量用例由 `legacy: true` 标记，允许保留英文描述。
- 用例台账（`tests/cases.json`）的条目 ID 为 `<层前缀>-<文件 stem>-<三位声明序号>`，改名保留 ID；一致性由运行时枚举（`scripts/lib/test-case-reporter.mjs`）与 `pnpm tests:catalog check` 共同守护。
- 表驱动用例在台账中保留一条参数化条目（名称带 `${...}` 占位符即视为模板），运行时展开的每个实例由该模板匹配，既不为每行重复登记，也不因行数变化报漂移；模板匹配不到任何实例时仍按 `ledger-stale-entry` 报错。

## Eval reference 更新清单

rules、runtime hooks 或 config 内容变更会使 `evals/references/` 的 asset fingerprint（config、hooks、rules、skills 分组哈希）按设计漂移，`pnpm eval:check`（复核 reference 与当前资产）与 `pnpm eval:replay`（复核签入 run 与当前资产）相应失败。reference 更新必须单独审查并显式确认，不得为让变更通过而自动提升：

1. 确认指纹漂移分组与本轮预期变更一致（本轮只改 rules 时，漂移就应只有 rules 组）。
2. 出现非预期分组漂移时先回到代码查因，不盲目再生成。
3. 使用正规入口再生成：先 `pnpm vibe-harness eval run --project . --mode offline --write` 得到 run 文件（`.vibe-harness/evals/runs/<timestamp>.json`），再 `pnpm vibe-harness eval reference --project . --from <run 文件> --write --confirm-reference-update --force`；既有 reference 存在时缺少 `--force` 会以 `EVAL_REFERENCE_CONFLICT` 拒绝，`--force` 负责先备份旧文件再替换。命令细节见 `docs/evals.md`。`.agents/evals/` 镜像由 `pnpm eval:sync --write` 重生成（`pnpm eval:sync` 是只读检查，CI 的 `pnpm pack:contract` 已强制该镜像与 source 一致）；`evals/results/` 是运行产物，不参与镜像。
   同一份资产指纹还嵌入签入的 replay 产物 `evals/results/vibe-harness-core.offline.json`，由 `pnpm eval:replay --write` 确定性重生成（旧文件备份到 `.vibe-harness/backups/`，该产物不参与 `.agents/evals/` 镜像）。`pnpm eval:check` 既交叉校验签入 run 与 reference 的指纹，也把 reference 指纹与当前资产树复核，两者不能只更新一侧：先再生成 reference，再用 `pnpm eval:replay --write` 重生成 run；`--write` 在 reference 仍不一致时以非零退出并给出下一步。
4. 重跑 `pnpm eval:check` 与 `pnpm eval:replay` 确认通过，并在 PR 说明中记录漂移分组与确认依据。

## 治理资产生成命令

以下命令把重复的文档、ADR、镜像维护与执行信封、回执登记动作固化成脚本。默认只读，真实写入统一加 `--write`，且只追加缺失记录、不重写已有条目；需要 owner 判断的情况以 manual action 报出，不会自动猜测：

- `pnpm docs:sync [--write]`：把 `docs/` 中受治理的文档与 schema 渲染副本补进 `docs/catalog.json`、`docs/adr/catalog.json`、`docs/memory/DECISIONS.md`、`docs/README.md` 与 `docs/archive/README.md`。悬空、未纳管、未分类的路径只报告。
- `pnpm adr:new --title <标题> --owner <owner> [--write]`：按 `templates/adr/adr-template.md` 生成下一个 `docs/adr/ADR-0000-*.md`，并调用同一投影补齐 catalog、DECISIONS 与索引。非 ASCII 标题需要同时给出 `--slug`。
- `pnpm eval:sync [--write]`：按 `adapters/install-map.json` 重生成 `.agents/evals/` 镜像；孤儿镜像项与缺失 source 只报告、不删除。
- `pnpm release:readiness [--sha <sha>] [--require-clean] [--tarball <path>]`：核对版本一致性、changelog 条目与可选的发布边界事实，输出可随发布附带的就绪收据。
- `pnpm envelope plan [--mode <mode>] [--issue <ID>] [--effect <effect>] --objective <text> --terminal <text> [--base-ref <ref>] [--host-context <file>] [--session-id <id>] [--emit receipt|envelope] [--out <path>] [--write]`：从当前工作区身份生成 Execution Envelope v2 草稿与随机 requestId，默认五分钟到期；sessionId 和 hostContext 只由宿主提供。`pnpm envelope check --file <path> [--cwd <path>]` 核对 schema、效果、时效与工作区；结构合格的 `source: "host"` 不等于可信签发，高风险检查返回 `HOST_PROOF_UNVERIFIED`。
- `node .agents/runtime/commands/run.mjs review ocr --task <ISSUE-ID> --target <https-model-endpoint>` 只作受限预检，配置不就绪或协议不支持返回脱敏错误；即使预检成功也返回 `HOST_BROKER_REQUIRED`，不会启动 OCR 或生成独立评审回执。当前可使用真正独立的宿主原生 Reviewer 按既有审计契约提交回执。OCR 外发使用 v2 `dataEgress` 效果且须限定模型目标；管理员的旧 v2 兼容窗口不能授权新外发效果，具体配置与风险见 governance-core。
- `pnpm receipt start|event|handoff|check`：固化 Linear 执行回执与交接协议。`start` 默认生成显式执行 v1 回执和新的 `executionId`、`runtimeInstanceId`（不复制宿主 thread、session、用户名、主机名或本地路径）；历史宿主管理的 Claim-bearing 运行使用 v3 并包含宿主提供的 `grantId`；v2/v3 仅供历史读取，活动队列自动派发已退役，显式执行不要求 Claim 或 Start/Terminal Receipt。`grantId` 只引用宿主保存的授权，不证明授权有效；Claim/Grant 字段由宿主产生，不要求用户补填。`event` 生成终结事件（`handed-off` 必须携带预生成的 successor ID），`handoff` 生成 `vibe-harness.handoff/v1` 载荷（声明 complete 必须同时满足 accepted 与 reviewed/passed 的 finalCheck），`check --file <comments.json> [--issue <ID>]` 同时分析 v1/v2/v3 回执历史：同 ID 不同内容、同一 Issue 多个 active execution、孤儿或重复终结事件、交接 successor 的 source 或目标 Issue 不符都报冲突并退出非零，交接未确认等合法中间态以 pending 报出。三个生成命令默认只打印记录，`--write` 时才写入 `--out`，且都不会写入 Linear 或派发任务。
- `pnpm task-dag check --file <dag.json> --node <id> [--require-ready] [--json]`：按 `docs/rules/ai-collab-rules.md` 的节点字段校验派发前的轻量 Task DAG——节点契约、依赖边与环、writeScope 重叠、resourceLocks、ready 集与结构哈希；`hash` 输出确定性结构哈希供 checkpoint 记录。错误 fail-closed（未知前驱、环、自依赖、非法 writeScope、read 节点带写范围、write 节点无写范围、共享路径或锁且无依赖路径的两个 write 节点都不 ready），`--require-ready` 在无可派发节点时退出非零。命令只读，不写任何文件。`docs/templates/task.md` 的表格仍是人读记录，不被解析。
- `pnpm worktree list|check|plan`：用 `git worktree list --porcelain -z` 做 worktree 隔离审计。`check` 按登记任务（`--task <ISSUE-ID>[:<branch>[:<path>]]`，路径可省略，默认取仓库同级 `<repo>-worktrees/<ISSUE-ID>`）核对分支命名 `<type>/<ISSUE-ID>-<slug>`、worktree 位于仓库外部且不互相嵌套、非主工作区绑定命名分支、同一分支不被两个 worktree 占用，并报告 merge-back 事实（分支是否已并入 `--base-ref`、merge-base 是否偏离 `--base-sha`）与 `--deep` 的未提交改动。主检出存在 `.vibe-harness/worktree-ports.json` 时，`check` 一并报告每个 worktree 的端口块与它的 env 文件是否仍与登记表一致（env 漂移、env 未忽略与主检出缺依赖都是 warning）。错误 fail-closed，警告（未创建的登记 worktree、未纳管 worktree、未 merge-back、脏工作区）可用 `--strict` 升级为失败；`plan` 只打印 `git worktree add` 命令。三个子命令都只读，命令绝不执行 `git worktree remove`、`git worktree prune` 或删除分支，未合并的 worktree 只阻止宣称“已集成”。实际创建、依赖链接、端口分配、崩溃恢复与清理走项目面入口 `node .agents/runtime/commands/run.mjs worktree <bootstrap|recover|cleanup> --project . --json`（默认 dry-run，`--write` 落盘，`recover` 只清理带归因证据的崩溃残留，见 git-rules 的 Worktree 节）；两个入口的子命令集不同，分工见 `docs/rules/git-rules.md` Worktree 节。
- `vibe-harness audit --project <path> --kind cleanup`：只读扫描死代码、过期引用、过期文档、过期资源、过期记忆与过期索引，输出 `audit-report` 收据，`details.cleanup` 记录扫描面、已确认项与候选线索计数以及本次未覆盖的判定。扫描器把高置信结构与启发式候选分开标记，绝不删除或改写文件，`--write` 对 `cleanup` 一律拒绝；`--kind all` 仍只聚合 memory、review 与 improvements，清理需显式指定。

## Pull Request

涉及结构、公共契约、安全与可靠性、关键依赖、迁移回滚或跨模块边界的 PR 必须在 docs/adr/ 中提供正式 ADR，或说明无需 ADR 的原因。同步更新 docs/adr/catalog.json 和 docs/memory/DECISIONS.md；接受或拒绝后的决策通过新 ADR 替代，不改写历史核心内容。

文档、ADR、catalog 和 schema 变更按 AGENTS.md「验证选择」一节执行；pnpm check 已包含文档与 ADR 校验时不重复运行，仅在未覆盖相关变更时补充聚焦检查。

PR 说明目标、影响范围、实际验证、未验证项和必要的回滚路径。一个 commit 表达一个逻辑目的；不要用格式化或无关重构掩盖行为变化。

质量门禁由必要的本地候选自动验证和 CI 自动检查承担。`merge-gate` 聚合 product、supply-chain、security、branch-policy 与 change-plan；不消费本地独立审查收据，不增加人工批准 job。显式审查工具保留兼容接口，只有用户要求时才运行。风险说明直接引用 Planner 的风险、必要检查、非必需项与回滚信息。develop 直推不触发 CI，必须先完成最终候选的必要本地验证。

普通功能与修复从最新 <code>develop</code> 创建短期 <code>feat/*</code> 或 <code>fix/*</code> 分支，并以 squash merge 合入 <code>develop</code>；按 ADR-0013，<code>develop</code> 不配置服务器端 required gate，任务也可先以 <code>worktree stage</code> 生成本地已验证候选，再由 <code>worktree publish --batch &lt;id&gt;</code> 从最新 <code>origin/develop</code> 重建、验证、no-ff 发布并回读远端 SHA。紧急线上修复从 <code>main</code> 创建 <code>hotfix/*</code>，合入 <code>main</code> 后立即把 <code>main</code> 回同步到 <code>develop</code>。正式发布以 merge commit 将 <code>develop</code> 提升到 <code>main</code>；不得创建长期 <code>release/*</code> 分支。发布成功后必须将 <code>main</code> 回同步到 <code>develop</code>，版本文件未回同步时不得开始下一次发布提升。

## 发布

发布前核对版本、用户可观察变化、兼容影响、回滚方式和监控信号。按发布影响运行 pack、integration、lifecycle 或在线 Eval；本地命令通过不等于发布成功。

### 自动化发布流程

仓库使用 [release-please](https://github.com/googleapis/release-please) 自动化版本同步，防止 `package.json` 版本、`CHANGELOG.md` 和 git tag 漂移：

1. Conventional Commits 合并到 `main` 后，release-please 自动累积变更并开一个 Release PR。
2. Release PR 包含版本号 bump、`CHANGELOG.md` 更新和 `.release-please-manifest.json` 更新。
3. 合并 Release PR 后，release-please 自动创建 `vX.Y.Z` tag 和 GitHub Release。
4. 不得手动编辑 `package.json` 的 `version` 字段或手动创建 `v*` tag；版本变更只能通过 Release PR 完成。

Breaking change（`feat!:` 或 `BREAKING CHANGE:` footer）会触发 major 版本 bump。
# 验证契约

贡献者按 L0-L6 验证阶梯选择最小充分证据：实现过程中使用受控 Micro/L1，局部行为使用 affected unit/component，任务边界执行 standard，关键 PR/nightly/release 执行 deep。不得用 L0 或 Micro 通过替代高层失败，也不得把 queued/running/stale receipt 当作通过。变更影响为 unknown 或 lower-bound 时必须扩大验证，并在 receipt 中记录原因、延期项和未验证风险。

项目配置中的 Micro check 必须是结构化声明；legacy command 仅作迁移兼容，不得复用缓存或进入 async。CLI、runtime、CI 必须消费同一 Planner receipt。
