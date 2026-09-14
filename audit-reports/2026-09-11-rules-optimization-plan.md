# Vibe-Harness rules 规范优化 · 详细执行计划

- 日期：2026-09-11
- 状态：计划已落地（P0–P5 见提交历史）。本文件保留为执行计划的历史记录；下方 resident 预算约束已由 ADR-0005 取代，2026-09-13 更新。
- 更新（2026-09-13）：resident 治理预算已由 ADR-0005 与提交 `c359e97` 从 92 行放宽到 150 行，实际常驻约 56 行；本文件中的“≤92 行净零余量”约束作废，仅保留“预算为上限、精简为目标”的意图。
- 范围：`docs/rules/`、`skills/integrations/linear-workflow/`、`docs/specs/linear-multi-agent-workflow-spec.md`、`templates/adr/`、`docs/catalog.json`
- 授权记录：Eval reference 再生成已获用户预授权，执行时按 `CONTRIBUTING.md`「Eval reference 更新清单」操作并单独提交审查。

## 1. 目标

1. 删除过旧描述信息（`V1.1`、硬编码工具版本等）。
2. 模板描述尽量中文化。
3. 统一 rules 内容排版。
4. 优化 Linear 工作流结构与去重。
5. 优化 Linear 与 DAG 的关联（单一事实源 + 映射表）。
6. 按业界最佳实践分阶段执行并验证。

## 2. 硬约束（改前必读，决定改法）

| 约束 | 来源 | 影响 |
| --- | --- | --- |
| resident 预算 ≤ 150 行（原 ≤92 已作废） | `scripts/lib/pack-validation.js`（现为 150 行上限，ADR-0005；实际常驻约 56 行） | governance-core 可列表化/表格化排版；预算为上限，精简仍为目标 |
| 长段落重复门禁：`docs/rules` + `templates` 内 ≥240 字（归一化）段落不得跨文件重复 | `pack-validation.js:482-500` | 去重时不能整段复制，改用表格/引用 |
| 各规则文件必须保留 content-quality 关键词（如 governance-core 的“事实充分性与歧义路由”、git-rules 的“参考实现”等） | `pack-validation.js:386-460` | 排版改写不得删除这些术语 |
| ADR 章节名必须逐字匹配英文 `## Context and Problem Statement` 等 8 个 key | `scripts/lib/adr-validation.js:42-44` | ADR 模板不能把标题改中文，只能加中文说明行 |
| 测试断言字面量 | `tests/linear-workflow.test.js`、`tests/execution-simplification.test.js`、`tests/rules-depth.test.js`、`tests/target-validation.test.js`、`tests/documentation.test.js` | 见各阶段“保留字面量” |
| eval reference 指纹按 config/hooks/rules/skills 分组漂移 | `scripts/lib/eval-assets.js:5-10` | 全部内容冻结后统一再生成一次，不同步做 |
| catalog 语言枚举 `zh-CN/en/bilingual`；新文档必须入 catalog | `schemas/docs-catalog.schema.json` | ADR 模板改中文后需同步 `docs/catalog.json` |

## 3. P0 清理过时描述（对应目标 1）

| 文件:行 | 现状 | 改为 |
| --- | --- | --- |
| `skills/integrations/linear-workflow/SKILL.md:10` | `V1.1 禁止自动领取，也就是…` | `禁止自动领取：不自动从队列领单…` |
| `.../references/dag-parent.md:41` | `V1.1 不定义 optional node：…` | `不定义 optional node：…` |
| `.../references/execution-receipt.md:28` | `role 在 V1.1 只允许 writer` | `role 只允许 writer` |
| `docs/specs/linear-multi-agent-workflow-spec.md:5,13,96,142,148` | `Implemented（V1.1 资产合同…）` 等 5 处 | 状态行去版本：`Implemented（资产合同；宿主执行强制能力按集成条件生效）`；正文 `V1.1` 改“本规格”或直接删除 |
| `docs/rules/codebase-memory-mcp.md:13` | `固定版本 0.9.0 的 trace_call_path` | `runtime 锁定版本的 trace_call_path`；版本 SSOT 留在 `runtime/tools/codebase-memory-mcp/package.json` |

保留：Execution Envelope `v1/v2` schema 版本、Receipt `vibe-harness.linear-execution/v1`、ADR 编号——这些是现行合同标识，不是过时描述。

验收：`rg "V1\.1|固定版本 0\.9\.0" docs skills` 无残留（archive 除外）。

## 4. P1 模板描述中文化（对应目标 2）

对象：`skills/integrations/linear-workflow/references/` 6 个模板。

| 文件 | 标题改造 | 必须原样保留的字面量 |
| --- | --- | --- |
| `ai-coding-task.md` | Goal/Context/Repository/Scope/Out of Scope/Contract/Acceptance Criteria/Dependencies/DAG Metadata/Verification/AI Rules → 中文（可括号注英文） | `Target branch (exact remote ref): origin/develop`、`Contract: None`、`Dependencies: None`、`resourceLocks: None`、`kind: read \| write`、`trigger: all_success \| all_done`、`Managed by Linear relations`、`Fixes <ISSUE-ID>`、`NOT_READY_TARGET_BRANCH` |
| `dag-parent.md` | 目标/背景/整体验收标准/共享契约/范围外/依赖/DAG 元数据/Fan-in 验证/完成策略/AI 规则 | `Fan-in Verification`、`Completion Policy`（`tests/target-validation.test.js:118-119` 断言原词，中文标题需保留英文括注） |
| `release-issue.md` | 目标/背景/范围/范围外/契约/DAG 元数据/验收标准/依赖/验证/Linear 与 Git 关联 | `kind: aggregate`、`GitHub Release`、`Refs <ISSUE-ID>`、`main.*develop` |
| `triage-template.md` | Title/Problem/Impact/Urgency/Suspected Area/Decision/Optional → 中文 | `accept / duplicate / decline / snooze` |
| `execution-receipt.md` | Start Receipt/Terminal Event/Handoff Completion Payload → 中文 | 三个 schema 字符串与全部 JSON 字段名 |
| `workspace-setup.md` | Workflow/Triage/Guidance/GitHub Automation/Custom Views/MCP → 中文 | `feat/*、fix/* → develop → main`、`hotfix/* → main → develop`、`origin/develop`、`Fixes/Refs <ISSUE-ID>` |
| `templates/adr/adr-template.md` | 8 个英文 key 必须保留；每个标题下加一行中文说明，占位文案中文化 | frontmatter 字段名、英文 section 名 |

保留英文：`templates/task.en-US.md`、`delivery.en-US.md`（宿主语言适配是特性，不属于本次中文化对象）。

同步：ADR 模板语言变化后更新 `docs/catalog.json` 中 `templates/adr/adr-template.md` 的 `language`（en → zh-CN 或 bilingual），并跑 `docs:audit`。

验收：`rg "## (Goal|Context|Scope|Verification|AI Rules)$"` 在 linear references 中无命中（允许括注形式）；`pnpm test:integration`（linear/target-validation）通过。

## 5. P2 rules 排版统一（对应目标 3）

统一规范：标题 → 一句适用范围 → `##` 分节 → 表格/清单承载映射与枚举；一个 bullet 一个规范点；保留“必须/不得/只允许/可以”语气词。

| 文件 | 问题 | 动作 |
| --- | --- | --- |
| `governance-core.md` | 第 11、12 行 >600 字 | 将并列项拆为分号/编号或子列表；150 行预算下无硬性加行限制，仍以精简为目标 |
| `ai-collab-rules.md` | 第 17、19、21 行超长段落 | 节点字段改表格；ready/fail-closed/scope 规则改 bullet；语义不变 |
| `linear-workflow.md` | 5 段 300-430 字密集散文 | 随 P3 整体重排 |
| `git-rules.md` | 最长 400 字段落 | 拆 bullet，保留“分支/提交/PR/参考实现”关键词 |
| 其余规则 | 结构已较清晰 | 只做一致性微调，不批量重写，避免测试字面量漂移 |

护栏：每阶段结束跑 `pnpm lint`（resident、重复长段落、content-quality 三套门禁）。

## 6. P3 Linear 工作流重构（对应目标 4）

目标结构（`docs/rules/linear-workflow.md`，内容等价、信息不丢）：

```text
# Linear 多 Agent 工作流
简介：Linear=状态/责任/依赖真值；GitHub/GitLab=代码/PR/合并真值；三层分支流
## 1 授权模型
  禁止自动领取 / Writer 两种启动条件 / 身份四层 / 最小登记边界 / Envelope mode+effect
## 2 状态模型与责任
  固定状态定义表（状态 | 进入条件 | 完成证据 | 允许写入者）
  转换协议（读→校验→写→重读）/ 实时状态优先 / 禁止倒退 / Triage 四动作
## 3 Definition of Ready
  必需字段清单 / Target branch 解析 / NOT_READY_TARGET_BRANCH / Dependencies 真值
## 4 原生 DAG（Linear 投影）        ← P4 只保留映射
## 5 显式执行登记（Receipt）
  5 步顺序 / schema+source / active 与幂等 / handoff/release/abort / 隐私边界
## 6 Git、状态同步与安全
  分支与 closing 语义 / 冻结 base SHA 与 merge-base / automation 优先 / credential helper
## 7 终止与交付
  terminalCondition / monitor 边界 / 并发软上限
```

关键改进：

- 新增**状态映射表**：Linear Status ↔ 本地 `result` ↔ 完成证据 ↔ 写入者（唯一真值表，替换散落解释）。
- “每次派发 write 节点前重新验证 DAG/hash/Scope/锁/HEAD/工作区”在规则内出现 3 次 → 收敛为 1 条规范 + 章节引用。
- `SKILL.md` 分层：保留触发条件、7 步操作流与 fallback，删除与规则重复的规范条文；规则是合同，Skill 是操作入口（渐进披露）。
- 保留断言字面量：`禁止自动领取`、`用户在本轮明确要求.*具体 Issue`、`已委派给当前 Agent.*宿主.*显式启动`、`普通提及.*Review.*Verify.*不授权登记或执行`、`不自动从队列领单`、`未指定 Issue.*不得选择、认领或更新任务`、`feat/*、fix/*.*develop.*main`、`hotfix/*.*main.*develop`、`develop.*合并.*开发 Issue.*Done`、`无 Parent.*Dependencies=None.*resourceLocks=None.*独立 Issue`、`当前 Issue.*直接关系`、`不得.*全项目 DAG.*遍历`、`顺序执行.*工作区干净.*当前 clone`、`并发.*脏工作区.*隔离.*worktree`。

## 7. P4 Linear × DAG 关联收敛（对应目标 5）

- **SSOT 决策**：`ai-collab-rules.md` 独占节点模型、result 枚举、all_success/all_done、ready/fail-closed、Scope/Lock 语义；`linear-workflow.md` 只保留 Linear 投影与映射表。
- 新增**字段映射表**（放 linear-workflow 第 4 节）：

| DAG 字段 | Linear 载体 | 真值来源 |
| --- | --- | --- |
| id | Issue identifier | 平台 |
| kind | DAG Metadata | 描述 |
| output | 约定输出 | 描述/评论 |
| dependsOn | 原生 blocked-by / blocks | 平台关系 |
| trigger | DAG Metadata | 描述 |
| writeScope | Scope 路径 | 描述（语法校验同 ai-collab） |
| resourceLocks | DAG Metadata | 描述 |
| verification | Verification | 描述 |
| result | 本地解释，不回写 | 计算 |

- 明确三条非边：Parent/Sub-issue=分解、related=无执行语义、描述依赖清单=非真值。
- 删除 `linear-workflow.md` 中对 scope/trigger/all_done 的重复规范复述，改为引用 + 表格单元格承载；`ai-collab-rules.md` 保持不变的部分只做排版。
- 保留断言：`Scope 是 writeScope 的 Linear 投影`、`all_done.*不能把失败 DAG 或 Root 判为成功`、`Parent.*不得 Done`、`Parent/Sub-issue 只表示分解，不隐含顺序`、`blocked-by / blocks 是唯一执行依赖`、`related.*不进入 DAG`、`kind（read / write / aggregate）`、`trigger（all_success / all_done）`、`本地 result 使用 pending…cancelled`、`每次派发 write 节点前重新读取并确认 DAG 版本或 hash`、`子节点交接至少记录节点结果`。
- 可选治理动作：该关联变更属公共合同调整，按 CONTRIBUTING 评估补 `ADR-0005`（或在 PR 说明无需 ADR 的理由）。

## 8. P5 验证矩阵与 reference 流程（对应目标 6）

执行顺序：

1. `pnpm lint` — resident ≤92、重复长段落、content-quality。
2. `pnpm docs:audit` — catalog/链接/parity。
3. `pnpm skills:audit`。
4. `pnpm eval:check`。
5. `pnpm test:unit` — execution-simplification、rules-depth、documentation。
6. `node --test tests/linear-workflow.test.js tests/target-validation.test.js`（属 test:integration）。
7. 内容全部冻结后统一再生成 reference（已获预授权）：
   - `pnpm vibe-harness eval run --project . --mode offline --write`
   - `pnpm vibe-harness eval reference --project . --from <run> --write --confirm-reference-update`
   - 同步 `evals/results/` 与 `.agents/evals/` 镜像。
   - 确认漂移分组仅 `rules` + `skills`（无 config/hooks）。
8. `pnpm eval:replay`、`pnpm test:eval`。
9. `git diff --check`。

完成标准：以上全绿；`rg` 无 V1.1/0.9.0 残留；linear 规则含状态映射表且无重复重验证条文；两个 DAG 文件无规范冲突；reference diff 只含预期指纹与批准时间。

## 9. 业界实践映射

| 实践 | 落点 |
| --- | --- |
| SSOT / DRY | DAG 契约收敛到 ai-collab；工具版本只在 runtime lockfile |
| 渐进披露 | 规则=合同、Skill=操作、references=模板 |
| 规范语气词（RFC 2119 风格） | 保留既有“必须/不得/只允许”体系 |
| Docs-as-code 门禁 | lint 预算 + docs-audit + eval 指纹 |
| ADR 记录重大决策 | 视评估补 ADR-0005 或说明理由 |
| 小步可逆提交 | 按 P0→P5 六个逻辑提交，reference 单独一个提交 |

## 10. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 测试字面量漂移 | 每阶段先 grep 断言短语，再跑聚焦测试 |
| resident 行数超限 | 每文件改完立即 `pnpm lint` |
| 长段落重复触发 lint | 去重只用表格/引用，不整段搬移 |
| ADR 模板破坏解析 | 英文 key 逐字保留，仅加中文行 |
| reference 误更新 | 内容冻结后一次性再生成，单独提交并审查 diff |
| 回滚 | 每阶段独立提交，`git revert <commit>` 即可；reference 提交可单独回退 |

## 11. 提交序列

1. `docs(rules): remove stale version references`（P0）
2. `docs(templates): localize linear template descriptions`（P1）
3. `docs(rules): unify rule formatting`（P2）
4. `docs(rules): restructure linear workflow`（P3）
5. `docs(rules): converge linear DAG projection on SSOT`（P4）
6. `chore(eval): regenerate offline reference after rules refresh`（P5）

不手改 `CHANGELOG.md`（release-please 管理）。
