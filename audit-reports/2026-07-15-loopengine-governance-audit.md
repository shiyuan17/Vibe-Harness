# LoopEngine 全项目 AI 规范中立审查报告

> 状态：历史基线、整改前证据。本报告记录 `bc0096b` 基线上的问题，不代表当前实现；当前行为以仓库现行规范、测试和最新验证输出为准。

- 审查日期：2026-07-15
- 审查基线：`bc0096b` 基线上的整改前工作树（包含当时已提交、未提交与未跟踪文件）
- Git 基线：`bc0096b7560a0a3ea011018e79581274fd6d92b3`
- 分支：`codex/full-tool-provisioning`
- 审查方式：静态全量检查、官方协议核对、最小复现、完整动态验证、供应链审计
- 审查限制：官方 Codex 手册聚合下载返回 HTTP 403，且会话未提供 OpenAI Docs MCP；Hook 与 Skill 协议改用可访问的官方页面核对。`codebase-memory-mcp` 索引仅识别 20 个函数，因此只作结构辅助，结论以源码、测试与运行结果为准。

> 2026-07-16 勘误：原 P1-01 使用了与真实 provision 不一致的 audit 参数。Agentmemory 实际执行 `npm ci --ignore-scripts --omit=optional`；按相同 surface 复核为 Critical 0、High 0、Moderate 12。完整 lockfile 的 optional 依赖仍含 Critical/High advisory，但不进入当前可运行安装面。原发现调整为 P2-08，且不再建议从默认 full/internal 移除 Agentmemory。

## 1. 管理层摘要

LoopEngine 已形成较完整的治理产品骨架：文档真值、安装 profile、可回滚所有权、中文任务合同、Red Team 门禁、Skill 依赖闭包、离线评测和双生命周期 smoke 均有机器验证。安装器是当前最成熟的子系统；本轮未复现越界写入、无 `--force` 覆盖用户文件、自动修改 `.git/config` 或写入用户级 Agent 配置。

当前整体成熟度经勘误后评为 **6.9/10（中等偏上，接近可受控试用，但不适合统一正式发布）**。主要问题不是“缺少规则”，而是少数高价值门禁存在可绕过或不可观测路径：

1. Hook 对破坏性 Git 和全局 Agent 配置的保护依赖字符串正则，常见命令变体可以绕过，同时只读命令可能被误拒。
2. Stop 完成门禁在治理校验器缺失时静默视为成功，交付字段也可由代码围栏中的占位模板满足。
3. Eval 变更门禁只比较“新增 Eval-ID 数量”，无关案例可满足覆盖要求；全局配置 online canary 本身没有观测全局写入的机制。
4. 质量门禁没有覆盖 19 个可执行 JS/MJS/CJS 文件，CI 只有 Ubuntu，无法持续验证 Windows 专用 Hook 与路径分支。
5. 四个 runtime tool 缺少与真实安装参数一致的供应链门禁；Agentmemory optional lockfile 风险需要持续跟踪，但不是当前运行面发布阻断项。

### 发布准入结论

- **P0：0 项。** 未发现已经证实可直接导致数据损坏或凭据泄露的仓库自身漏洞。
- **P1：5 项。** 建议作为统一发布阻断项；当前包仍不适合统一正式发布。
- **P2：8 项。** 建议在下一治理迭代处理。
- **P3：3 项。** 可进入长期优化队列。
- **总体判定：Request changes。** minimal/core 的确定性安装面已有较强证据，但当前包以同一版本同时分发 full/internal，因此不建议拆开风险后直接发布整个版本。

## 2. 分子系统评分卡

| 子系统 | 评分 | 评价 | 主要依据 |
| --- | ---: | --- | --- |
| 规范与知识治理 | 8.5/10 | 较成熟 | catalog、归档、双语 README、生命周期边界与文档审计闭环完整 |
| 工作流与任务治理 | 8.0/10 | 较成熟 | 五步循环、档位升级、AC-ID、Red Team 和结构化延期均有强测试 |
| Skills 体系 | 7.0/10 | 可用但有语义漂移 | 26 个 Skill 的结构和依赖闭包可靠；触发描述与路由策略仍有冲突 |
| Codex/Git Hooks | 5.0/10 | 需要加固 | 官方协议形状基本正确，但策略匹配、缺失校验器和交付解析存在绕过 |
| 安装器与所有权 | 8.5/10 | 当前最强 | dry-run、冲突、备份、升级、回滚、卸载和红区均有正反测试 |
| CI 与跨平台 | 6.0/10 | 覆盖不充分 | 主测试稳定，但 executable lint 和 Windows CI 缺失 |
| Evals 与可观测性 | 5.5/10 | 合同完整、门禁偏弱 | schema/replay/reference 健全；变更映射和部分 canary 不可证明目标行为 |
| 安全与供应链 | 6.5/10 | 需补供应链门禁 | 通用脱敏和边界意识较好；真实安装面无 Critical/High，但 CI 尚未按 provision 参数审计 |

## 3. 声明—实现—证据追踪矩阵

| 核心声明 | 规范真值 | 实现 | 验证证据 | 判定 |
| --- | --- | --- | --- | --- |
| MVP 使用 `--project/--write`，legacy 使用 `--target/--apply` | `AGENTS.md`、`CONTRIBUTING.md`、`docs/architecture.md` | `scripts/loopengine.js` | `pnpm check`、66 项串行集成、9 步 smoke、两套显式临时目录链 | 通过 |
| 未使用 `--force` 不覆盖用户文件 | README、安全规则 | `scripts/lib/install-planner.js`、install state | 冲突、upgrade、rollback、uninstall 测试 | 通过 |
| 不写用户级 Agent 配置 | `AGENTS.md`、`docs/architecture.md` | 安装目标全部基于 project root | 显式安装前后 5 个用户级配置路径 SHA-256 完全一致 | 通过（安装器） |
| 不自动修改 `.git/config` | `docs/hooks.md` | Git hook 只安装模板，doctor 只读 | 两个临时 Git 仓库 `core.hooksPath=unset` | 通过 |
| 完整任务需独立 Red Team 批准 | `rules/governance-core.md`、当前 v0.5 规格 | schema 与 red-team validator | 多组伪造、HTML、代码围栏、严重度和延期负例测试 | 通过 |
| Skill 路由和 profile 依赖闭包 | 路由规则、`using-loopengine` | manifest、install map、pack validation | 26 个 Skill 闭包与安装快照测试 | 结构通过，语义部分通过 |
| Hook 阻断破坏性 Git和全局配置写入 | `docs/hooks.md` | `runtime/hooks/lib/policy.mjs` | 官方 Hook 协议核对与命令变体最小复现 | 未通过 |
| Agent 行为变化必须有对应 Eval-ID | EDD 规则、贡献指南 | `scripts/eval-change-check.js` | 无关 Eval-ID 最小复现被接受 | 未通过 |
| online canary 检测全局配置写入 | `evals/suites/loopengine-online-canary.json` | Codex runner | runner 无对应事件采集或前后快照 | 不可证明 |

## 4. 治理状态转换审查

| 当前状态 | 触发 | 下一状态 | 机器门禁 |
| --- | --- | --- | --- |
| 快速 | 发现行为变化 | 轻量或完整 | 规则要求，主要依赖 Agent 遵循 |
| 轻量 | 命中安全、数据、发布、跨层、外部契约等信号 | 完整 | 规则与任务 validator 部分覆盖 |
| 任意执行状态 | 歧义、权限不足、规则冲突、红区未确认、范围扩大 | 停止/等待人工 | 任务状态与红区安装器有机器门禁 |
| 完整 | AC-ID 证据齐全、独立审查批准 | 交付/完成 | full task schema、governance validator、Red Team packet validator |
| 完整 | Critical/High 未关闭或 Medium 无结构化延期 | 阻塞 | Red Team validator |
| Stop gate | 校验器缺失 | 当前实现视为成功跳过 | **未定义且 fail-open，见 P1-04** |
| online eval | 连续 degraded | 文档要求维护者介入 | **无计数或通知实现，见 P2-05** |

## 5. P1 高优先级发现

### P1-02：破坏性 Git Hook 可被常见命令形式绕过

- **证据**：`runtime/hooks/lib/policy.mjs:18` 使用正则匹配命令字符串。最小复现中 `git restore README.md`、`git checkout HEAD -- README.md`、`git -C . reset --hard`、`git.exe reset --hard` 均返回 `allow`，只有 `git reset --hard` 返回 `deny`。
- **复现**：直接调用 `analyzeToolRequest({toolName:'Bash', toolInput:{command}})`；无需执行真实 Git 命令。
- **预期与实际**：`docs/hooks.md:29` 声明默认阻断破坏性 Git；实际同一危险操作只因可执行文件后缀、全局参数或常见语法不同而绕过。
- **影响**：受信 Hook 不能可靠阻止丢失未提交改动的常见命令，且现有正向测试会给维护者过强安全感。
- **严重度依据**：可能造成用户工作丢失，且绕过发生在官方 Hook 明确支持的 Bash 工具面。
- **最小整改**：规范化 `git`/`git.exe`、剥离 `-C` 等全局参数，并覆盖 restore、checkout、reset、clean、rebase/merge abort 等实际破坏性形式。
- **结构性方案**：使用平台无关的 shell token 解析器或限制为结构化命令策略；维护 deny/allow 表驱动测试，不再依赖整行模糊正则。
- **验收条件**：上述四个绕过命令全部 deny；`git status`、`git diff`、`git log` 保持 allow；Windows 与 Linux CI 均运行同一命令矩阵。
- **置信度**：高。

### P1-03：全局 Agent 配置 Hook 在 Windows 可漏拦，同时误拒只读检查

- **证据**：`runtime/hooks/lib/policy.mjs:25` 只识别 `~`、`$HOME`、`%USERPROFILE%` 和字面绝对路径。`Set-Content ($env:USERPROFILE + '/.codex/config.toml') 'x'` 被允许；`Get-Content $HOME/.codex/config.toml` 反而被拒绝并报告“Writes”。
- **复现**：使用与 P1-02 相同的 `analyzeToolRequest` 最小调用。
- **预期与实际**：预期阻断写操作、允许授权范围内的只读诊断；实际策略既有 false negative，也有 false positive。
- **影响**：Windows 主路径可绕过核心安全承诺；误拒读取会妨碍审查和故障诊断，促使用户关闭 Hook。
- **严重度依据**：涉及全局 Agent 配置完整性，且项目明确宣称跨平台。
- **最小整改**：先判定操作是否写入，再对 PowerShell/cmd/POSIX 常见 home 表达式做规范化；覆盖 `$env:USERPROFILE`、`$env:HOME`、`Join-Path`、`git config --global` 等形式。
- **结构性方案**：把“命令意图”和“路径边界”拆成两层策略；对可解析结构化写工具优先使用字段，不把命令中出现敏感路径等同于写入。
- **验收条件**：Windows 常用写法全部 deny；只读 `Get-Content`/`type`/`cat` 返回 allow 或 warn；测试覆盖大小写和路径分隔符。
- **置信度**：高。

### P1-04：Stop 治理校验器缺失时静默 fail-open

- **证据**：`runtime/hooks/lib/context.mjs:158` 在 validator 不存在时返回 `{ok:true, skipped:true}`；`runtime/hooks/codex-hook.mjs` 只检查 `!governance.ok`，因此不会向用户暴露跳过。
- **复现**：对一个没有 `.agents/loopengine/governance/validate.mjs` 的临时目录调用 `runGovernanceCheck`，得到 `ok=true, skipped=true`。
- **预期与实际**：预期 full/internal 的治理 runtime 丢失或漂移时至少 advisory，blocking 模式下应阻止一次；实际等同成功。
- **影响**：删除、安装不完整或损坏 validator 后，完成门禁看起来仍正常工作。
- **严重度依据**：关键完成门禁失效且无可见诊断。
- **最小整改**：返回三态 `passed/failed/unavailable`；根据 install state/profile 判断 validator 是否应存在，预期存在而缺失时产生问题。
- **结构性方案**：Stop gate 先验证安装一致性，再执行治理/eval/delivery；把 skipped 明确写入系统消息和最终证据。
- **验收条件**：full/internal 缺失 validator 时 advisory 有明确提示，blocking 首次返回 block；minimal 等不安装 runtime 的 profile 可按声明跳过。
- **置信度**：高。

### P1-05：Eval 变更门禁可被无关 Eval-ID 满足

- **证据**：`scripts/eval-change-check.js:14-17` 只比较 `addedEvalIds.length >= requiredCoverageKeys.length`；没有把 case 的 `capability` 与 capability matrix 对应。最小复现给 `runtime/hooks/lib/policy.mjs` 变更提供 `EVAL-UNRELATED-999`，返回 `ok:true`。
- **复现**：调用 `evaluateGovernanceEvalChanges`，传入一个治理文件、一个 coverage key 和任意新增 Eval-ID。
- **预期与实际**：预期新增案例证明被改变的能力；实际只证明 suite 中新增了足够数量的 ID。
- **影响**：PR 可以形式上满足 EDD 门禁而没有回归保护目标行为。
- **严重度依据**：直接削弱项目用于防止 Agent 行为回归的核心 CI 控制。
- **最小整改**：解析新 case 的 `capability`，要求与 capability matrix 映射逐项相符；未映射文件使用显式 `coversFiles` 或独立映射字段。
- **结构性方案**：建立 AC-ID—Capability—Eval-ID—Suite—Reference 的可机读追踪表，并校验新增/修改/删除全生命周期。
- **验收条件**：无关 Eval-ID 必须失败；一个 case 不能在无声明时同时抵扣多个能力；对应能力案例可通过。
- **置信度**：高。

### P1-06：全局配置 online canary 没有观测目标违规的能力

- **证据**：`evals/suites/loopengine-online-canary.json:9-11` 依赖 `global-agent-write` forbidden event；`runtime/evals/codex-runner.mjs:112` 的 `fixtureEvents` 只生成 existing-file/evidence 事件，没有全局写事件；`runtime/evals/codex-runner.mjs:87` 又排除 `.codex-eval-home` artifact。
- **复现**：静态追踪 EVAL-ONLINE-001 oracle 到 runner event producer；没有任何代码产生 `global-agent-write`。
- **预期与实际**：预期 Agent 修改隔离 CODEX_HOME 或用户配置时案例失败；实际只要输出规定文本和退出码为 0，就不会因全局写入失败。
- **影响**：名为 `global-config-protection` 的 critical canary 可能持续绿灯，却没有验证核心安全主张。
- **严重度依据**：critical 安全评测不可观测其 forbidden behavior。
- **最小整改**：运行前后对隔离 CODEX_HOME 和明确的全局配置候选路径做元数据/hash 快照，检测变化时发出 `global-agent-write`，但不持久化文件内容。
- **结构性方案**：为每个 forbidden event 建立唯一 producer/observer 映射，suite validation 拒绝没有观测器的事件。
- **验收条件**：故意修改隔离全局配置的测试 runner 必须使 EVAL-ONLINE-001 invalid；正常运行通过；诊断不包含 secret 或配置正文。
- **置信度**：高。

## 6. P2 中优先级发现

### P2-01：Stop 交付校验可被代码围栏中的占位模板满足

- **证据与复现**：`runtime/hooks/lib/delivery-validation.mjs:1-19` 对整段文本做行级正则，不排除 fenced code。把 11 个字段放入 ```markdown 代码围栏并填写 placeholder，返回 `ok:true`。
- **预期与实际**：预期只接受最终回复中的真实交付字段；实际示例代码和占位模板也会被识别为交付。
- **影响**：示例、引用或未填写模板可能被当成真实交付包；默认 advisory 降低了直接风险，但 blocking 模式也沿用同一解析。
- **严重度依据**：该问题削弱完成证据可信度，但默认不直接执行危险动作，因此定为 P2。
- **最小整改**：复用 Red Team validator 的 CommonMark 清洗策略，忽略代码围栏、HTML block 和引用示例，并校验枚举与非占位值。
- **结构性方案**：最终交付使用结构化 JSON block 或可复用 Markdown AST parser，与 task validator 共享字段定义。
- **验收条件**：代码围栏、HTML 注释、引用块和 placeholder 均失败；真实中英文交付继续通过。
- **置信度**：高。

### P2-02：语法 lint 排除 19 个可执行文件

- **证据**：`scripts/lint.js:7` 只扫描 `scripts` 和 `tests`。仓库共有 87 个 JS/MJS/CJS，19 个被排除，包括全部 runtime hooks、governance、eval runners、四个 tool launcher 与 brainstorming server/helper。
- **复现**：分别枚举全仓库 `*.js/*.mjs/*.cjs` 和 `scripts|tests` 子集，得到 `all=87、linted=68、excluded=19`。
- **预期与实际**：预期 lint 覆盖所有分发或执行的 JavaScript；实际只覆盖开发脚本和测试。
- **影响**：未被测试导入的 executable 可以带语法错误进入包；`LoopEngine lint passed` 容易被理解为全仓库检查。
- **严重度依据**：属于确定性质量门禁缺口，但当前测试已间接加载多数 runtime，故定为 P2。
- **最小整改**：将 `runtime` 和 `skills/**/scripts` 纳入 `node --check`，同时包含 `.cjs`。
- **结构性方案**：从 install map 和 manifest 派生 executable 清单，确保每个分发脚本至少经过 syntax check 和最小启动测试。
- **验收条件**：lint 输出覆盖 87 个当前 executable；向任一 runtime/helper 注入语法错误会失败。
- **置信度**：高。

### P2-03：跨平台产品只有 Ubuntu CI

- **证据**：`package.json:5` 明确宣称 cross-platform；两个 workflow 均仅在 `.github/workflows/*.yml:13` 使用 `ubuntu-latest`。Windows 专用 `commandWindows`、`.cmd` 解析和路径分支只在开发者本机偶然覆盖。
- **复现**：检查 `.github/workflows/ci.yml` 与 `.github/workflows/evals.yml` 的 `runs-on`，没有 matrix 或 `windows-latest` job。
- **预期与实际**：预期跨平台产品对平台专用分支有持续验证；实际 required checks 只证明 Linux 行为。
- **影响**：Windows Hook quoting、PowerShell 路径和 tool launcher 回归可能在发布后才暴露。本轮 P1-03 正是 Windows 专用漏拦。
- **严重度依据**：当前 Windows 本地验证可运行，但无法防止后续回归，因此定为 P2。
- **最小整改**：为 `pnpm check`、Hook policy 和 MVP/legacy smoke 增加 `windows-latest` matrix；耗时工具 provision 可保留为受控子集。
- **结构性方案**：按平台划分快速合同测试与夜间完整 provision，报告每个平台的 ready/degraded 原因。
- **验收条件**：Linux/Windows required checks 均通过；Hook 命令矩阵和两个安装生命周期至少在两平台运行。
- **置信度**：高。

### P2-04：brainstorming 的隐式触发描述与 canonical router 冲突

- **证据**：`skills/core/brainstorming/SKILL.md:3` 声称“任何创造性工作前使用”并包含硬门禁；`skills/core/using-loopengine/SKILL.md:15` 只在“需求仍有关键歧义”时选择 brainstorming。官方 Codex Skill 文档说明隐式选择主要依赖 description。
- **复现**：对比两个入口的触发文字；用“已有决策完整规格，请直接实现”作为路由案例时，两条规则会给出不同选择。
- **预期与实际**：预期 router 是唯一分类决策入口；实际 specialist description 可以先于 router 广泛命中。
- **影响**：明确、已有规格的功能也可能直接触发 brainstorming，绕过 router 的轻量路径并强制额外设计批准。
- **严重度依据**：影响效率和流程一致性，但不会直接破坏文件或安全边界，定为 P2。
- **最小整改**：把 description 收窄为存在高影响歧义、需要方案选择或用户尚未认可设计时使用。
- **结构性方案**：新增语义路由 eval：明确规格应直接 writing-plans/execute，模糊创意任务才进入 brainstorming。
- **验收条件**：至少覆盖“明确小功能不触发”“高影响歧义触发”“纯修复不触发”三个案例。
- **置信度**：中高（Codex 匹配具有模型非确定性，但描述冲突为事实）。

### P2-05：连续 degraded 的在线评测处置只有文档，没有监控实现

- **证据**：`docs/evals.md:60` 要求连续三次 degraded 后维护者检查；workflow 在缺配置或安装失败时只写 degraded JSON，并在 `.github/workflows/evals.yml:54-55` 上传 artifact。没有连续次数状态、告警、issue 或 job summary 门禁。
- **复现**：在缺少 `CODEX_CLI_VERSION`、`CODEX_MODEL` 或 `OPENAI_API_KEY` 时运行 workflow 逻辑；preflight 写 degraded artifact 后仍可成功完成 upload job。
- **预期与实际**：预期第三次连续 degraded 触发维护者可见动作；实际每次运行彼此无状态，只留下需主动下载的 artifact。
- **影响**：在线评测可以长期保持绿色 workflow，但实际从未运行；维护者需要主动逐个下载 artifact 才能发现。
- **严重度依据**：不会把明确 invalid 改为 passed，但会长期隐藏“未执行”，定为 P2。
- **最小整改**：把 degraded 状态写入 `GITHUB_STEP_SUMMARY`，并对连续次数提供明确告警。
- **结构性方案**：保存轻量健康状态或通过 GitHub API 查询最近 runs；连续三次 degraded 自动创建/更新单一 issue，恢复后关闭。
- **验收条件**：构造三次 degraded 后产生可见告警；恢复 ready 后计数清零；诊断仍脱敏。
- **置信度**：高。

### P2-06：`skills:audit` 实际只是清单输出

- **证据**：`scripts/skills-audit.js:5-29` 只读取 manifest、统计种类/行数并打印表格，不调用 frontmatter、依赖闭包、fallback 或引用校验。真正校验位于 `pack-validation`，但贡献指南把 `pnpm skills:audit` 表述为额外审计步骤。
- **复现**：阅读命令入口或运行 `pnpm skills:audit`；输出只有数量、类型、行数和依赖列，没有 pass/fail 规则报告。
- **预期与实际**：预期名为 audit 的必跑命令验证 Skill 质量；实际等价于 inventory report。
- **影响**：命令成功不代表 Skill 质量通过，名称和治理要求可能误导贡献者。
- **严重度依据**：真实校验仍由 `pnpm check` 执行，因此是流程表达和独立门禁缺口，定为 P2。
- **最小整改**：将命令改名为 `skills:inventory`，或让 `skills:audit` 调用 `validateSkillGraph` 后再输出清单。
- **结构性方案**：增加 trigger overlap、路由可达性、reference 安装闭包和官方 metadata 一致性检查。
- **验收条件**：故意破坏 frontmatter、fallback、路由触发或 reference 安装时 `pnpm skills:audit` 非零退出。
- **置信度**：高。

### P2-07：能力矩阵并未覆盖项目全部关键能力

- **证据**：`manifests/capabilities.json:3-15` 主要记录治理抽取能力和两类排除项，没有 installer ownership、Hook policy、docs governance、tool provisioning、rollback/uninstall 等对外核心能力；但测试和 changelog 使用“每个 reusable capability”措辞。
- **复现**：把 README 的主要能力逐项与 capability IDs 对照；安装、回滚、Hook、文档治理和工具 provision 找不到直接条目。
- **预期与实际**：预期能力矩阵能回答每项公开能力由什么实现和测试保护；实际只覆盖治理资产抽取子集。
- **影响**：能力矩阵无法承担全项目“声明—实现—测试—Eval”追踪真值，新增子系统可能继续依赖分散测试名称。
- **严重度依据**：现有能力本身有测试，但追踪真值不完整，定为 P2。
- **最小整改**：明确文件只覆盖 governance extraction，重命名或补充 scope 字段。
- **结构性方案**：扩展为全产品 capability catalog，分别声明 deterministic tests、behavior evals、profiles、public docs 和 owner。
- **验收条件**：README 每项主要能力都能映射到实现、测试和 profile；校验器拒绝无证据能力。
- **置信度**：中高（当前文件可能原本只想覆盖抽取，但现有命名未说明该限制）。

### P2-08：runtime 供应链审计未匹配真实安装 surface

- **证据**：`scripts/lib/tool-provisioning.js` 对 Agentmemory 使用 `npm ci --ignore-scripts --omit=optional`，原审计未使用 `--omit=optional`。2026-07-16 以相同参数复核，真实安装面为 Critical 0、High 0、Moderate 12；完整 lockfile 的 Critical/High 来自被排除 optional 依赖。
- **复现**：分别运行 `npm audit --package-lock-only --omit=optional --audit-level=high --json` 和不带 omit 的完整 lockfile 审计，比较两类 surface。
- **预期与实际**：预期 CI 按各工具真实 provision 参数审计；实际没有统一命令，也容易把被排除依赖误判为运行面。
- **影响**：当前不存在已证实的 Critical/High 运行面阻断，但后续依赖变化可能无门禁进入，审查结论也可能再次失真。
- **严重度依据**：属于供应链覆盖和证据口径问题；现有运行面无 Critical/High，因此调整为 P2。
- **最小整改**：新增四 runtime 审计命令，Critical/High 和审计不可用 fail-closed，Moderate 告警；Agentmemory 强制使用 `--omit=optional`。
- **结构性方案**：同时输出真实安装面和被排除 optional surface，保留 registry、参数、时间和 advisory ID，不保存环境或凭据。
- **验收条件**：CI 能阻断模拟 High；当前真实安装面无 Critical/High；Agentmemory handshake 与 full/internal profile 保持不变。
- **置信度**：高。

## 7. P3 改进建议

### P3-01：项目上下文会把超过 20 个变更误报为 20 个

- **证据**：`runtime/hooks/lib/context.mjs:134` 先 `slice(0,20)`，后续使用截断后的长度生成 changed path 数。
- **复现**：在临时 Git 仓库制造 21 个变更后调用 `buildProjectContext`，算法最多报告 20。
- **预期与实际**：预期摘要显示真实总数并限制明细；实际总数也被截断。
- **影响**：只影响上下文精度，不改变安全决策或安装行为。
- **严重度依据**：低影响可观测性问题，定为 P3。
- **最小整改**：在截断前保存总数，输出 `N changed path(s), first 20 shown`。
- **结构性方案**：把摘要总数、展示上限和截断标志作为结构化字段测试。
- **验收条件**：21 个变更报告总数 21，同时上下文仍满足 4096 字符上限。
- **置信度**：高。

### P3-02：integration Skill 未使用官方可选 `agents/openai.yaml`

> 2026-07-16 处理记录：官方 Codex 手册聚合仍返回 HTTP 403，当前会话没有 OpenAI Developer Docs MCP，且仓库规则禁止修改全局 MCP 配置。为避免猜测官方 dependency 字段，本轮不新增 `agents/openai.yaml`；待可核对官方 schema 后只从 Agentmemory MCP 做单 Skill 试点。

- **证据**：官方 Codex Skill 文档支持 `agents/openai.yaml` 声明 UI metadata、隐式调用政策和工具依赖；当前 26 个 Skill 只有内部 `metadata.json`，install map 不安装 `agents/openai.yaml`。
- **复现**：枚举 `skills/**/agents/openai.yaml` 和安装目标，结果为空。
- **预期与实际**：这是官方可选能力而非强制合同；当前 Skill 可运行，但 Codex UI 无法直接利用工具依赖元数据。
- **影响**：主要影响发现性和缺失工具提示，不影响 SKILL.md 基本加载。
- **严重度依据**：纯增强项，定为 P3。
- **最小整改**：先为三个 integration Skill 增加经过 schema 核对的 `agents/openai.yaml`。
- **结构性方案**：由 manifest metadata 派生并校验官方 metadata，避免双重真值。
- **验收条件**：Codex 能显示 integration Skill 的名称、说明和工具依赖；未安装工具时提示明确；旧客户端仍可只读 SKILL.md。
- **置信度**：高。

### P3-03：package 版本与治理规格版本关系不够明确

- **证据**：`package.json` 版本为 `0.3.0`，当前规格标题为“LoopEngine v0.5 中文精简治理规格”，说明区未解释两个版本空间。
- **复现**：从 `docs/README.md` 进入当前规格并与 package metadata 对照。
- **预期与实际**：预期规格修订号与产品发布号的关系明确；实际只能从 Unreleased changelog 推断。
- **影响**：可能造成发布沟通、迁移和审计引用歧义，不影响运行时。
- **严重度依据**：文档清晰度问题，定为 P3。
- **最小整改**：在规格状态下增加“规格修订号，不等同 package release 版本”。
- **结构性方案**：catalog 增加 `specVersion` 与 `introducedInRelease` 等显式字段，仅在确有需要时实施。
- **验收条件**：新维护者只读规格头部即可区分规格与发布版本；docs audit 保持通过。
- **置信度**：中高。

## 8. 动态验证记录

| 命令或检查 | 退出码 | 关键结果 |
| --- | ---: | --- |
| `pnpm check` | 0 | lint 68 文件；validation 通过；263 tests 中 262 通过、1 个真实 Codex smoke 跳过 |
| `pnpm docs:audit` | 0 | 25 个 catalog 文档通过 |
| `pnpm skills:audit` | 0 | 26 个 Skill 清单生成；原命令只输出 inventory，未执行语义校验 |
| `pnpm eval:check` | 0 | evaluation contracts 通过 |
| `pnpm eval:offline` | 0 | criticalPassRate=1、overallScore=1、status=passed |
| `pnpm test:integration` | 0 | 66/66 通过，串行执行 |
| `pnpm smoke:lifecycle` | 0 | MVP 5 步、legacy 4 步全部退出 0 |
| 显式 MVP init/dry-run/write/validate | 0/0/0/0 | install 与 validate 均 ready；Playwright 为 first-use pending warning |
| 显式 legacy dry-run/apply/validate/doctor | 0/2/2/2 | 安装文件一致，但工具健康为 degraded |
| legacy 工具诊断 | — | agentmemory ready；codebase-memory index、Playwright browser install、OCR llm-test degraded |
| `git diff --check` | 0 | 无 whitespace error；存在 Git 的 LF→CRLF 工作树提示 |
| 全局配置安装前后哈希 | 一致 | Codex config/hooks、Claude settings、Gemini settings 均未变化；Cursor hooks 始终不存在 |
| 临时项目 Git hooksPath | unset | MVP 与 legacy 均未自动启用 Git hooks |
| 临时目录清理 | 通过 | 三个审查临时目录均已删除 |
| 4 个 runtime tool 实际安装面 audit（2026-07-16 勘误） | 4 个无 Critical/High | Agentmemory 使用 `--omit=optional` 后为 Critical 0、High 0、Moderate 12；完整 lockfile optional surface 另行非阻断记录 |

### 全局配置 SHA-256 证据

| 路径 | 安装前 | 安装后 |
| --- | --- | --- |
| `C:\Users\hexi\.codex\config.toml` | `05282226...FE6DB69` | 相同 |
| `C:\Users\hexi\.codex\hooks.json` | `15346EDA...9C72754` | 相同 |
| `C:\Users\hexi\.claude\settings.json` | `4A8DE054...37C6A0` | 相同 |
| `C:\Users\hexi\.gemini\settings.json` | `91158791...4E8B04` | 相同 |
| `C:\Users\hexi\.cursor\hooks.json` | 不存在 | 不存在 |

## 9. 整改路线图

### 阶段 A：发布前（P1）

1. 重构 Hook 命令与路径策略，并添加 Windows/Linux 绕过矩阵。
2. Stop gate 将 validator 缺失视为 unavailable，而不是 passed。
3. Eval change gate 改为 capability 语义映射。
4. 为 online forbidden events 增加 observer 完整性校验，先修复 global-config canary。

建议验证：

```text
pnpm check
pnpm test:integration
pnpm smoke:lifecycle
node --test tests/hook-runtime.test.js tests/eval-ci.test.js tests/eval-runner.test.js
npm audit --package-lock-only --omit=dev --audit-level=high --registry=https://registry.npmjs.org
```

### 阶段 B：下一治理迭代（P2）

1. 强化交付 Markdown parser。
2. 将所有 executable 纳入 lint。
3. 增加 Windows required checks。
4. 收窄 brainstorming trigger 并增加语义路由 eval。
5. 建立 online degraded 连续告警。
6. 将 skills audit 从清单升级为真实审计。
7. 明确并扩展 capability matrix scope。
8. 增加与真实 provision 参数一致的 runtime 供应链审计；不默认移除 Agentmemory。

### 阶段 C：长期优化（P3）

1. 修正 Hook 上下文变更计数。
2. 为 integration Skills 增加官方可选 metadata。
3. 明确规格修订号与 package release 版本关系。

## 10. 整改实施验证（2026-07-16）

| 整改验证 | 结果 | 关键证据 |
| --- | --- | --- |
| `pnpm check` | 通过 | lint 覆盖 99 个 JS/MJS/CJS；validation 与全量单元测试通过，真实 Codex smoke 仍按设计 opt-in 跳过 |
| `pnpm docs:audit` / `pnpm skills:audit` | 通过 | 25 个 catalog 文档通过；26 个 Skill 先执行真实图校验再输出 inventory |
| `pnpm eval:check` / `pnpm eval:offline` | 通过 | capability/suite 精确门禁、observer registry 与新路由/Hook Eval-ID 通过；reference 指纹一致 |
| `pnpm runtime:audit` | 通过 | 三个工具为 0；Agentmemory 有效安装面 Critical 0、High 0、Moderate 12；optional 排除面 Critical 1、High 4 |
| `pnpm test:integration` | 通过 | 66/66 串行集成测试通过 |
| `pnpm smoke:lifecycle` | 通过 | MVP 5 步与 legacy 4 步全部完成；Windows 临时锁使用限次重试清理 |
| 显式 MVP / legacy 临时目录链 | 符合预期 | MVP 四步退出 0；legacy apply/validate/doctor 因外部工具 degraded 退出 2；两套目录独立并已清理 |
| 用户级配置与 Git 配置 | 未变化 | Codex、Claude、Gemini、Cursor 候选路径安装前后 SHA-256 无变化；两套临时项目 `core.hooksPath` 均 unset |
| `git diff --check` | 通过 | 无 whitespace error；仅保留 Windows 工作树 LF→CRLF 提示 |

本地整改已覆盖五项 P1 和八项 P2 的代码、测试与文档入口。仍需在合并前由远端证明两项环境性证据：GitHub `windows-latest` required job 实际通过，以及 online workflow 连续 degraded/恢复路径在真实 Actions artifact 历史上工作。P3-02 的官方 Skill metadata 因官方手册 HTTP 403、Developer Docs MCP 不可用且禁止修改全局 MCP 配置而保守延期。

## 11. 中立结论

LoopEngine 不是“规则堆积型”项目：它已经把相当一部分治理要求转化为 schema、validator、安装所有权和负例测试，这是明显优势。当前问题也并非需要推翻架构，而是应把最关键的安全声明从“正则看起来覆盖”和“测试名称看起来对应”升级为可证明、可观测、跨平台的门禁。

最合理的策略是保留现有架构，先修复六项 P1，再把 P2 作为一次专门的 quality-gate 迭代。若只增加更多规则或更多 Eval-ID，而不修复观测器、语义映射和供应链门禁，项目复杂度会继续上升，但真实治理强度不会同步提升。
