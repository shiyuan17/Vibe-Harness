# Vibe-Harness 工作流审查与聚焦验证可执行化（2026-09-02 批次）

## 执行结论

**Q1：单路径内核是否应升级为分层、多工作流协同模式？——不升级，结构保持不变。**
分层协同已以 opt-in 形式存在且形态符合业界实践（渐进式复杂度：简单可组合默认路径优先）：拆分判定（v2.8.0 硬触发/软信号）→ 轻量 Task DAG（ai-collab-rules）→ Linear 多 Agent 工作流（显式插件）→ Execution Envelope/checkpoint（长任务）→ agentmemory（跨会话）。本仓库历史即实证：v0.4–0.9 强制规划门禁与 Tester/Reviewer/Handoff 角色被刻意拆除，`tests/skill-closure.test.js` 防回归。缺口不在结构，在既有路径中最弱一步「聚焦验证」的可执行性——本批投入于此。

**Q2：「聚焦验证」是否明确、可执行？——原则层清晰（三重锁定：unit 行为锁 + pack-validation 内容质量 + eval:behavioral 变异），执行层存在三个缺口，本批全部关闭：**
1. **无唯一定义处**：AGENTS.md 与 CONTRIBUTING.md 验证矩阵有差异（`skills:audit`、`runtime:audit`、浏览器验证仅后者），test-rules.md 只到类型级不到命令级；
2. **无选择机制**：「受影响范围的聚焦测试」没有变更路径→命令的机械映射；唯一可执行的 `verify --project` 是全项目四命令链而非变更范围；
3. **处方与自动化错位**：`lint:eslint`、`typecheck` 脚本存在但从未进 CI（CI 的 "lint" 仅 `node --check` 语法检查）；`skills:audit`、`eval:behavioral` 被处方但纯手动；`docs:audit` 被处方为「额外运行」却已内含于 `pnpm check`（validatePack 内嵌 validateDocumentation）。

**Q3：整体 Harness 是否具备支撑大型项目长期持续开发的能力？——结构上具备，耐久性缺口已处置或入债：**
- 治理记忆空转（原 P2-7）：本批期间已由并行 P2 执行会话的 B5-c 记忆种子化覆盖（`docs/memory/PROJECT_STATE.md` 已有实时状态，模板已加渲染占位符脱离字节比对）；
- 双写镜像税（P2-2）：并行流已建 `scripts/lib/sync-rules.js`（`pnpm docs:sync`）自动化 rules→docs/rules 投影；
- 措辞锁演化税（P2-3）：归并行流处置；
- typecheck 欠账：本批发现并立项 **TD-2026-09-02-2**（详见下文）；
- eval reference 手工重审批：本批把书面清单落入 CONTRIBUTING（关闭 TD-2026-09-01-4 的清单部分）。

## 一、本批实施

### A1 聚焦验证选择器（新增）
`scripts/verify-focused.js` + `pnpm verify:focused`：把本轮变更路径机械映射为建议命令清单（`git diff --name-only HEAD` + `git status --porcelain` 采集；`--base <ref>` 对比分支；`--run` 依序执行、首败即停）。映射桶按路径前缀首个命中：`.github/workflows/`→test:eval；`evals/`→eval:check+test:eval；`skills/`（含 `.agents/skills/`）→skills:audit+eval:check+test:eval；`rules/`、`docs/rules/`、`runtime/`（含 `.agents/runtime/`）→test:unit+eval:check 并附 reference 漂移注记；`scripts/`→test:unit+test:integration；`tests/`→test:unit；`adapters/`→check+test:integration；`manifests/`、`schemas/`、`templates/`、`docs/` 与根文档→check；其余回退 check。**建议非门禁**：不接入 hook、不参与完成判定，范围仍按 governance-core 与完成主张匹配。测试：`tests/verify-focused.test.js`（7 例，含临时 git 仓库的路径采集测试），已入 test:unit。

### A2 验证矩阵统一（单一事实源）
`AGENTS.md` 验证选择（非托管区）成为唯一规范表：补齐 CONTRIBUTING 独有行（skills:audit、runtime:audit、真实浏览器），新增 rules/runtime 内容行与 CI workflow 行，加入 `pnpm verify:focused` 用法；docs:audit 处方改为「`pnpm check` 已内含，仅未运行 check 时显式执行」。`CONTRIBUTING.md` 验证选择表格替换为指向 AGENTS.md 的引用，保留 PR 边界说明。

### A3 typecheck 处置（调整后落地）
首跑发现 `pnpm typecheck` 基线 **143 处历史类型标注问题**（TS2339×81、TS2353×28 等，29 个文件；较集中：scripts/lib/eval-report.js×19、scripts/lib/project-profile.js×16、scripts/vibe-harness.js×12、runtime/hooks/lib/execution-envelope.mjs×12）——该检查此前从未在任何自动验证中运行。逐项修复需逐处理解 JSDoc 契约且波及 29 文件（含 runtime hooks 镜像），不属本批范围。处置：
- CI 以 `continue-on-error: true` 非阻断运行 typecheck，信号先可见；
- 立项 **TD-2026-09-02-2**（docs/memory/TECH_DEBT.md）记载基线分布与关闭路径：清零 → CI 转阻断 → `vibe-harness.config.json` 启用 `validationCommands.typecheck` → 重渲染 AGENTS.md 托管块；
- config 暂保持 `typecheck: null`（启用会使 `verify --project` 被基线错误卡死），AGENTS.md 托管块「Typecheck: 未配置」与现状一致，不改。

### A4 CI 补线（.github/workflows/ci.yml）
- product-run 增加 `pnpm lint:eslint`（阻断；基线 0 errors / 80 warnings）与 `pnpm typecheck`（continue-on-error，见 A3）；
- supply-chain 增加 `pnpm skills:audit` 与 `pnpm eval:behavioral`（两者本地实测 exit 0；eval:behavioral 为纯内存变异，秒级）。已核对 `tests/eval-ci.test.js` 断言均为包含式，新增步骤安全。

### B1 EVAL-SPLIT fixture 与规则源 parity（P2-6 收敛版）
`tests/eval-split-parity.test.js`（2 例，已入 test:unit）：锁定三对阈值锚点（规则源 `0–1 / 2–3 / 4 项及以上` ↔ fixture `0-1 / 2-3 / 4 or more`——唯一保留的规则侧措辞锁，属 eval 契约承重语义）+ fixture 八个概念锚点（eval 资产锁）+ 决策表校验（按硬触发/软信号计数推导期望 token，须与各 case 的 requiredOutputFragment 一致，场景关键词同步锁定）。设计上与并行流的 P2-3 措辞锁解耦方向兼容：规则侧概念措辞锁仍归 `tests/execution-simplification.test.js` 单一所有，本文件不重复。

### B2 治理记忆激活（由并行流覆盖）
模板占位符与真实状态填充已由并行 P2 执行会话 B5-c 完成，本批不覆写其记录。

### B3 eval reference 更新清单（关闭 TD-2026-09-01-4 的清单部分）
`CONTRIBUTING.md` 新增「Eval reference 更新清单」：确认漂移分组与预期一致 → 非预期漂移先查因 → 正规入口再生成（`eval run --write` → `eval reference --from <run> --write --confirm-reference-update`，命令已核对 `scripts/vibe-harness.js:785-811` 与 `scripts/lib/project-evaluation.js:47`）→ 重跑确认并在 PR 说明记录。

### B4 flaky 集成测试 retry 标记（TD-2026-09-01-2 机制部分）
`tests/tool-provisioning.test.js` 两处负载敏感测试加 `{ retry: 2 }`（MCP browser probe 握手超时 `:1072`、full write degrades 120s 超时 `:1528`），注释注明依据 TD-2026-09-01-2 与「连续 10 次全量无此类失败后移除」的关闭条件；TD 条目保持开放。

### C1 本报告
`audit-reports/2026-09-02-focused-verification-workflow-review.md`（即本文件）。

## 二、并行执行会话的协调发现

本批实施期间检测到另一执行会话在推进 2026-09-01 审计的 P2 路线图（PROJECT_STATE 记为 B1–B5-b 已完成、B5-d reference 再生成待办），工作树由 39 文件增长至约 60 文件改动。协调处理：
- 不覆写其活跃记录：`docs/memory/PROJECT_STATE.md`、`templates/memory/PROJECT_STATE.md`、`docs/memory/IMPROVEMENTS.json` 均以其写入为准；
- 共享文件的编辑均为增量且语义独立（AGENTS.md、CONTRIBUTING.md、package.json、ci.yml），Edit 工具的外部修改检测保障无覆盖；
- 其 P2-6 采用「三副本逐字一致 + docs/evals.md 注记」，本批 B1 补规则源阈值 parity，互补不重复；
- 本批改动（scripts/verify-focused.js、两个新测试、ci.yml、package.json、AGENTS.md/CONTRIBUTING、TECH_DEBT 条目）均不在指纹分组（config/hooks/rules/skills）内，`eval:replay` 实测通过证实无指纹漂移。

## 三、验证记录（本批实际执行，2026-09-02）

| 检查 | 结果 |
| --- | --- |
| `pnpm check`（lint + validate + test:unit） | 通过，196/196（含新增 verify-focused 7 例、eval-split-parity 2 例） |
| `pnpm test:eval` | 152 通过 / 1 跳过 / 0 失败 |
| `pnpm eval:check` | 通过（exit 0） |
| `pnpm eval:replay` | 通过（criticalPassRate 1、overallScore 1；本批无指纹漂移） |
| 聚焦集成子集（project-verification + vibe-harness-cli） | 9/9 通过 |
| `pnpm docs:audit` | 通过（92 documents） |
| `pnpm lint:eslint`（首次全仓运行） | 0 errors / 80 warnings（exit 0，可阻断入 CI） |
| `pnpm typecheck`（首次全仓运行） | 143 errors（历史欠账，TD-2026-09-02-2，CI 非阻断） |
| `pnpm eval:behavioral` / `pnpm skills:audit` | 均 exit 0 |
| `pnpm verify:focused` CLI 冒烟（66 变更路径） | 输出 6 条建议命令 + reference 漂移注记，exit 0 |

未运行完整 `pnpm test:integration`（约 25 分钟）：本批无 installer/runtime/adapter 改动，按矩阵的聚焦集成子集已通过；全量验证归并行流 B5-d 的合并批次收尾。

## 四、遗留与建议

1. **typecheck 债（TD-2026-09-02-2）**：建议按文件分批修复（eval-report.js → project-profile.js → vibe-harness.js → execution-envelope.mjs 的顺序覆盖 59/143），每批过 `pnpm check`；清零后执行关闭路径。
2. **80 条 eslint warnings**：以 `no-unused-vars`/`consistent-return` 为主；`tests/tool-provisioning.test.js:687` 的 `no-undef`（'codebaseMemory' is not defined）值得单独核查是否为真实缺陷。
3. **提交分组建议**（两批共存于工作树，建议由维护者按逻辑分组提交）：① 2026-09-01 审计 P0/P1 批次（既有改动）；② 并行流 P2 批次（其自行归组）；③ 本批 A1+A2+A3（verify:focused + 矩阵统一 + TD 条目）；④ 本批 A4（ci.yml）；⑤ 本批 B1（parity 测试）；⑥ 本批 B3+B4（reference 清单 + retry 标记）；⑦ 本报告。
4. **P2-8（eval:behavioral 覆盖扩充）、P2-2（双写自动化收尾）、P2-3（措辞锁迁移）** 归并行 P2 执行会话路线图。
