# LoopEngine 全面审查与 AI Coding 治理最佳实践优化报告

> 研究时间：2026-07-16 | 所属领域：AI coding governance | 研究对象类型：开源治理资产与项目内安装器

## 一、执行摘要

LoopEngine 已经越过了“堆一批提示词和规则文件”的早期阶段。它有清晰的项目内安装边界、profile、adapter、manifest、schema、安装状态、回滚、卸载、Hook、Eval、Skill 图校验和跨平台测试。更重要的是，它把“完成必须有证据”“高风险任务需要独立核验”“写入前先预览”“不覆盖用户文件”等要求做成了可执行门禁，而不是只写在文档里。

这使 LoopEngine 在同类 AI coding 规范包中处于较成熟位置。OpenAI、Anthropic、Google、GitHub、Cursor 与 Agent Skills 规范反复强调的几条主线——短而准确的持久指令、按需加载 Skill、先探索再计划、可运行的验证、Hook 作为生命周期扩展、sandbox/permission 作为真正权限边界——LoopEngine 大部分已经覆盖。

但本轮“整改后复审”仍发现五项需要优先处理的工程风险：

1. 安装器使用词法路径包含判断，不能阻止 Windows junction 或 POSIX symlink 把写入导向项目外。本轮在隔离临时目录中复现：`docs` 指向外部目录时，`minimal` 安装成功退出并在项目外写入 6 个文件。
2. 安装写入不是事务式。后续目标写入失败时，前面已经落盘的文件没有 install-state。本轮复现得到 12 个 rules 文件和 `AGENTS.md` 已写入，但 `.loopengine/install-state.json` 不存在，自动 rollback 无入口。
3. Codex Hook 的异常路径是退出码 2 且不输出拒绝 JSON；当前 Codex 官方手册明确说明 Hook run 失败会报告错误并继续工具调用。因此 parser 崩溃、输入超限或内部异常会绕过 guarded/strict 策略。
4. `full` 安装把重型工具下载、浏览器安装和 LLM 健康检查放在安装主链。真实临时项目未设置内部限时时，4 分钟仍未结束，外部终止后子下载进程继续存活并锁住临时目录。设置 10 秒单工具限时后可收敛，但 codebase-memory、Playwright 和 Open Code Review 均为 degraded。
5. 第三方项目内工具进程普遍继承完整 `process.env`。这与 MCP 的 scope minimization、Codex shell environment policy 和“外部输入/工具最小权限”原则不一致；被攻陷或恶意的依赖可以看到与自身任务无关的云凭据、token 和代理配置。

本报告建议不要推翻现有架构，而是把下一阶段目标从“治理内容继续增多”调整为“边界原语统一、安装事务化、原生平台能力下沉、行为 Eval 真实化”。一句话概括：

> LoopEngine 下一步不是增加更多规则，而是让现有规则在真实路径、真实失败、真实模型和真实平台权限上更可信。

## 二、审查范围与方法

### 2.1 仓库范围

本轮审查覆盖：

- CLI 与安装生命周期：`scripts/loopengine.js`、`scripts/lib/install-planner.js`、`scripts/lib/install-state.js`、baseline、rollback、uninstall。
- Adapter 与 profile：Codex、Claude、Gemini 的入口、install map、capability 声明和红区配置。
- 治理 runtime：任务 Markdown、Red Team 审查包、Eval 产物、schema 校验和交付 Stop gate。
- Hooks：Codex lifecycle hook、Git pre-commit/pre-push、路径/命令/secret 策略。
- Skills：manifest、依赖闭包、渐进披露、路由、integration fallback 和行数预算。
- Evals：offline replay、online canary、reference、observer registry、变更门禁和健康状态。
- Tool provisioning：codebase-memory-mcp、Playwright CLI、Open Code Review、Agentmemory。
- CI、文档治理、供应链审计与跨平台测试。

codebase-memory-mcp 索引可用。本轮先读取结构图，再用 `rg` 和源文件核对。索引显示约 160 个文件、1098 个图节点，运行时代码热点主要集中在任务校验和自定义 JSON Schema 校验器。`validateTask` 的圈复杂度约 38、认知复杂度约 90，是当前最明显的维护热点。

### 2.2 外部研究范围

“全网最佳实践”不能理解为枚举互联网所有文章。本报告采用可复核的一手来源优先策略，覆盖截至 2026-07-16 的主流 AI coding 平台与开放规范：

- OpenAI Codex Manual：AGENTS.md、Skills、Hooks、Rules、sandbox、approval、MCP、plugins。
- Anthropic Claude Code：best practices、CLAUDE.md、rules、skills、subagents、hooks、permissions。
- Agent Skills 开放规范：目录结构、渐进披露、触发描述、脚本设计、技能 Eval。
- Google Gemini CLI：GEMINI.md、Agent Skills、Hooks、Policy Engine、sandbox、MCP。
- GitHub Copilot：repository/path-specific instructions、CLI/cloud hooks、hook 安全与失败语义。
- Cursor：Rules、Skills、Hooks、workspace trust、cloud-agent best practices。
- Model Context Protocol：Roots、Authorization、Security Best Practices、scope minimization。
- GitHub Actions 安全加固：第三方 Action 的 immutable SHA 固定。

社区文章只用于补充共识，不用于证明关键事实。关键建议尽量由两个以上平台或开放规范交叉支撑。

### 2.3 动态验证

本轮执行了仓库要求的检查，并增加三个定向复现：

| 检查 | 结果 | 关键证据 |
| --- | --- | --- |
| `pnpm check` | 通过 | lint 98 文件；289 tests 中 288 通过，1 个真实 Codex smoke 跳过 |
| `pnpm docs:audit` | 通过 | 25 个治理文档通过 |
| `pnpm skills:audit` | 通过 | 18 个 Skill；最长入口 78 行；图闭包通过 |
| `pnpm eval:check` | 通过 | Eval contract 通过 |
| `pnpm eval:offline` | 通过 | criticalPassRate=1、overallScore=1 |
| `pnpm runtime:audit` | 通过但有告警 | Agentmemory 真实安装面 12 Moderate；排除 optional 面 1 Critical/4 High |
| `pnpm test:integration` | 通过 | 66/66 |
| `pnpm smoke:lifecycle` | 通过 | core/full 10 个步骤全部退出 0 |
| 显式 core 临时项目链 | 通过 | init/dry-run/write/validate 均完成 |
| 显式 full 临时项目链 | degraded | 受控 10 秒限时下安装文件一致；三项工具 degraded，doctor 退出 2 |
| junction 写出项目复现 | 命中 | 安装退出 0，外部目录新增 6 个文件 |
| 中途失败半安装复现 | 命中 | 12 个 rules + AGENTS 已写；install-state 不存在 |
| schema 上限复现 | 命中 | `maximum`、`exclusiveMinimum`、整数 `maximum` 均返回空错误数组 |

第一次显式 full 写入未设置内部工具限时，外层命令 244 秒超时。外层终止未杀死下载子进程，随后需要按命令行精确定位孤儿进程并重试清理临时目录。该现象不是 smoke 失败，而是 smoke 的受控环境没有覆盖真实网络下载与父进程被终止时的进程树回收。

## 三、LoopEngine 当前优势

### 3.1 项目内治理边界清楚

LoopEngine 的核心承诺是“不修改全局 Agent 配置”。安装目标、工具缓存、MCP 注册、Hook 和 memory 都以目标项目为中心，CLI 使用 `--project` 指定项目，`--target` 只选择 adapter，真实写入统一要求 `--write`。这比依赖用户手工复制全局配置更容易审计，也更适合团队仓库。

### 3.2 安装所有权模型成熟

受管 block、target hash、source hash、backup、retired files、generated files、rollback 和 uninstall 已形成完整生命周期。默认拒绝覆盖用户文件，`--force` 才备份替换；红区还要求 `--confirm-red-zone`。这些设计与 Agent Skills 脚本指南提出的 safe defaults、dry-run、explicit confirmation、idempotency 高度一致。

### 3.3 “完成声明”有机器门禁

任务模板把 AC-ID、证据类型、命令/产物、退出码、核验时间和核验者关联起来。完整任务还有 Red Team 结构化审查包。Stop hook 同时检查 governance、evaluation 和 delivery packet，且通过 `stop_hook_active` 避免无限阻断。这比只要求模型在回复里说“已测试”强得多。

### 3.4 Skill 资产经过收敛

当前 18 个 Skill 中，15 个 native、2 个 integration、1 个 router，compatibility 入口已清零。Skill graph 会检查 frontmatter、manifest、依赖闭包、fallback、跨 Skill 引用、安装映射和入口预算。它已经采用开放 Agent Skills 规范强调的渐进披露，而不是把所有工作流常驻塞进 AGENTS.md。

### 3.5 Eval 与 deterministic tests 分层

安装安全、schema、hook、profile 和文件所有权由确定性测试保护；Agent 行为变化另有 offline/online Eval 和 reference。在线 canary 使用 repetitions=3，健康状态会对连续 degraded 做门禁。这个方向正确，也比只跑 prompt snapshot 更接近可持续的 Agent governance。

### 3.6 文档治理不是附属品

docs catalog、schema、broken links、生命周期术语、过期文档关系和中英文 README 等价性都有自动检查。对治理产品而言，规则文档就是运行时的一部分，LoopEngine 已经正确对待这一点。

## 四、分级发现

### 4.1 P1-01：词法路径校验无法阻止 junction/symlink 写出项目

**证据。** `scripts/lib/manifest.js:63` 的 `assertInsideDir` 只对 `path.resolve` 后的字符串做 `path.relative`。`scripts/lib/install-planner.js:545` 在写入前调用该函数，但没有检查任一已存在路径段是否为 symlink/junction，也没有对最近存在父目录做 `realpath` 比较。

**复现。** 在临时项目中把 `docs` 建为指向外部临时目录的 Windows junction，然后执行：

```text
pnpm loopengine init --project <project> --target codex --profile minimal
pnpm loopengine install --project <project> --target codex --profile minimal --write
```

安装退出 0，外部目录出现 6 个 LoopEngine 文件，包括 `rules/governance-core.md` 和 `templates/delivery.md`。install-state 仍认为这些目标位于项目内。

**影响。** 这直接违反“安装器不得写出目标项目”的核心安全声明。恶意或意外的仓库 junction 可以把写入导向兄弟仓库、用户目录或其他可写位置。Playwright artifact、backup、generated directory 等复用相似词法判断的路径也需要统一审计。

**整改。** 建立唯一的 `safe-path` 原语：

- 目标不存在时，对最近存在父目录执行 `realpath`，验证其真实路径位于真实 project root 内。
- 逐段 `lstat`，默认拒绝经过 symlink/junction/reparse point 的写入；确需支持时必须显式 allowlist。
- 创建文件后再次 `lstat/realpath`，防止 TOCTOU；高风险写入可使用同目录临时文件加原子 rename。
- 把 installer、rollback、uninstall、baseline、Playwright artifact、Eval fixture 和 tool-state 全部迁移到同一原语。
- 增加 Windows junction、POSIX symlink、目标文件 symlink、父目录替换和 race 模拟测试。

### 4.2 P1-02：安装不是事务，失败后可能没有 rollback 入口

**证据。** `scripts/lib/install-planner.js:539-583` 逐文件直接写目标；只有全部写入与 retire 完成后，才在 `scripts/lib/install-planner.js:637` 写 install-state。

**复现。** 在 core 临时项目中预建目录 `docs/templates/delivery.md/`，再执行 `install --write --force`。前面的 12 个 rules 和 `AGENTS.md` 已写入，后续 `copyFile/writeFile` 因目标是目录失败，`.loopengine/install-state.json` 不存在。

**影响。** CLI 报错后，用户无法运行正常 rollback/uninstall；只能人工判断哪些文件属于本次失败。这对治理安装器尤其危险，因为它声称安装、rollback 和卸载行为可验证。

**整改。** 采用 write-ahead journal：

1. preflight 检查所有 source、target、文件类型、父目录、红区、可写性和冲突。
2. 在 `.loopengine/transactions/<id>/journal.json` 写 planned actions 与原状态。
3. 所有新内容先写同文件系统 staging，fsync 后原子 rename。
4. 每完成一个动作更新 journal；install-state 原子替换。
5. 进程启动时检测 incomplete transaction，提供 `recover --rollback` 或自动恢复。
6. fault injection 测试在第 N 个动作抛错，验证任何 N 下都能恢复到一致状态。

### 4.3 P1-03：Codex Hook 异常路径实际 fail-open

**证据。** `runtime/hooks/codex-hook.mjs:92-93` 捕获任何异常后只写 stderr 并设置退出码 2。最新 Codex Manual 的 Hooks 章节说明，失败的 PreToolUse hook 会被标记失败、报告错误并继续工具调用；只有返回合法 deny 决策才能阻断。

**复现。** 向 hook 输入截断 JSON，进程输出解析错误并退出 2，没有 stdout JSON。输入超过 1 MiB、未知事件、缺失字段和内部读取错误也走同一路径。

**影响。** guarded/strict 的最危险时刻恰好是 parser 或 runtime 异常时；当前行为会从“策略不可用”退化为“允许执行”。Hook 文档已经正确声明 Hook 只是纵深防御，但 strict 模式仍不应静默放行高风险工具。

**整改。** 在最外层先用最小、安全的解析器提取 `hook_event_name`。对 `PreToolUse` 与 `PermissionRequest`：

- `strict`：任何内部异常返回 deny JSON；错误只输出稳定 code，不回显输入。
- `guarded`：结构化写工具与 Bash 的解析异常返回 ask/deny；只读事件可 fail-open。
- `observe`：记录 systemMessage 后放行。
- 增加 malformed JSON、oversized input、config unreadable、validator missing、timeout 的端到端 Codex hook fixture。

同时明确 Codex、Claude、Gemini、GitHub 对 crash、exit 2、timeout 的语义不同，adapter 必须各自实现，不应共享未经翻译的退出码假设。

### 4.4 P1-04：工具 provision 缺少可取消的进程树与独立生命周期

**证据。** `full` 写入会依次下载 codebase-memory binary、安装 Playwright 及约 192 MiB Chromium、执行 OCR LLM test、准备 Agentmemory。默认单工具 fallback timeout 可达 600 秒。外层进程被终止时，Windows 子进程树没有被一起回收。

**动态结果。** 未设置内部限时的显式 full 安装 244 秒后被外层停止，`codebase-memory-mcp/install.js` 等子进程继续运行并锁住临时目录。设置 `LOOPENGINE_TOOL_TIMEOUT_MS=10000` 后，命令约 55 秒收敛，但三个工具 degraded，doctor 退出 2。

**影响。** “安装治理资产”和“下载大体积/需凭据的可选工具”耦合，使最重要的安装事务被网络、registry、浏览器 CDN 和 LLM 凭据拖慢。外部取消后遗留进程会继续写项目和缓存。

**整改。** 拆分生命周期：

```text
install --write        -> 只安装确定性资产与工具 manifest
provision --tool X     -> 显式准备某个工具
doctor                 -> 只读健康检查
repair --tool X        -> 可重复修复
```

Playwright 保持真正 first-use；OCR 未配置凭据应是 `pending-config`，不在安装期做 LLM test；所有 child process 放入可取消 job object/process group，父进程退出时终止整棵树。进度使用结构化 phase、bytes、elapsed 和 retry-after，不把长下载 stdout 当诊断。

### 4.5 P1-05：项目内第三方工具继承过宽环境变量

**证据。** `runtime/tools/codebase-memory-mcp/run.mjs:10` 和 `runtime/tools/open-code-review/run.mjs:10` 直接传 `env: process.env`；Playwright 在 `runtime/tools/playwright-cli/run.mjs:207`、`:251` 展开完整环境；Agentmemory 在同一进程动态 import，天然拥有完整环境。

**影响。** 一个只需要扫描代码的 MCP server 可能看到 `AWS_*`、`AZURE_*`、`GITHUB_TOKEN`、数据库密码、代理凭据和其他与任务无关的变量。锁文件与 audit 降低了已知依赖风险，但不能代替运行时最小权限。

**整改。** 为每个 tool manifest 声明环境 allowlist、network policy、filesystem roots 和 credential class：

- codebase-memory：PATH、HOME/TEMP、CBM_*，默认无云凭据。
- Playwright：PATH、HOME/TEMP、PLAYWRIGHT_*；需要业务凭据时由用户显式映射。
- OCR：只映射选定 provider 的 URL/token/model；不要同时暴露所有 provider 凭据。
- Agentmemory：只映射其存储/API 所需变量。

wrapper 启动前清空默认 secret 模式，doctor 输出只显示变量名是否可用，不显示值。长期可把第三方工具放进独立 sandbox/container，并限制 egress。

### 4.6 P2-01：自定义 Schema 校验器与声明的 JSON Schema 不一致

`scripts/lib/manifest.js:134` 与安装后的 `runtime/governance/lib/schema-validation.mjs:1` 只实现部分关键字。当前实现仅对 integer 处理 `minimum`，不支持 number minimum、`maximum`、`exclusiveMinimum`、`maxItems` 等；但 eval schemas 已声明这些约束。

定向调用证明：值 2 对 `{type:"number", maximum:1}`、值 0 对 `{exclusiveMinimum:0}`、整数 4 对 `{maximum:3}` 都返回空错误数组。部分 Eval 语义校验会重新计算分数，降低了直接伪造风险，但 schema contract 本身不可信，未来新增 schema 很容易误以为约束已生效。

建议使用 Ajv draft 2020-12，或明确声明 `supportedKeywords` 并由 meta-test 扫描所有 schema，出现未实现关键字立即失败。CLI 与安装 runtime 必须从同一源生成，避免双实现漂移。

### 4.7 P2-02：Skill Eval 更像“路由故事回放”，不是触发行为测试

offline 的 skill-routing case 使用预置 replay events/output；online canary 只有一条明确提示 `eval-driven-development` 的正例。它能保护 capability contract，但不能回答：

- 18 个 Skill 的 description 是否在真实自然语言下正确触发？
- 相邻 Skill 是否重叠？
- 不该触发时是否保持沉默？
- 描述变短、Skill 数量增加、模型更新后触发率是否下降？

Agent Skills 官方建议为 description 建立 should-trigger/should-not-trigger 集，使用不同措辞、复杂度和边界案例，多次运行，并用 train/validation split 防过拟合；Anthropic skill-creator 还比较 with-skill/without-skill 的 pass rate、时间和 token。

建议每个 canonical Skill 至少 5 个正例、5 个负例，相邻 Skill 增加 pairwise confusion case；关键 router 每个 case 重复 3 次。指标应包含 precision、recall、误触发成本、token overhead 和任务成功提升，而不仅是“路由事件存在”。

### 4.8 P2-03：Claude/Gemini adapter 能力声明落后于平台现状

`manifests/adapters.json:17` 和 `:25` 把 Claude、Gemini 的 MCP 与 hooks 都标为 false，并禁止 `full`。截至本次审查：

- Claude Code 官方支持 project skills、project settings hooks、permissions、sandbox、subagents 和 MCP。
- Gemini CLI 官方支持 `.gemini/skills` 与 `.agents/skills`、丰富 hooks、Policy Engine、sandbox 和 MCP server。

这不是当前实现 bug，而是产品定位与平台能力的缺口。建议引入 capability negotiation，而不是继续把 profile 写死为平台名称：

```text
capabilities = instructions + skills + hooks + policy + mcp + sandbox + memory
profile       = 这些能力的经过测试的组合
adapter       = 把抽象能力编译为平台原生资产
```

先为 Claude/Gemini 增加 `full-preview`，要求各自通过 hook protocol contract、trust、Windows/Linux、uninstall 和“不覆盖现有 settings”测试，再升级为稳定 full。

### 4.9 P2-04：`language` 配置存在但未形成产品能力

`scripts/lib/project-config.js:27` 默认写入 `language: 'zh-CN'`，但安装模板、任务字段、runtime 错误和完整流程 JSON 都硬编码中文；README 虽有英文版，英语项目仍被要求使用中文 task/delivery contract。

建议二选一：

1. 如果产品明确只提供中文治理 runtime，删除误导性的 language 配置并在英文 README 说明。
2. 如果要国际化，把任务真值从中文 Markdown 字段迁移到语言中立 JSON/YAML，Markdown 只是按 locale 渲染的视图；错误码稳定，展示文本本地化。

第二条更符合跨平台治理包定位，也能降低当前 Markdown parser 的复杂度。

### 4.10 P2-05：权限策略与 Hook 仍混在一起

主流平台正在把 deterministic permission policy 与 lifecycle hooks 分离：Codex 有 rules/sandbox/approval，Claude 有 permissions/sandbox，Gemini 有 Policy Engine，Cursor 有 run modes 与 hooks。Hook 适合补充上下文、审计和完成门禁；命令 allow/deny、网络、文件系统和凭据边界更适合原生 policy/sandbox。

LoopEngine 目前主要在 Codex Hook 内用正则识别 shell 和路径，因此也明确承认无法拦截所有 shell/WebSearch 实现。建议新增 `policy` capability：

- 原生 policy 负责高置信 deny/ask。
- sandbox 负责真正的文件系统与网络边界。
- Hook 负责跨工具补充、日志、Stop evidence gate 和原生 policy 暂不覆盖的结构化路径。
- CI/branch protection 负责最终不可绕过门禁。

### 4.11 P2-06：Task validator 过于集中且 Markdown 语法脆弱

索引显示 `validateTask` 认知复杂度约 90。它同时解析中文字段、Markdown section、表格、JSON 控制块、Eval run/reference、Red Team、父子任务和完成证据。每次 CommonMark 边界修复都会增加正则与状态分支。

建议建立 typed intermediate representation：parse 只负责 Markdown -> AST/IR；schema 负责结构；semantic validators 按 task/evidence/eval/review 分模块；renderer 负责中文/英文视图。长期把机器真值放在 `.loopengine/tasks/*.json`，Markdown 由 CLI 生成或同步。

### 4.12 P2-07：CI Action 仍使用可移动 tag

`.github/workflows/ci.yml:21-27` 与 `evals.yml:17-21` 使用 `actions/checkout@v4`、`pnpm/action-setup@v4`、`actions/setup-node@v4`。GitHub 官方安全指南说明，完整 commit SHA 是当前唯一 immutable 的 Action 引用。

建议固定 SHA，并用 Renovate/Dependabot 自动提升级 PR；PR 中同时保留人类可读注释 `# v4.x.y`。治理产品的自身 CI 应示范它希望下游遵守的供应链标准。

### 4.13 P2-08：Agentmemory 真实安装面仍有 12 个 Moderate

当前 runtime audit 已正确区分真实 `--omit=optional` 安装面与被排除 optional 面，这是上一轮整改的明显进步。但 12 个 Moderate 仍应有 owner、到期时间、可利用性判断和替代/升级跟踪，而不是无限期 warning。

建议在 runtime tool catalog 增加 `acceptedAdvisories`：advisory ID、原因、是否 reachable、补偿控制、owner、reviewBy。过期或新增 advisory 阻断，避免 warning 常态化。

## 五、行业最佳实践横向对比

### 5.1 持久指令：短、具体、分层、可验证

OpenAI 建议 AGENTS.md 包含 repo layout、运行命令、build/test/lint、工程约定、约束和“done means”；Anthropic 建议只保留删除后会导致模型犯错的内容；Cursor 建议不要复制完整 style guide、不要写 Agent 能从代码推断的内容；GitHub 给 repository instruction 设置两页左右的实用上限并要求命令真实验证。

LoopEngine 已通过 90 行入口预算和路由规则控制常驻内容，方向正确。下一步应把“规则是否改变行为”纳入 Eval：没有行为增益的规则应删除，重复错误再转为 durable instruction。

### 5.2 工作流：风险分档，而不是所有任务强制重流程

OpenAI 与 Anthropic 都强调困难/模糊任务先计划，小改动直接做；Anthropic 的推荐流程是 Explore -> Plan -> Implement -> Commit，并要求给 Agent 可运行的验证。LoopEngine 的快速/轻量/完整三档比固定全流程更合理，也已经包含轻量反证和高风险独立核验。

建议继续保持“完整流程是例外而非默认”，并用数据观察每档的平均 token、时长、返工率和误分类率。治理的目标不是让每个任务更重，而是把注意力放在最可能失败的地方。

### 5.3 Skills：渐进披露、单一职责、真实触发 Eval

Agent Skills 规范建议 metadata 常驻、SKILL.md 激活后加载、resources 按需加载；SKILL.md 推荐小于约 5000 tokens。脚本应非交互、幂等、可 dry-run、有结构化输出、清晰退出码和安全默认值。OpenAI 还支持 `agents/openai.yaml` 声明 UI、隐式调用政策和 MCP 依赖。

LoopEngine 的 line budget、dependency closure、fallback 已经较好。缺口是 trigger precision/recall 和可选平台 metadata。建议先给 integration Skill 和高冲突 Skill 做 metadata/trigger Eval 试点，不要一次性给所有 Skill 增加双重真值。

### 5.4 Hooks：短、确定、严格 JSON、可信任、失败语义明确

各平台共同点：

- Hook 输入是外部数据，必须 schema validate。
- stdout 只输出协议 JSON，日志走 stderr。
- 使用 matcher 缩小触发面，保持低延迟。
- 设置 timeout，避免拖住 Agent loop。
- 不记录 prompt、secret 或完整工具结果。
- 项目 Hook 要经过 workspace trust 或 hash trust。
- PreToolUse 的 crash/timeout 语义必须按平台验证，不能假设一致。

LoopEngine 已做 1 MiB 输入上限、字段白名单、10/20 秒 timeout、根目录解析、prompt 不落盘和 trust 文档。需要补的是异常 fail-closed 策略、跨平台 adapter contract 和指标：hook duration、deny/warn count、error count、timeout count、stop-block count。

### 5.5 权限与 sandbox：Hook 不是安全边界

Codex、Claude、Gemini 与 Cursor 都把 workspace trust、permission/policy 和 OS/container sandbox 作为第一层；Hook 是第二层。MCP Roots 只是告知 server 边界，不等于 server 自动受限；MCP 安全规范还要求 scope minimization、token audience、禁止 token passthrough 和本地 server 安全。

LoopEngine 应把“项目内”从文档声明升级为真实路径、子进程环境、network 和 sandbox 约束。尤其是下载并执行的项目内第三方工具，不能因为位于 `.agents/loopengine/tools` 就自动可信。

### 5.6 Evals：证明 Skill/规则带来净增益

高质量 Skill Eval 不只检查输出有没有标题，而是比较有 Skill 与无 Skill 的成功率、成本、时间和方差；触发 Eval 要有正负例和验证集；grader 要求具体证据，不给模糊输出“善意通过”。

LoopEngine 目前 offline replay 非常确定，适合 contract regression；online canary 数量少，适合关键安全行为。下一阶段应增加第三层“behavior benchmark”：只对受影响 Skill/规则做真实模型 A/B，多次运行，输出置信区间和 capability delta。

## 六、建议的目标架构

```text
Source Assets
  rules / templates / skills / schemas / evals
          |
          v
Capability Catalog
  instructions / skills / hooks / policy / mcp / sandbox / memory
          |
          v
Adapter Compiler
  Codex plugin + project assets
  Claude plugin + project assets
  Gemini extension + project assets
          |
          v
Transactional Installer
  preflight -> journal -> stage -> commit -> recover
          |
          v
Runtime Boundaries
  realpath guard / env allowlist / process group / network policy
          |
          v
Evidence Loop
  deterministic tests -> behavior evals -> online canaries -> audit telemetry
```

这里最重要的变化不是目录重构，而是责任边界：

- capability catalog 描述“要什么能力”，adapter 负责“平台如何实现”。
- installer 只负责确定性资产事务；provision 负责可选外部工具。
- policy/sandbox 负责权限；hooks 负责生命周期和补充门禁。
- schema/IR 负责机器真值；Markdown 负责可读视图。
- deterministic test 保护实现；behavior Eval 证明模型行为；online canary 监控真实平台漂移。

## 七、90 天优化路线图

### 阶段 A：0-14 天，先封闭写入与失败边界

1. 实现 realpath/reparse-aware safe path 原语。
2. 为 installer、rollback、uninstall、Playwright artifact 增加 junction/symlink tests。
3. 安装 preflight 拒绝 file/dir 类型冲突，避免本轮复现的半安装。
4. Hook strict 异常返回 deny；guarded 输出稳定 advisory/deny。
5. 所有 provision child 加入进程组/job object，父退出时回收。
6. GitHub Actions 固定完整 SHA。

验收：junction 复现不再写外部；第 N 步 fault injection 可恢复；malformed PreToolUse 不放行；取消 full provision 后 2 秒内无子进程。

### 阶段 B：15-30 天，事务化与最小权限

1. 引入 transaction journal、staging 和 recovery。
2. 拆出 `provision/repair` 命令，`install` 不做重下载。
3. 为四个工具建立 env allowlist 与 credential declaration。
4. 用 Ajv 或 supported-keyword meta-gate 替换/约束 schema 校验器。
5. 给 Agentmemory advisories 建立 accepted-risk 到期机制。

验收：任意写入点断电模拟后 `recover` 可闭环；工具进程看不到未声明 fake secret；所有 schema 关键字都被实现或拒绝。

### 阶段 C：31-60 天，真实 Skill 与规则 Eval

1. 建立 description trigger benchmark，包含正例、负例、混淆对和验证集。
2. 对 router、brainstorming、writing-plans、debugging、security、browser 等高冲突 Skill 重复 3 次。
3. 增加 with-skill/without-skill A/B，记录 pass rate、tokens、duration、variance。
4. 把 capability catalog 扩展为公开能力 -> 实现 -> tests -> evals -> docs -> profiles 的完整追踪。
5. 增加 Hook telemetry 的本地脱敏 summary 和 CI artifact。

验收：关键 Skill precision/recall 有阈值；任何 Skill 描述变更自动选择受影响 Eval；规则新增必须证明净增益。

### 阶段 D：61-90 天，跨平台原生化

1. 引入 `policy`、`sandbox`、`plugin/extension` capability。
2. Claude full-preview：plugin hooks + skills + MCP + permissions contract。
3. Gemini full-preview：extension/hooks + skills + policy engine + MCP contract。
4. Codex adapter 迁移为真实 `.codex-plugin/plugin.json` 包；当前 `adapters/codex/codex-plugin.json` 改名，避免与官方 plugin manifest 混淆。
5. 决定 language 战略：明确中文限定，或将 task 真值迁移到语言中立 IR。

验收：三平台 capability matrix 由 contract tests 自动生成；安装/升级/卸载不覆盖用户 settings；平台更新只影响对应 adapter tests。

## 八、建议新增的测试清单

### 安装器安全

- Windows junction 父目录逃逸。
- POSIX symlink 父目录逃逸。
- 目标文件本身是 symlink。
- backup 目录是 junction。
- install-state 中合法相对路径经过 junction。
- staging 到 commit 之间父目录被替换。
- 每个 action 前/后 fault injection。
- kill parent 后子进程回收。

### Hook 合同

- malformed JSON、1 MiB+1、unknown event、cwd 不存在。
- config/schema/validator unreadable。
- PreToolUse parser crash 在 strict/guarded/observe 的差异。
- Codex/Claude/Gemini/GitHub 的 exit/timeout fixture。
- shell command、structured path、MCP tool、apply_patch 的等价风险矩阵。

### Schema 与治理 runtime

- 扫描 schema 全部 keyword，未支持即 fail。
- number minimum/maximum、exclusiveMinimum、maxItems。
- Markdown renderer/parser round trip。
- 中文/英文 view 指向同一 IR。
- `validateTask` 分模块 mutation tests。

### Skill 行为

- 每个 description 的 should/should-not trigger。
- 相邻 Skill confusion matrix。
- 描述截断后的触发稳定性。
- with/without skill A/B。
- 新模型/新版本基线与显著性阈值。

## 九、优先级与投入判断

| 项目 | 风险降低 | 实施成本 | 建议 |
| --- | --- | --- | --- |
| realpath/junction 防护 | 极高 | 中 | 立即做 |
| 安装 transaction journal | 极高 | 中高 | 紧随其后 |
| Hook 异常 fail-closed | 高 | 低中 | 立即做 |
| provision 拆分与进程树取消 | 高 | 中 | 30 天内 |
| 工具 env allowlist | 高 | 中 | 30 天内 |
| Schema 引擎统一 | 中高 | 中 | 30 天内 |
| Skill trigger/A-B Eval | 中高 | 中高 | 60 天内 |
| Claude/Gemini full-preview | 中 | 高 | 90 天路线 |
| task IR/i18n | 中 | 高 | 设计后实施 |
| Action SHA 固定 | 中 | 低 | 立即做 |

如果资源有限，前五项应占下一迭代的大部分投入。它们直接决定 LoopEngine 的安全承诺能否在失败和恶意路径下成立。继续增加规则、Skill 或 adapter 数量，不会弥补这些底层边界。

## 十、最终判断

LoopEngine 当前适合作为“内部可控项目中的成熟治理试点”，还不宜把“项目内写入绝不越界”“full 安装可可靠恢复”“strict Hook 能阻断危险动作”表述为无条件强保证。正常路径和已有测试非常扎实，但 junction、事务中断、Hook crash、环境最小权限和真实网络 provision 暴露出典型的“happy-path governance”盲区。

我的判断是，项目无需重写。它已经拥有正确的骨架：manifest 驱动、adapter 隔离、evidence-first、dry-run、ownership state、Eval-ID 和文档治理。只要下一阶段把路径安全、事务、process/env boundary 和真实行为 Eval 做实，LoopEngine 会从“治理资产打包器”升级为真正可验证的“AI coding control plane”。

最值得保留的原则是：

> 治理必须能在 Agent 犯错、工具崩溃、网络超时、依赖被攻陷和项目路径带陷阱时仍然成立。

## 十一、信息来源

以下来源访问时间均为 2026-07-16。

1. [OpenAI Codex Manual](https://developers.openai.com/codex/codex-manual.md) — Best practices、AGENTS.md、Skills、Hooks、Rules、sandbox、approval、MCP、plugins。
2. [OpenAI Codex repository: AGENTS.md](https://github.com/openai/codex/blob/main/AGENTS.md) — 真实大型仓库的分层 Agent 指令实践。
3. [OpenAI Codex repository: skills](https://github.com/openai/codex/tree/main/.codex/skills) — OpenAI 自身 Skill 的目录、references、scripts 与可选 metadata 实践。
4. [Anthropic: Best practices for Claude Code](https://code.claude.com/docs/en/best-practices) — verify、explore-plan-code、context、subagents、adversarial review。
5. [Anthropic: How Claude remembers your project](https://code.claude.com/docs/en/memory) — CLAUDE.md、rules、path-specific instructions、memory 边界。
6. [Anthropic: Extend Claude with skills](https://code.claude.com/docs/en/skills) — Skill discovery、frontmatter、trigger、eval、workspace trust。
7. [Anthropic: Hooks reference](https://code.claude.com/docs/en/hooks) — Hook lifecycle、输入输出、配置、事件和安全边界。
8. [Anthropic: Create custom subagents](https://code.claude.com/docs/en/sub-agents) — capabilities、permissions、skills、memory、hooks 与隔离上下文。
9. [Agent Skills Specification](https://agentskills.io/specification) — 开放 Skill 格式与渐进披露。
10. [Agent Skills: Best practices](https://agentskills.io/skill-creation/best-practices) — 真实任务提炼、控制粒度、validation loop。
11. [Agent Skills: Optimizing descriptions](https://agentskills.io/skill-creation/optimizing-descriptions) — should/should-not trigger、train/validation split。
12. [Agent Skills: Evaluating skills](https://agentskills.io/skill-creation/evaluating-skills) — with/without、grader、token/time、迭代。
13. [Agent Skills: Using scripts](https://agentskills.io/skill-creation/using-scripts) — pinning、idempotency、dry-run、structured output、安全默认值。
14. [Gemini CLI: GEMINI.md](https://geminicli.com/docs/cli/gemini-md/) — context hierarchy、imports、JIT context。
15. [Gemini CLI: Agent Skill best practices](https://geminicli.com/docs/cli/skills-best-practices/) — discovery、渐进披露、自由度、脚本与安全。
16. [Gemini CLI: Hooks best practices](https://geminicli.com/docs/hooks/best-practices/) — 性能、严格 JSON、测试、telemetry、threat model。
17. [Gemini CLI: Policy engine](https://geminicli.com/docs/reference/policy-engine/) — tool/args/subagent/MCP 策略与优先级。
18. [Gemini CLI: MCP servers](https://geminicli.com/docs/tools/mcp-server/) — Gemini 的 MCP 能力与配置。
19. [GitHub Copilot: Repository custom instructions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions) — 仓库与路径级指令、命令验证。
20. [GitHub Copilot: Hooks](https://docs.github.com/en/copilot/concepts/agents/hooks) — hook 类型、性能和安全建议。
21. [GitHub Copilot: Hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference) — policy/user/project/plugin hook 与失败语义。
22. [Cursor: Rules](https://cursor.com/docs/rules) — project/user/team rules、path scope 与反模式。
23. [Cursor: Agent Skills](https://cursor.com/docs/skills) — portable/versioned/actionable/progressive skills。
24. [Cursor: Hooks](https://cursor.com/docs/hooks) — shell、MCP、file、prompt、subagent lifecycle。
25. [Cursor Cloud Agents: Best practices](https://cursor.com/docs/cloud-agent/best-practices) — environment、testability、skills、agents.md、rules。
26. [MCP Security Best Practices](https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices) — confused deputy、token passthrough、SSRF、本地 server、scope minimization。
27. [MCP Roots](https://modelcontextprotocol.io/specification/2025-06-18/client/roots) — project roots 与安全考虑。
28. [MCP Authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) — OAuth 2.1、audience binding、token handling。
29. [GitHub Actions security hardening](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions) — 使用完整 commit SHA 固定第三方 Action。

## 十二、方法论说明

本报告采用横纵分析法：纵向核对 LoopEngine 从规则资产到 installer、runtime、hooks、evals 的治理闭环与近期整改结果；横向把同一时间截面的 Codex、Claude Code、Gemini CLI、GitHub Copilot、Cursor、Agent Skills 和 MCP 规范进行能力对比，再从两条轴交叉得出整改优先级。关键结论均以源代码、命令输出或一手官方文档支撑；无法证明的内容未作为事实写入。
