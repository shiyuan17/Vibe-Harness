# Vibe-Harness 与 BL-CNAS 工作流优化执行状态（W0–W5）

报告类型：实施状态报告（非审查报告）。日期：2026-09-28。范围：`C:\Project\GitHub\Vibe-Harness`（框架）与 `C:\Project\GitLab\BL-CNAS`（试点）。依据：同日批准的《Vibe-Harness 与 BL-CNAS 工作流优化执行计划》。

结论分三组，禁止合并成一句「优化完成」：

| 组 | 结论 | 依据 |
| --- | --- | --- |
| 执行机制（W1/W2） | 已修复并验证 | `pnpm check:fast` 177/177、`pnpm test:integration` 602 pass/1 skip/0 fail、`pnpm test:component` 322/327（5 项失败全部为预期的 eval 资产指纹漂移） |
| BL-CNAS 试点（W3） | 已通过，端到端跑通 | 一次真实混合变更 `verify:changed`：lint/typecheck/test/contract-parity/backend-test 全部 exit 0 |
| 治理减负（W4）与对照评测（W5） | 规则部分已落地；**提效未证实** | W4 规则单源化与减负已改；W5 36 次对照实验本轮未执行，提效结论待观察 |

## 1. 基线与事实（W0）

- 仓库：Vibe-Harness `codex/governance-audit-batch` @ `d4f71f0`；BL-CNAS `develop` @ `be9e1507`。
- BL-CNAS 工作区含约 29 个**未归属业务改动**（组织域前后端、文档），本轮全程只改验证工具文件，未触碰业务文件。
- 复核后确认的关键事实（与旧审查结论不同的部分）：
  - `bun --cwd frontend run <script>` 只打印用法并以 **exit 0** 结束（假通过）；正确形式是 `bun run --cwd frontend <script>`。
  - BL-CNAS 仓库根**没有** `pom.xml`；后端在 `backend/`，含 `mvnw.cmd`/`mvnw`。原配置的 `mvn test` 既依赖全局 Maven，又在错误目录执行。
  - `vitest list` 全量收集约 307 秒（不可用）；`vitest related <源文件>` 单次约 50 秒，且能选出传递依赖用例。
  - `vitest related` 未命中任何用例时退出码仍为 **0**（`No test files found`）——必须从输出判定覆盖缺口。
  - `git diff --name-only` 默认转义非 ASCII 路径（`core.quotepath`），使中文文档路径被误判为 `unknown` 并触发全量升级。

## 2. W1 配置—计划—执行契约（已修复）

- 新增共享模块 `runtime/lib/verification-plan.mjs`、`runtime/lib/verification-receipt.mjs`，并镜像到 `.agents/runtime/lib/`；CLI 与 runtime 调用同一份档位解析、命令规范化、选择与去重逻辑。
- `validationCommands.tiers` 保持显式档位集合语义：quick 只跑 quick，standard 累计 quick+standard，deep 累计三档；不再要求命令匹配 `lint/typecheck/test/eval` 四个槽位才执行。
- 命令去重键为「规范化命令 + 工作目录」；检查 ID 冲突追加稳定摘要；`--only` 按稳定 ID 选择，未知 ID 非零退出。
- 计划模式（dry-run）不执行检查、不写运行收据。
- 证据：`tests/integration/verification-parity.test.js`（CLI/runtime 计划一致）、`tests/unit/verification-plan.test.js`、`tests/component/check-fast-tier-alignment.test.js` 全绿。

## 3. W2 收据与安全复用（已修复）

- 收据核心字段统一到 v3，读取兼容 v2/v3；缺少完整指纹的旧收据只展示、不参与复用。
- 复用不再依赖长任务锚点：任务锚点只引用收据 ID。收据按工作区隔离存放在忽略目录。
- 仅显式声明确定性、成功完成且运行前后快照一致的检查可复用；代码、验证配置、锁文件、工具链或环境身份变化即失效；未命中时输出原因。
- 「命令成功」与「证明了什么」分开记录：未执行的行为检查进入跳过项，不转成通过。
- 证据：`tests/integration/project-task-command.test.js`（`verify --reuse` 命中/漂移/命令集变化/非 git 工作区）、`tests/integration/receipt-records.test.js`。

## 4. W3 BL-CNAS 试点（已通过）

改动文件（全部属于验证工具面，未改业务逻辑）：

- `vibe-harness.config.json`：quick 改为三条原子命令；standard 引 `verify:backend:unit`，deep 引 `verify:backend:verify`；新增 `checks` 元数据（前端 deterministic=true、后端 false）；删除「`frontend check` 等价 lint+typecheck+单测」的错误说明。
- `frontend/scripts/validation-runner.mjs`：只做原子检查；前后端分流；后端用仓库内 Maven Wrapper；后端聚焦测试走显式「源码域 → 测试集合」映射（organization → `com.blcnas.organization.*Tests`，iam → `com.blcnas.iam.*Tests` + `com.blcnas.iam.application.*Tests`），未映射路径、POM、迁移脚本、测试资源一律回退完整后端单测；纯文档变更只跑 `docs-consistency`；删除文件/未知路径扩大范围；`standard|quick|deep` 委派统一运行时（不再聚合套聚合）；DM8 集成缺 `DM8_*` 环境时返回 blocked(2)。
- `frontend/scripts/vitest-changed.mjs`：以 `vitest related` 模块图为主选择器，按 web 与 mock/contracts 分组；vitest 配置、锁文件、删除文件、选不出用例时按组回退完整集合；`related` 未命中改为覆盖缺口（不再当通过）；按命令行长度分片避免 E2E 参数超限；git 读取统一 `core.quotepath=false`。
- `frontend/scripts/fixtures/vitest-related/**` + `frontend/scripts/vitest-related-selection.test.mjs`：证明相对导入、别名、重导出与传递依赖都能被选中。
- `frontend/scripts/validation-runner.test.mjs`：覆盖分流、映射、契约面识别、分片。
- `frontend/package.json`：新增 `verify:backend:unit`、`verify:backend:verify`、`verify:backend:dm-it`。
- 契约变更追加只读 `mock:check:bridge-parity`（**不**自动运行写盘 codegen）；契约面前缀为 `mock-server/api/`、`mock-server/mock-data/`、`web/src/api/`、`packages/prototype-contracts/`。

端到端证据（真实混合变更，命令：在 BL-CNAS 根执行 `bun run --cwd frontend verify:changed`）：

| 阶段 | 范围 | 结果 | 耗时 |
| --- | --- | --- | --- |
| lint | frontend-full（因配置变更升级） | exit 0 | 100.1s |
| typecheck | frontend-full | exit 0 | 0.7s（turbo 命中） |
| test | frontend-full | exit 0，238 文件 / 1650 用例 | 465.3s |
| contract-parity | mock-bridge-parity（只读） | exit 0 | 0.7s |
| backend-test | backend-full（存在未映射路径） | exit 0，462 用例，BUILD SUCCESS | 339.0s |

同一次运行的分类结果：`frontend=35、backend=7、contract=13、docs=2、unknown=1`（唯一 unknown 是仓库根的 `vibe-harness.config.json`，按「无法界定 → 两端扩大」处理）。中文文档路径已正确落入 docs 桶，验证了 `core.quotepath` 修复。

顺带修复的真实缺陷（这些在旧流程下都会静默漏检或假通过）：

1. `bun --cwd frontend run <script>` 假通过 → 统一改用 `bun run --cwd frontend`。
2. 后端命令依赖全局 Maven 且在仓库根执行 → 改用 `backend/mvnw.cmd`（Windows）/ `./mvnw`。
3. `vitest related` 零命中却 exit 0 → 解析输出判定覆盖缺口并按组回退。
4. 非 ASCII 路径被转义 → 无法界定影响面并触发全量升级 → 统一 `core.quotepath=false`。
5. `validation-runner` 与 `vitest-changed` 自身的 oxlint 错误（未用变量、`await` 成员访问、排序比较参数、夹具相对 URL 风格）→ 已修并跑 oxfmt。

## 5. W4 规则单源化与受控减负（规则已改，收益待测）

本轮直接交付：

- 检索入口默认单值化：`scripts/lib/install-planner.js` 的 `toolDiscoveryLine` 改为「默认只用一个与当前问题最匹配的入口」，并写入统一新鲜度语义——同一任务/同一工作区内已确认新鲜的索引不重复检查；索引陈旧时先用旧图定位、再用当前源码补齐受影响事实，不自动全量重建、不把旧图当当前事实。
- 角色按需加载：常驻入口不再要求每个任务先做角色识别，改为「只有架构决策、独立验证/审查、安全审查等触发场景才选择角色并只读其角色文件；普通只读、局部实现与聚焦验证不加载角色文件」。对应规则 `docs/rules/role-routing.md` 增补同口径默认句，生成面与规则面不矛盾。
- 索引规则对齐：`docs/rules/codebase-memory-mcp.md` 的「使用顺序」补齐「同任务/同工作区复用状态、只有失效信号才重查」与「stale 可先定位、再核对当前源码」两条，与 `docs/rules/codegraph.md` 已有一致口径。
- 安装投影同步：`AGENTS.md` 受管块按安装器重新投影（`node scripts/validate.js` 报 self-install conformance 通过，仅 `AGENTS.md` 一行变化）。

仍只进入实验、**未**放宽默认规则：固定「45 分钟且 25%」并行门槛改为任务相关净收益判断、普通缺陷是否可只要求可复现回归（机器冻结与受保护审批集中到高风险任务）。这两项在获得单独确认前不改动。

常驻上下文减少是软目标：本轮没有为了压字数删除安全条目（Memory 授权、硬边界、完成标准原样保留）。

## 6. W5 对照评测（未执行，协议就绪）

计划要求的 **6 类任务 × 新旧规则 × 各 3 次 = 36 次受控运行**本轮**未执行**。原因：单次最多 10 分钟、总预算最多 6 小时的受控运行需要连续占用会话与模型配额，超出本轮可用时间；且评测资产的 reference 重签需要宿主受保护审批。因此**不声称任何提效结论**。

可直接执行的口径（与计划一致）：

1. 六类任务：前端局部修改；后端缺陷复现与修复；共享模块间接依赖变化；前后端契约变化；索引陈旧但可由当前源码补齐的定位任务；多步骤任务的中断恢复与验证复用。
2. 控制：对照双方使用同一已修复执行机制，只切换待评估治理规则；固定模型/推理档/runner/任务输入/验收标准/预算；新旧交错执行；每次独立初始化状态；冷启动与缓存复用分开报告。
3. 指标：质量优先（关键安全与验收断言全通过、无新增漏检/越权/削弱断言/错误完成），再报告到首次有效验证与到最终验收的墙钟、上下文/Token、工具调用、重复验证、人工介入。不可观测项标记缺失。
4. 推广条件：配对完成时间中位数降低 ≥15%，或上下文成本降低 ≥25% 且完成时间不恶化；同时报告离散度与失败样本。三次重复只作小规模试点证据。
5. 之后对正常发生的 20 个真实任务做项目内被动记录（不后台领单、不读私人会话），样本不足时不给整体收益结论。

## 7. 迁移与回滚

- 迁移顺序已按计划执行：先在 Vibe-Harness 修共享契约/收据/安装测试，再迁移 BL-CNAS 配置与原子检查入口；W4 规则精简在正确性验收通过后才落地。
- 回滚：框架版本、项目配置与安装副本成套回滚，避免新旧解释器混用；新收据不能被旧运行时解释时停止复用并重新验证，不得降格为通过；规则减负若被证伪只回滚对应规则，保留执行正确性修复。
- 全程未提交、未推送、未发布、未自动更新 eval reference。

## 8. 未完成项与待确认（独立报告，不并入完成结论）

1. **eval reference 漂移（需受保护审批）**：`pnpm check` 的 5 项组件失败全部来自资产指纹漂移（`assets.aggregateHash`、`assets.groups.config.hash`、`assets.groups.rules.hash` 及其 behavioral 对）。W4 修改了 rules/config 资产，漂移属预期；按既有流程需宿主确认后执行：`pnpm vibe-harness eval run --project . --mode offline --write` → `VIBE_HARNESS_PROTECTED_APPROVAL=1 pnpm vibe-harness eval reference --project . --from <run> --write --confirm-reference-update --force` → `pnpm eval:sync --write` → `pnpm eval:replay --write` → `pnpm eval:behavioral --write`。本轮未执行。
2. **BL-CNAS 受管文件投影**：`AGENTS.md` 受管块与 `vibe-harness.config.json` 属红区/受管面，需经 `--confirm-red-zone` 的既有授权流程单独迁移；本轮只改了项目自有验证脚本与配置文件内容，未覆盖用户内容。
3. **后端聚焦映射仅覆盖试点域**：organization 与 iam 之外的域（公共基础设施、POM、迁移、测试资源）目前回退完整后端单测；若试点证明耗时不可接受，下一轮扩大映射表。
4. **DM8 证据缺口**：缺少 `DM8_*` 环境时 `verify:backend:dm-it` 返回 blocked(2)，H2 单测通过不代表 DM8 集成通过。
5. **W5 与 20 真实任务观察**：未执行（见第 6 节）。
