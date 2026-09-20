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

- 项目路径只通过 `--project <path>` 传入，`--target` 只选择 adapter。
- dry-run 不写入；真实修改必须使用 `--write`。
- Codex full 写红区需要 `--confirm-red-zone`。
- `validate --project` 只检查安装一致性；`verify --project` 不带 `--tier` 时默认只执行快速层（层命令来自配置声明或按包脚本推导，完全推导不出层时退回 `auto` 风险计划），收据标注部分范围；`--tier standard|deep` 按层累计显式升级，`--plan` 只预览计划，`--full` 显式执行完整验证矩阵并与 `--tier` 互斥。`minimal/core/full/docs-only` 仍表示安装能力范围，不表示验证风险等级。

verify 输出本轮 ID、时间和可用的 Git 工作树指纹；检查期间工作树变化时收据失效且命令返回非零。

## 规则中的仓库私有事实

`docs/rules/*.md` 会随 pack 安装到目标项目，因此规则正文只写可移植的中立措辞，本仓库的具体路径、脚本与门禁名集中登记在这里（`project-specific-rules.md` 是渲染产物，例外）：

| 规则中的中立措辞 | 本仓库事实 |
| --- | --- |
| 项目在发布边界配置的 required check | `.github/workflows/ci.yml` 的聚合 job `merge-gate`，它是 main ruleset 的唯一 required check，详见 `docs/github-delivery.md` |
| 项目自己的发布交付文档 | `docs/github-delivery.md` |
| 项目记录该门禁决策的决策记录 | `docs/adr/ADR-0006-release-gated-ci-writer-landed-merges.md` |
| 项目提供的聚焦验证入口 | `pnpm verify:focused`；常规门禁仍是 `pnpm check` |
| 项目提供的 DAG 校验入口 | `pnpm task-dag check --file <dag.json> [--require-ready]` |
| 项目提供的隔离核对入口 | `pnpm worktree list\|check\|plan` |
| 宿主 Skill 根目录下已安装的 Skill 入口 | `.agents/skills/<id>/SKILL.md` |
| 以其 ADR 索引作为触发清单与流程来源 | `docs/adr/README.md`，字段见 `templates/adr/adr-template.md` 与 `schemas/adr.schema.json` |
| 项目提供的状态锚点入口与锚点存放目录 | `.vibe-harness/tasks/`（task 命令 `node .agents/runtime/commands/run.mjs task <init|update|status|list>` 读写） |
| 项目自己的贡献指南和测试配置 | 本文件的「测试实现（本仓库）」一节 |

`pnpm validate` 的规则可移植性门禁与规则交叉引用门禁会阻止这些私有事实回流到规则正文，也会阻挡指向不存在规则文件的同目录引用。

## 验证选择

验证命令与成本层的单一真值源是 `vibe-harness.config.json` 的 `validationCommands`（含 `tiers`）；`AGENTS.md` 的「验证选择」一节只保留默认门槛、`pnpm verify:focused` 用法和计划外的治理性追加表。本节只说明与贡献流程相关的边界。

普通变更运行：

```bash
pnpm check
git diff --check
```

快速迭代可用 `pnpm check:fast`（语法/资产扫描、typecheck、单元测试，与 `vibe-harness verify` 快速层同一定义）；`pnpm check` 是 `pnpm check:full` 的别名，已内含语法/资产扫描、ESLint、typecheck、安装结构校验、测试台账校验、单元测试（L1）与组件测试（L2）。CI 的 fast 门禁执行 `pnpm lint:eslint` 与 `pnpm check:fast`，full 门禁执行完整 `pnpm check`，本地不再与远端门禁存在覆盖差异。集成（L3）、端到端关键路径（L4）与全量矩阵（L5）按需显式运行，定义见 `docs/rules/test-rules.md` 的「测试分层」。

installer 集成验证应覆盖已有文件拒写、红区确认、目标路径逃逸和事务回滚边界。

不要为了满足固定流程运行无关 Review/Test。没有本轮输出时，不得复用历史结果声称通过。角色包、角色路由或宿主投影变更还必须运行 pnpm roles:audit，并按影响范围补充宿主生命周期测试。

风险计划的 `unknown` 分支必须 fail-safe 回退到 high；普通文档、单个测试文件和纯函数脚本不得仅因目录名自动触发 integration/smoke。验证收据保留 `riskLevel`、`planMode`、`impactGroups`、`selectedChecks`、`skippedChecks`、`executionTier`、`tierSource`、`scopeStatus`、`deferredChecks`、`nextTier`、`tierFallback`、`fallbackUsed` 和 `selectionReasons`。

## 测试实现（本仓库）

`docs/rules/test-rules.md` 是运行器无关的行为契约；以下事实只描述 Vibe-Harness 自身仓库，随规则安装到目标项目时不构成对运行器、依赖或超时的要求：

- 使用 Node.js 内置测试运行器和 node:assert/strict，不引入第三方测试依赖。
- 测试按 `docs/rules/test-rules.md` 的五层划分目录与脚本：`tests/unit/`（`test:unit`）、`tests/component/`（`test:component`）、`tests/integration/`（`test:integration`）、`tests/e2e/`（`test:e2e`）、`tests/matrix/`（`test:matrix`）；`tests/helpers/` 与 `tests/fixtures/` 不属任何层。`test` 入口按 unit → component → integration → e2e → matrix 顺序聚合。
- `pnpm check` 只跑 L1 与 L2；L3 在 worktree 与提交前运行受影响子集，L4 是 PR 门禁（真实浏览器与真实服务，1–3 条主流程），L5 在发布边界运行。低层通过不得替代高层结论；跳层必须在完成主张里写明理由。
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
- `pnpm envelope plan [--mode <mode>] [--issue <ID>] [--effect <effect>] --objective <text> --terminal <text> [--base-ref <ref>] [--host-context <file>] [--request-id <id>] [--session-id <id>] [--emit receipt|envelope] [--out <path>] [--write]`：从当前工作区身份生成 Execution Envelope v2 草稿（canonical cwd、worktree root、Git dir、branch、冻结 base SHA、allowed write roots 与 mode effect 上限），并只把 `requestId`、`sessionId`、`hostContext` 留作宿主注入——命令不自造宿主证明，草稿在宿主补齐前保持 invalid。`pnpm envelope check --file <path> [--cwd <path>]` 用发布 schema、runtime 解析器与当前工作区复核信封：越界 effect、allowed/forbidden 冲突、过期、陈旧宿主证明、工作区或 HEAD/base ref 漂移、checkpoint 失配与无法核对工作区都按 fail-closed 报错。
- `pnpm receipt start|event|handoff|check`：固化 Linear 执行回执与交接协议。`start` 生成新的 `executionId` 与 `runtimeInstanceId`（不复制宿主 thread、session、用户名、主机名或本地路径），`event` 生成终结事件（`handed-off` 必须携带预生成的 successor ID），`handoff` 生成 `vibe-harness.handoff/v1` 载荷（声明 complete 必须同时满足 accepted 与 reviewed/passed 的 finalCheck），`check --file <comments.json> [--issue <ID>]` 分析一个 Issue 的结构化评论历史：同 ID 不同内容、同一 Issue 多个 active execution、孤儿或重复终结事件、交接 successor 的 source 或目标 Issue 不符都报冲突并退出非零，交接未确认等合法中间态以 pending 报出。三个生成命令默认只打印记录，`--write` 时才写入 `--out`，且都不会写入 Linear。
- `pnpm task-dag check --file <dag.json> [--require-ready] [--json]`：按 `docs/rules/ai-collab-rules.md` 的节点字段校验派发前的轻量 Task DAG——节点契约、依赖边与环、writeScope 重叠、resourceLocks、ready 集与结构哈希；`hash` 输出确定性结构哈希供 checkpoint 记录。错误 fail-closed（未知前驱、环、自依赖、非法 writeScope、read 节点带写范围、write 节点无写范围、共享路径或锁且无依赖路径的两个 write 节点都不 ready），`--require-ready` 在无可派发节点时退出非零。命令只读，不写任何文件。`docs/templates/task.md` 的表格仍是人读记录，不被解析。
- `pnpm worktree list|check|plan`：用 `git worktree list --porcelain -z` 做 worktree 隔离审计。`check` 按登记任务（`--task <ISSUE-ID>[:<branch>[:<path>]]`，路径可省略，默认取仓库同级 `<repo>-worktrees/<ISSUE-ID>`）核对分支命名 `<type>/<ISSUE-ID>-<slug>`、worktree 位于仓库外部且不互相嵌套、非主工作区绑定命名分支、同一分支不被两个 worktree 占用，并报告 merge-back 事实（分支是否已并入 `--base-ref`、merge-base 是否偏离 `--base-sha`）与 `--deep` 的未提交改动。主检出存在 `.vibe-harness/worktree-ports.json` 时，`check` 一并报告每个 worktree 的端口块与它的 env 文件是否仍与登记表一致（env 漂移、env 未忽略与主检出缺依赖都是 warning）。错误 fail-closed，警告（未创建的登记 worktree、未纳管 worktree、未 merge-back、脏工作区）可用 `--strict` 升级为失败；`plan` 只打印 `git worktree add` 命令。三个子命令都只读，命令绝不执行 `git worktree remove`、`git worktree prune` 或删除分支，未合并的 worktree 只阻止宣称“已集成”。实际创建、依赖链接、端口分配、崩溃恢复与清理走项目面入口 `node .agents/runtime/commands/run.mjs worktree <bootstrap|recover|cleanup> --project . --json`（默认 dry-run，`--write` 落盘，`recover` 只清理带归因证据的崩溃残留，见 git-rules 的 Worktree 节）；两个入口的子命令集不同，分工见 `docs/rules/git-rules.md` Worktree 节。
- `vibe-harness audit --project <path> --kind cleanup`：只读扫描死代码、过期引用、过期文档、过期资源、过期记忆与过期索引，输出 `audit-report` 收据，`details.cleanup` 记录扫描面、已确认项与候选线索计数以及本次未覆盖的判定。扫描器把高置信结构与启发式候选分开标记，绝不删除或改写文件，`--write` 对 `cleanup` 一律拒绝；`--kind all` 仍只聚合 memory、review 与 improvements，清理需显式指定。

## Pull Request

涉及结构、公共契约、安全与可靠性、关键依赖、迁移回滚或跨模块边界的 PR 必须在 docs/adr/ 中提供正式 ADR，或说明无需 ADR 的原因。同步更新 docs/adr/catalog.json 和 docs/memory/DECISIONS.md；接受或拒绝后的决策通过新 ADR 替代，不改写历史核心内容。

文档、ADR、catalog 和 schema 变更按 AGENTS.md「验证选择」一节执行；pnpm check 已包含文档与 ADR 校验时不重复运行，仅在未覆盖相关变更时补充聚焦检查。

PR 说明目标、影响范围、实际验证、未验证项和必要的回滚路径。一个 commit 表达一个逻辑目的；不要用格式化或无关重构掩盖行为变化。

普通功能与修复从最新 <code>develop</code> 创建短期 <code>feat/*</code> 或 <code>fix/*</code> 分支，并以 squash merge 合入 <code>develop</code>。紧急线上修复从 <code>main</code> 创建 <code>hotfix/*</code>，合入 <code>main</code> 后立即把 <code>main</code> 回同步到 <code>develop</code>。正式发布以 merge commit 将 <code>develop</code> 提升到 <code>main</code>；不得创建长期 <code>release/*</code> 分支。发布成功后必须将 <code>main</code> 回同步到 <code>develop</code>，版本文件未回同步时不得开始下一次发布提升。

## 发布

发布前核对版本、用户可观察变化、兼容影响、回滚方式和监控信号。按发布影响运行 pack、integration、lifecycle 或在线 Eval；本地命令通过不等于发布成功。

### 自动化发布流程

仓库使用 [release-please](https://github.com/googleapis/release-please) 自动化版本同步，防止 `package.json` 版本、`CHANGELOG.md` 和 git tag 漂移：

1. Conventional Commits 合并到 `main` 后，release-please 自动累积变更并开一个 Release PR。
2. Release PR 包含版本号 bump、`CHANGELOG.md` 更新和 `.release-please-manifest.json` 更新。
3. 合并 Release PR 后，release-please 自动创建 `vX.Y.Z` tag 和 GitHub Release。
4. 不得手动编辑 `package.json` 的 `version` 字段或手动创建 `v*` tag；版本变更只能通过 Release PR 完成。

Breaking change（`feat!:` 或 `BREAKING CHANGE:` footer）会触发 major 版本 bump。
