# Phase 1：上下文、记忆与长期连续性审查

日期：2026-09-25。基线：`98a9d52585e8cfe4692e8f81810b075cd8643dc6`。

## 结论与边界

最小方向不是再增加恢复规则，而是让现有锚点**能如实记录、始终允许保存恢复事实、不能把残缺内容呈现成完整恢复入口**。现有 Memory / Session 文本和代码索引可辅助导航，尚不能据本轮证据认定长期多 Agent 连续性已稳定闭环。

- 正式问题 4 项：P1 两项、P2 两项，无 P0。均有当前源码与本轮隔离 fixture 证据，不使用历史报告、旧 Eval 结果或 Memory 正文作行为证据。
- 深读范围：`runtime/commands/run.mjs` 的 Anchor init/update/status、plan 恢复关联；`scripts/lib/memory-audit.js`；Agentmemory Skill/reference、记忆模板、索引规则及 codebase-memory wrapper/freshness。
- 不审 dispatch ready / Task DAG 调度、worktree 事务、收据可信性或完成门禁。下文的 `status: ready` 仅讨论“锚点可恢复性”，不据此推断任务完成或派发放行。
- 采用 `bug-finding` 的只读证据化审查方式。产品未修改；只写本报告。未读取 `.agents/memory/`、`docs/memory/` 或 `memory/` 的既有正文，存在性沿用 Phase 0 元数据。
- 未阅读其他 Phase 1 输出，未派生子 Agent。已保护其他审查文档的未跟踪改动。

## 能力面与五级实现状态

“已实现”仅表示本轮所查入口存在且相关行为取得证据；不等于真实宿主长任务整体通过。

| 能力 | 五级状态 | 已确认边界 |
|---|---|---|
| 轻量项目上下文摘要 | 已实现（源级） | `runtime/commands/run.mjs:330` 的 `projectContext` 只取配置、包脚本名和至多 200 项顶层目录，不加载全部规则/Memory；本轮未专门执行此入口。 |
| Anchor 初始化、局部更新、恢复摘要 | 部分实现 | init/update/status 可执行，聚焦现有用例通过；下文 C1、C2、C4 证明恢复内容契约仍有缺口。 |
| `verify --reuse` 的 Anchor 查询关联 | 已实现（源级） | `runtime/commands/run.mjs:3271` 查询锚点记录，匹配 fingerprint 与 commandSet；`--plan` 优先于 reuse 的既有用例位于 `tests/integration/project-task-command.test.js:598`。本轮不裁决收据可信性。 |
| 本地 Memory 机械审计 | 部分实现 | 检查模板、日期和引用；本轮复现 sessions 漏扫与条目顺序影响结果，见 C3。 |
| Memory / Session / Handoff 恢复指导 | 仅规范定义 | `skills/integrations/agentmemory/references/handoff.md:8` 要求按 cwd 目录边界找最近 completed session；`:20` 要求本地从 CURRENT 入口恢复；`:27` 要求核验提交祖先。不能把提示文字当作宿主稳定执行证据。 |
| codebase-memory 图包装与新鲜度戳 | 部分实现 | wrapper、状态比较函数存在；Phase 0 已确认当前安装入口为 `runtime-not-installed`，本轮未安装/联网补齐。 |
| CodeGraph | 部分实现 | 本轮实际工具调用取得相关源码与调用关系；工具提供的是外部能力，跨 worktree、长期 watcher、共享索引行为未做运行验证。 |
| 原生压缩 / 恢复 / 真实多 Agent 交接 | 无法确认 | H12/H13/H14 场景存在，但本轮未执行真实宿主场景；没有把 JSON 场景文件当作通过证据。 |

## 正式问题

### C1 — `task update` 接受初始化字段后静默忽略，恢复目标可继续停留在旧值（P2）

**问题 / 触发条件**：长任务目标、验收或风险发生已授权调整，调用者用现有字段执行 `task update --goal ... --risk-level ... --acceptance ... --write`。命令返回 `passed`，但字段完全不变；没有提示这些参数仅用于 init。

**证据（当前源码与原文）**：

- `runtime/commands/run.mjs:124`：`valueFlags` 包含 `'title', 'goal', 'risk-level', ... 'acceptance'`，解析器不区分 init/update。
- `runtime/commands/run.mjs:3344`：初始化写入 `title: args.title`；`:3346`、`:3347`、`:3348` 分别写入 `riskLevel`、`goal: args.goal`、`acceptance: args.acceptance.filter(...)`。
- `runtime/commands/run.mjs:3638` 起的更新分支处理 stage、unitStatus、decision/blocker、failure、nextAction、verification，函数到 `:3744` 不消费上述四个初始化字段。
- `runtime/commands/run.mjs:3736`：`status: args.write ? 'passed' : 'planned'`；`:3739` 另行返回 `written: changed && Boolean(args.write)`，没有指出未消费参数。
- 本轮 fixture：先 init 为 `Old goal/light/old acceptance`，再 update 四个字段，实际得到：
  `{"status":"passed","changed":false,"goal":"Old goal","riskLevel":"light","acceptance":["old acceptance"]}`。

**五级实现状态**：部分实现。基本更新已实现；参数到持久内容的语义不完整。

**根因**：所有子命令共享宽松参数集合，而每个子命令没有收紧自身可消费字段；“调用成功”掩盖“请求未被处理”。

**影响**：后续 Agent 读取锚点仍看到旧任务事实；调用者必须再检查完整输出或绕过命令手工改 JSON。这里不声称风险字段已造成验证放行，仅确认它没有被更新。

**最小改进（减法优先）**：先拒绝 update 上不支持的 init-only 字段并给出明确错误，不新增命令或规则层。若产品确认锚点需原地调整目标，再让现有 update 真正更新需要的字段；不要继续“接受但忽略”。

**最聚焦回归**：同一 fixture 分别传四个字段，要求“确实持久化”或“明确拒绝”二者之一，禁止 `passed + 原值不变`。

### C2 — 计划漂移时连失败、阻塞和下一步也无法保存，检查门与恢复记录耦合（P1）

**问题 / 触发条件**：绑定计划后计划内容发生变化，Agent 在压缩或交接前尝试记录观察到的失败/阻塞及下一步。update 在处理这些内容之前就失败，因此恢复锚点保留过时状态。对计划已损坏、待确认或暂不可读的情形，先恢复计划门并不总是可行。

**证据（当前源码与原文）**：

- `docs/rules/governance-core.md:35`：再次压缩时“继续实质写入前必须先更新锚点（当前阶段、实施单元状态与最新验证收据）”。
- `docs/rules/governance-core.md:37`：“锚点与工作区不一致时以实际 diff 为准并更新锚点。”
- `runtime/commands/run.mjs:3616`：`if (typeof current.planFile === 'string')` 后立即调用 `taskPlanCheckReport`。
- `runtime/commands/run.mjs:3618`：plan check 不通过便 `return taskFailure(...)`，发生在 `:3666` 的 blocker、`:3684` 的 failure、`:3691` 的 nextAction 处理之前。
- `runtime/commands/run.mjs:2931`：漂移错误为 `record the reason and run task plan-sync before continuing`。
- `tests/integration/project-task-command.test.js:624` 的既有用例明确覆盖“受管计划绑定、漂移检查与 plan-sync 阻断更新”；本轮该用例通过，说明这是目前可观察到的门行为，不是测试环境偶发错误。
- 本轮 fixture：合法绑定计划后追加一条约束，执行带 `--failure`、`--blocker`、`--next-action` 的 update。返回 `VIBE_HARNESS_PLAN_DRIFT`；重新 status 得到 `blockers: []`、`failures: []`、`nextAction: null`。

**五级实现状态**：部分实现。漂移检测已实现；“发生漂移时持久化恢复事实”链路未实现。

**根因**：执行/计划一致性门被复用为所有锚点写入的前置门，未区分“允许继续实施”和“允许记录为何不能继续”。

**影响**：最需要 checkpoint 的异常时刻，命令反而拒绝保留新观察；后续会话只能依赖未压缩对话或另写文档。被拒绝调用的原始参数不会进入锚点，失败原因与下一步丢失。

**最小改进（减法优先）**：缩小现有 plan 门的适用范围：保留执行状态推进所需检查，但让纯恢复事实更新能保存，并显式携带漂移状态。无需新建“紧急恢复”模板、第二套日志或新流程。

**最聚焦回归**：计划漂移/不可读时，failure、blocker、nextAction 仍可落盘；同时原有实施/派发边界不得因这种记录写入而被放宽。后者交给工作流域验证。

### C3 — 记忆审计的扫描单位不等于恢复单位：漏掉 sessions，条目顺序改变结果（P2）

**问题 / 触发条件**：审计本地记忆时，坏日期/坏引用位于 `sessions/`，或同一文件含一新一旧两个记忆条目。当前机械审计可以输出没有证据项的 `healthy`。

**证据（当前源码与原文）**：

- `skills/integrations/agentmemory/references/audit.md:7`：运行态扫描范围包括 `CURRENT.md`、`observations.md`、`decisions.md`、`sessions/`。
- `skills/integrations/agentmemory/references/handoff.md:21`：“CURRENT.md 缺失或信息不足时，按 sessions/ 倒序找最新记录补齐。”
- `scripts/lib/memory-audit.js:63`：根目录只有 `['docs/memory', '.agents/memory']`；`:66` 使用单层 `readdir`；`:67` 的 `if (!entry.isFile() ...) continue` 跳过目录，没有递归 sessions。
- `scripts/lib/memory-audit.js:91`：`const verified = fields.find(...)`；`:99`、`:100` 同样以第一个复核/验证/更新时间决定整个文件的日期判据。
- `scripts/lib/memory-audit.js:120`：返回 `{ status: reportStatus(evidence), evidence, details: { filesChecked: files.length } }`，不列出未扫描的恢复目录或多条目限制。
- 本轮 fixture A：CURRENT 日期有效，`sessions/2026-01-01.md` 内含 `lastVerified: not-a-date` 和不存在的 `scripts/missing.js`。输出 `healthy`、`evidence: []`、`filesChecked: 1`。
- 本轮 fixture B：`docs/memory/DECISIONS.md` 含日期 `2026-09-25` 与 `2026-01-01` 的两个条目。在相同 `now=2026-09-25T12:00:00Z` 下，新的在前为 `healthy`；仅调换顺序即为 `warning / MEMORY_DURABLE_REVIEW_DUE`。

**五级实现状态**：部分实现。平面文件的若干机械检查已实现；恢复会读取的 sessions 与多条目日期语义未覆盖。

**根因**：以“根目录下一个文件、第一组日期”近似“一个记忆条目”，而恢复契约允许目录内会话及文件内多个条目。

**影响**：审计结果的覆盖范围容易被高估；后续 Agent 恰好会进入未审计的 session 回退路径。这里不要求代码自动识别语义重复/矛盾，也不把人工 Skill 的全部职责硬塞给 scanner。

**最小改进（减法优先）**：先把机械结果限定为其实际扫描范围并显式列出未覆盖 sessions/多条目，不以一个笼统 `healthy` 表示整库健康。若继续保留整库审计承诺，再只补 sessions 安全遍历和条目级日期检查；不新增语义审计 Agent。

**最聚焦回归**：嵌套 session 的无效日期被检查或明确报告不覆盖；相同条目调换顺序不能让过期信息消失。可以扩展现有 `tests/integration/project-audit.test.js:99` 的 fixture，不需要全量 Eval。

### C4 — 内容残缺或未知版本 Anchor 被当作可恢复状态，缺失事实被默认空值吞掉（P1）

**问题 / 触发条件**：某锚点是合法 JSON，但只剩 `taskId` 与 `schemaVersion`，或者来自不支持的未来版本。status 返回 exit 0 / ready，丢失的 goal、stage 等事实被置为 null、空列表。

**证据（当前源码与原文）**：

- `runtime/commands/run.mjs:2586` 自述：`A damaged anchor is rejected, never silently rebuilt.`
- `runtime/commands/run.mjs:2588` 声明 `TASK_SCHEMA_VERSION = 2`。
- `runtime/commands/run.mjs:2995`–`:2997` 只拒绝非对象、taskId 不匹配或 `!Number.isInteger(anchor.schemaVersion)`；未检查支持版本或任务核心字段。
- `runtime/commands/run.mjs:3801` 固定 `status: 'ready'`；`:3803`–`:3815` 把缺失字段转换为 null 或空列表。
- `runtime/commands/run.mjs:2894`–`:2902` 无 planFile 时返回 `status: 'passed', managed: false, plan: null`，因此缺少计划关联也不会提示锚点不完整。
- 本轮分别写入 synthetic `{"schemaVersion":2,"taskId":"partial"}` 与 version 999。两个 status 都返回 `exitCode:0, status:"ready", goal:null, stage:null, planStatus:"passed"`。

**五级实现状态**：部分实现。JSON 语法损坏可拒绝；语义残缺与不支持版本缺少恢复校验。

**根因**：“可解析为 JSON 且身份匹配”被等同为“可消费的状态锚点”，消费端又使用宽松默认值抹平了未知与真正为空的差别。

**影响**：新会话无法区分“没有阻塞/没有单元”和“这些内容已丢失”；只能重新调查。不能据本轮推断故障怎样产生，也没有把存储原子性或并发丢写归入本域。

**最小改进（减法优先）**：在现有 `readTaskAnchor` 收紧支持版本与最小恢复字段，统一把残缺状态报告为不可完整恢复。不要让每个 status 消费方分别发明默认值，也无需新增一套恢复文件。

**最聚焦回归**：保留现有合法锚点兼容测试，加入 version 2 缺 goal/stage/集合字段、未知版本、非法 unit 状态等反例；明确拒绝或返回带缺口的 degraded 语义，不要返回无提示 ready。

## 关键机制五问

| 机制 | 解决什么 | 删除后的后果 | 更简单替代 | Agent 能稳定理解执行吗 | 能自动验证吗 |
|---|---|---|---|---|---|
| 渐进读取与 `context` 摘要 | 避免每次恢复加载全仓规则/记忆；先找当前任务事实 | 全删会回到无界搜索；删重复说明不影响摘要能力 | 保留一个启动入口和按需路径；复用已返回源码，不叠加多个索引查询 | 指令可读；真实长期遵循率本轮无法确认 | 摘要范围可确定性测试；“是否重复读”需真实 trace |
| 长任务 Anchor | 跨压缩保存目标、进度、决策、阻塞和下一步 | 长任务依赖对话摘要或手工交付，恢复成本上升 | 短任务不建；长任务保留一个小锚点，不并行维护第二份状态清单 | 基本 CLI 用例本轮通过；C1/C2/C4 会误导或阻断恢复 | 是，现有聚焦测试加上述反例即可 |
| Plan digest / `plan-sync` 与 Anchor | 检测已绑定计划变化，防止恢复时采用不一致计划 | 失去显式漂移提示；但记录事实本身不应依赖门通过 | digest 仍保留；只把门用在需要冻结计划的动作，不拦 checkpoint | 正常路径清楚；异常时先 sync 才能记 blocker 的顺序不稳健 | 是，C2 是隔离可复现；dispatch 边界由工作流域负责 |
| `verify --reuse` 恢复关联 | 避免同一工作树/命令集重复执行已有验证 | 正确性不必然下降，但恢复成本增大 | 无匹配就正常执行；保留一个收据引用来源，不复制报告全文 | 命令接口直接；本轮只确认关联源码，不判定信任链 | 现有命中/漂移用例存在，本轮未扩展到验证域 |
| CURRENT + Session + Agentmemory Handoff | 跨会话找回长期事实和最后工作点 | 没有可定位历史；仅 Git 难以解释未提交工作与决定原因 | CURRENT 只保留指针与最小下一步，复用 Anchor/当前 Git，不复制治理正文 | 文本已规定目录边界、祖先校验和事实优先；外部 MCP/HTTP 与真实会话行为无法确认 | 本地格式/引用能测；MCP/HTTP、恢复选择及真实压缩需宿主场景 |
| Memory 审计 | 暴露日期/引用等明显过期信息 | 需要人逐项核查；不是执行正确性的唯一防线 | 输出窄范围机械检查，别以一个日期代理全部条目 | 当前 `healthy` 容易被过读，见 C3 | 是，sessions 与条目重排均是小 fixture |
| CodeGraph / codebase-memory / ast-grep | 低成本定位符号、关系、影响面 | 可用源码搜索替代，调用图定位成本可能上升 | 同一问题选一个可用工具；索引不可用就回到源码，不重新安装整套工具 | 规则已强调同一事实不反复核验、索引不代替行为；本轮工具可返回源码 | wrapper/HEAD 比较可测；索引内容、宿主加载、worktree 共享须真实工具证据 |

索引方面的可保留设计：`docs/rules/codegraph.md:15` 不要求每次查询重查状态，`:19` 禁止多工具重复证明同一事实，`:23` 采用 Base Index + Git Diff；`docs/rules/codebase-memory-mcp.md:32` 规定不可用时回退；这些直接符合最低必要成本。`runtime/tools/codebase-memory-mcp/index-state.mjs:95` 的 `fresh` 仅依据 `head-sha-match`，因此不能从它额外推导未提交修改已覆盖；规则 `docs/rules/codebase-memory-mcp.md:10` 已给出 worktree 未提交内容的补查边界。本轮未把外部索引未部署当作产品故障，也未自行重建索引。

## 本轮验证与剩余未知

### 已执行

1. 聚焦现有测试：

   ```powershell
   node --test --test-name-pattern='task init 在|task update 记录阶段|重复执行相同的 task update|task update 登记失败|task status 与 list|受管计划绑定|memory audit detects|empty current memory' tests/integration/project-task-command.test.js tests/integration/project-audit.test.js
   ```

   结果：8 tests / 8 pass / 0 fail；只证明所选正常路径/既有边界，本报告反例不是现有测试已覆盖的结论。

2. 两次 `node --input-type=module` 隔离诊断：直接导入 `runCommand` 与 `auditMemory`，在 `audit-reports/.context-fixture-*` 新建 synthetic 项目，执行各问题所列输入并用 `assert` 确认观察结果。第一轮复现 C1/C2/C3/C4；第二轮分别验证 schemaVersion 2 与 999，并验证两个条目重排。两个命令均 exit 0。
   - 这些是本轮缺陷诊断观察，**不是已登记 Micro check，也不作为产品完成/发布 passed 收据**。
   - fixture 只含 synthetic task / plan / memory；未读取真实 Memory body。
   - finally 核对临时目录在 `audit-reports` 内后删除，没有留下 fixture 或新测试文件。

3. 写报告后执行 `git diff --no-index --check -- /dev/null audit-reports/2026-09-25-phase1-context.md` 与 `git diff --check`，均无输出；产品跟踪文件无修改。本 Agent 只新增报告，fixture 已删除。

### 无法确认，不计正式问题

- H12 真正宿主压缩后能否保留约束、H13 恢复前是否重查当前 HEAD/文件、H14 接收 Agent 是否收到全部关键事实。本轮只有场景定义，不进行联网/真实宿主长任务。
- Agentmemory MCP / HTTP 服务可用性、会话检索质量与真实外部持久化效果。
- codebase-memory 原生索引内容、未提交变更覆盖与 watcher/worktree 长期稳定性；本项目当前该 runtime 未安装。
- 真实记忆是否已陈旧、矛盾或含敏感内容：按授权只使用元数据，完全未读取正文。
- Anchor 并发写入与故障一致性、复用收据信任链分别交给可靠性域、验证域，本文不做通过主张。

## 最小收敛顺序

1. 先修复 C2/C4：让异常状态能保存、残缺恢复输入能被准确识别。
2. 再处理 C1/C3：收紧无效参数和审计覆盖主张，减少“成功/健康”与实际含义不一致。
3. 保留已具备明确降级路径的轻量上下文与索引机制；不要以本次审查为由新增规则、恢复层、Memory 副本、Agent 角色或默认全量验证。
