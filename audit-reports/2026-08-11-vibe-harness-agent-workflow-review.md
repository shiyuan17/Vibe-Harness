# Vibe-Harness Agent 工作流第一性原理审查

> 审查日期：2026-08-11
> 内容基线：b70703ef771581ddc275906a5926df722756b733，分支 feat/multi-target-opencode-batch
> 角色：项目维护者
> 范围：规则、Skills、Hooks、验证/Eval、Memory、跨宿主投影
> 排除：.codex/better-harness 既有生成报告；产品代码、配置、Git 历史和外部系统变更

## 执行结论

Vibe-Harness 已形成较强的安装事务、安全边界、可回滚机制、依赖锁定和确定性合同测试。其核心路径“获取事实 → 直接执行 → 聚焦验证 → 简洁交付”符合最小复杂度原则。本次没有发现需要停发或紧急处置的 P0 问题。

最高价值的整改不在增加流程，而在收紧运行态的授权和证据边界：

1. Stop Hook 默认用 git add -A 接管整个工作树，不能区分本任务改动与用户或并发任务改动。
2. Stop Hook 的宿主超时是 30 秒，内部却允许 lint 和 test 各运行 25 秒；宿主中止可能发生在已经暂存、尚未回滚的窗口。
3. Hook 入口依赖 session 当前目录，Codex 非受管 Hook 的精确哈希信任状态也未进入 validate 或 doctor 的可观测合同。
4. eval:offline 只对 suite 内置 replay fixture 评分并与已签入结果比较；它证明 Eval 合同确定性，不证明当前规则、Skill、模板、adapter 或 Hook 行为没有回归。
5. 跨宿主文档把“没有 Stop 自动提交”写成“完全不支持 hooks”，与实际模板和 capability manifest 冲突。Memory 有优先级和人工写入约定，但当前仍缺少可验证的新鲜度闭环。

建议立即处理 F-001、F-002 和 F-005，再补齐 Hook 激活可观测性、Git-root 路径解析和事件级跨宿主能力矩阵。Memory 审计与规则镜像告警适合放入后续迭代。

## 范围、方法与成熟度

### 六项第一性原则

| 维度 | 基本问题 | 成熟度判断 |
| --- | --- | --- |
| 授权明确 | 每次写入、提交和外部动作是否可追溯到明确授权？ | **部分**：红区和外部写入边界清晰，但 Stop 自动提交扩大到整个工作树。 |
| 最小权限 | Agent 或 Hook 是否只接触完成当前动作所需的最小文件、命令和网络能力？ | **部分**：安全策略较强，提交文件集和多 Hook 并发语义仍偏宽。 |
| 可逆性 | 失败是否恢复到可理解状态，且不覆盖用户改动？ | **强**：事务、备份、rollback、recover 和 Git 指纹收据完整；宿主超时窗口是例外。 |
| 行为确定性 | 同一输入、配置和资产是否产生可解释、可重复行为？ | **部分**：合同测试强，但 CWD、Hook 信任和 timeout 依赖宿主状态。 |
| 证据真实性 | “通过”是否证明了声明对象，而不是代理指标或旧状态？ | **部分**：verification 收据优秀；offline Eval 的当前证明力被表述过强。 |
| 复杂度收益 | 每层规则、Skill、Hook 和投影是否带来超过维护成本的收益？ | **强**：无 Router、Skill 精简且闭包受审计；跨宿主矩阵仍需规范化。 |

### 审查链路

本报告检查完整链路：平台/用户/项目指令优先级 → Skill 和工具路由 → Hook 与审批 → 验证和 Eval → Memory 反馈 → adapter 漂移控制。

优先级按潜在后果和默认触发概率评定：P0 为需立即止血；P1 为高影响或高概率；P2 为中等风险或需要额外条件；P3 为低风险治理债务。不能证明后果的候选降为观察项。

### 外部最佳实践校准

2026-08-11 在线确认以下资料均可访问，OpenAI 产品行为仅采用 OpenAI 官方文档：

| 来源 | 用于校准的原则 |
| --- | --- |
| [OpenAI AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md) | 指令按全局、项目根到当前目录逐层发现；组合指令默认有 32 KiB 上限，实际生效内容应可验证。 |
| [OpenAI Hooks](https://learn.chatgpt.com/docs/hooks) | 同一事件匹配的命令 Hook 并发启动；非受管 Hook 按当前定义哈希审查与信任；仓库 Hook 应从 Git root 解析。 |
| [OpenAI Agent 安全](https://learn.chatgpt.com/docs/agent-approvals-security) | sandbox 和审批互补；委派前保持工作树可隔离；审查 diff 并运行聚焦验证。 |
| [Anthropic：Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) | 优先最简单、可组合模式，只在收益明确时增加 agentic 复杂度。 |
| [MCP 安全最佳实践](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices) | 显式同意、最小权限、进程隔离或沙箱和纵深防御。 |
| [NIST AI RMF Playbook](https://airc.nist.gov/airmf-resources/playbook/) | 用 Govern、Map、Measure、Manage 串联治理、情境、度量和处置。 |
| [NIST SSDF SP 800-218](https://csrc.nist.gov/pubs/sp/800/218/final) | 将安全实践嵌入生命周期并保留可复核的来源、验证和变更证据。 |

## 证据目录

| ID | 证据位置或命令 | 可证明范围 |
| --- | --- | --- |
| E-001 | HEAD=b70703e；git status 只有三个被排除的 .codex/better-harness 未跟踪目录。 | 固定本报告的源码和测试基线。 |
| E-002 | [auto-commit.mjs 第 121 行](../runtime/hooks/auto-commit.mjs#L121)、[第 138 行](../runtime/hooks/auto-commit.mjs#L138)、[第 142 行](../runtime/hooks/auto-commit.mjs#L142)、[第 173 行](../runtime/hooks/auto-commit.mjs#L173) | 非受保护 task branch 上任意 dirty working tree 都进入 git add -A；没有 task-owned path 输入。 |
| E-003 | [auto-commit.mjs 第 88 行](../runtime/hooks/auto-commit.mjs#L88)、[Codex Hook 模板第 30 行](../adapters/codex/hooks.template.json#L30)、[Claude Hook 模板第 27 行](../adapters/claude/hooks.template.json#L27) | lint/test 顺序执行且各自最多 25 秒；宿主 Stop Hook 总超时 30 秒。 |
| E-004 | [template-renderer.js 第 3 行](../scripts/lib/template-renderer.js#L3)、[hooks.md 第 43 行](../docs/hooks.md#L43)、[hook-installation.test.js 第 74 行](../tests/hook-installation.test.js#L74) | Hook 入口固定为 .agents/runtime/hooks 相对路径；文档要求从项目根启动。 |
| E-005 | OpenAI Hooks 官方文档，2026-08-11 在线核验。 | session CWD、Git-root 建议、匹配 Hook 并发、按定义哈希 trust。 |
| E-006 | 仓库搜索 scripts、docs、tests 中 trust、trusted、/hooks 和 Hook definition hash。 | 未发现 Codex runtime trust 状态模型；负向搜索不能证明宿主没有其他接口。 |
| E-007 | [eval-replay.js 第 17 行](../scripts/lib/eval-replay.js#L17)、[第 22 行](../scripts/lib/eval-replay.js#L22)、[第 27 行](../scripts/lib/eval-replay.js#L27)、[eval-offline.js 第 17 行](../scripts/eval-offline.js#L17) | observation 来自 definition.input.replay，fingerprint 固定为 fixture-v1，并与签入 run 深比较。 |
| E-008 | [test-rules.md 第 34 行](../docs/rules/test-rules.md#L34)、[第 78 行](../docs/rules/test-rules.md#L78)、[项目配置第 13 行](../vibe-harness.config.json#L13) | 文档把 offline Eval 描述为 Agent 非确定性行为回归；onlineRunner 当前为 null。 |
| E-009 | [adapter manifest 第 38 行](../manifests/adapters.json#L38)、[第 52 行](../manifests/adapters.json#L52)、[第 80 行](../manifests/adapters.json#L80)、[Cursor 模板](../adapters/cursor/hooks.template.json#L1)、[Qoder 模板](../adapters/qoder/hooks.template.json#L1)、[Antigravity 模板](../adapters/antigravity/hooks.template.json#L1)、[hooks.md 第 3 行](../docs/hooks.md#L3)、[第 13 行](../docs/hooks.md#L13) | 三个宿主均有 Hook 模板，但文档另称它们不支持 hooks。 |
| E-010 | [项目配置第 57 行](../vibe-harness.config.json#L57)、[AGENTS 第 45 行](../AGENTS.md#L45)、[本地 Memory 规则第 14 行](../.agents/memory/README.md#L14)、[CURRENT 第 3 行](../.agents/memory/CURRENT.md#L3)、[PROJECT_STATE 第 3 行](../docs/memory/PROJECT_STATE.md#L3) | Memory 已启用且有读写约定；当前两个入口仍是未填写模板。 |
| E-011 | pnpm docs:audit，退出码 0。 | 75 篇通过；四个工具规则缺少仓库内 docs/rules 对应项，作为 warning 保留。 |
| E-012 | [file-transaction.js 第 155 行](../scripts/lib/file-transaction.js#L155)、[第 240 行](../scripts/lib/file-transaction.js#L240)、[install-planner.js 第 1255 行](../scripts/lib/install-planner.js#L1255)、[第 1572 行](../scripts/lib/install-planner.js#L1572) | 写入有事务、锁、preimage、commit/rollback；覆盖和红区确认受控。 |
| E-013 | [manifest.js 第 89 行](../scripts/lib/manifest.js#L89)、[Hook policy 第 423 行](../runtime/hooks/lib/policy.mjs#L423) | 安装拒绝 link/junction/reparse 穿越；Hook 拒绝项目边界外写入。 |
| E-014 | [project-verification.js 第 127 行](../scripts/lib/project-verification.js#L127)、[第 147 行](../scripts/lib/project-verification.js#L147)、[验证测试第 195 行](../tests/project-verification.test.js#L195) | verification 收据含 ID、时间和前后 Git 指纹，能拒绝检查期间的项目变化。 |
| E-015 | [skills manifest 第 4 行](../manifests/skills.json#L4)、[skill closure 测试第 23 行](../tests/skill-closure.test.js#L23)、[Skills 精简记录第 14 行](../docs/inventory/skills-optimization-zh.md#L14) | 8 native、3 integration、0 Router；无 Skill 流程依赖。 |
| E-016 | [RTK checksum 第 16 行](../runtime/tools/rtk/run.mjs#L16)、[npm 安装参数第 217 行](../scripts/lib/tool-provisioning/environment.js#L217)、[工具规格第 63 行](../docs/specs/vibe-harness-tooling-modules-spec.md#L63) | lockfile/integrity、ignore-scripts 和 RTK 固定 SHA-256。 |
| E-017 | 本轮完整命令矩阵，见“验证结果”。 | 证明当前静态合同和聚焦实现测试通过，不扩大到真实宿主或在线模型行为。 |

## 发现

### F-001：Stop Hook 自动提交缺少任务所有权边界

- **等级 / 状态 / 置信度**：P1 / 已验证风险 / 高
- **证据位置**：E-002、E-005；[auto-commit.mjs 第 138 行](../runtime/hooks/auto-commit.mjs#L138)、[第 142 行](../runtime/hooks/auto-commit.mjs#L142)
- **实际后果**：只要位于非受保护分支，Hook 就把整个 dirty working tree 暂存并纳入同一提交。代码没有任务 ID、起始 Git 快照、允许路径或变更归属，因此用户预存修改、IDE 生成文件和并发 Agent 变更都属于可提交集合。安全扫描只能判断内容风险，不能判断任务所有权。
- **根因**：把“一个工作树等于一个逻辑任务”当作隐含不变量，与“保护用户未归属改动”和并发写入范围规则不一致。
- **最小整改**：默认关闭 Stop 自动提交，或要求项目显式 opt-in；启用时记录 turn 开始 Git 指纹和允许路径，只暂存本 turn 且在允许集合内的文件。起始 dirty、归属不明或指纹漂移时只报告，不提交。
- **验证方式**：临时仓库同时放入用户旧修改、turn 新修改和未跟踪文件，断言只提交声明路径；再覆盖 rename/delete、部分暂存和并发修改。
- **残余风险**：路径级所有权不能区分同一文件内的混合修改；需要 hunk 隔离、独立 worktree，或遇到混合修改时拒绝自动提交。

### F-002：Stop Hook 超时预算不能覆盖内部验证上界

- **等级 / 状态 / 置信度**：P1 / 已验证设计缺口 / 高
- **证据位置**：E-003；[auto-commit.mjs 第 88 行](../runtime/hooks/auto-commit.mjs#L88)、[第 142 行](../runtime/hooks/auto-commit.mjs#L142)、[Codex 模板第 37 行](../adapters/codex/hooks.template.json#L37)
- **实际后果**：Hook 先 git add -A，再顺序运行 lint/test。内部理论上允许约 50 秒，宿主 30 秒即可终止进程；此时 catch 和 resetStaging 不保证执行，index 可能由用户原状态变为“全部暂存”，且没有 additionalContext 解释。
- **根因**：宿主 deadline 和子命令 timeout 分别硬编码，没有单一总预算和可靠清理顺序。
- **最小整改**：让内部总预算严格小于宿主 timeout 并留清理余量。更稳妥的是在不修改 index 的情况下先验证，最后暂存允许文件并提交；不要把信号清理当成唯一保障。
- **验证方式**：用慢命令模拟 29 秒、31 秒和第二命令超时，由外层按宿主 deadline 终止，断言 HEAD、index、working tree 与启动前一致。
- **残余风险**：强制终止时信号处理仍可能失效；避免提前修改 index 才是根本控制。

### F-003：Hook 入口依赖 Session CWD

- **等级 / 状态 / 置信度**：P2 / 已验证风险 / 高
- **证据位置**：E-004、E-005；[template-renderer.js 第 3 行](../scripts/lib/template-renderer.js#L3)、[hooks.md 第 43 行](../docs/hooks.md#L43)
- **实际后果**：从仓库子目录启动宿主时，node .agents/runtime/hooks/... 相对 session CWD 解析，入口不可达。文档用“从项目根启动”规避，但这使安全 Hook 可用性依赖操作习惯。
- **根因**：把相对路径视为跨宿主稳定合同，未使用 Git root 或宿主项目根变量。
- **最小整改**：各 adapter 使用宿主支持的项目根解析；没有原生变量时提供 launcher，向上定位 .git 和 install-state 后再执行受管 Hook。
- **验证方式**：在根目录、多级子目录、worktree 和无 Git 目录触发安装后的 Hook，断言入口一致或明确 fail-closed。
- **残余风险**：宿主插值、Windows quoting 和 worktree 语义不同，需要 adapter 级合同测试。

### F-004：Codex Hook 文件一致性与运行态信任状态未区分

- **等级 / 状态 / 置信度**：P2 / 已验证可观测性缺口 / 中高
- **证据位置**：E-006；[Hook 安装测试第 74 行](../tests/hook-installation.test.js#L74)
- **实际后果**：Codex 非受管 Hook 的新定义或变更定义在获信任前会被跳过。当前 validate 和 doctor 能证明配置与文件存在，却没有报告 trusted、review-required 或 unknown；维护者可能把“安装 ready”误读为“运行时防护 active”。
- **根因**：状态模型覆盖安装所有权与内容哈希，但没有单独建模宿主激活证明。
- **最小整改**：拆分 installed、content-valid 和 activation 状态。没有稳定机器接口时，doctor 必须报告 activation=unknown，并指导用户通过 /hooks 核验。
- **验证方式**：在真实 Codex 覆盖首次安装、信任、修改 Hook 和再次启动，记录 /hooks 状态及一次无害 PreToolUse 探针。
- **残余风险**：宿主版本可能改变信任存储；不要解析未承诺的内部文件来伪造稳定 API。

### F-005：offline Eval 的通过结论超出实际执行对象

- **等级 / 状态 / 置信度**：P1 / 已验证证据缺口 / 高
- **证据位置**：E-007、E-008；[eval-replay.js 第 22 行](../scripts/lib/eval-replay.js#L22)、[第 27 行](../scripts/lib/eval-replay.js#L27)、[eval-offline.js 第 17 行](../scripts/eval-offline.js#L17)、[test-rules.md 第 34 行](../docs/rules/test-rules.md#L34)
- **实际后果**：本轮 eval:offline 得到 criticalPassRate=1 和 overallScore=1，但 runner 没有加载或执行当前规则、Skill、模板、Hook 或 Agent。只改变这些资产、不改变 replay/reference 时仍可满分。因此结果只能证明 fixture、oracle、scoring、schema 与签入结果一致。
- **根因**：deterministic replay 的框架自测与 behavioral eval 的被测 Agent 执行共用一个命令和完成叙事。
- **最小整改**：将当前命令命名或表述为 offline contract replay；新增加载当前安装资产的 deterministic stub runner，并让 fingerprint 包含规则、Skill、Hook 和配置哈希；或明确把真实行为证明留给受控 online canary。
- **验证方式**：对关键安全规则、Skill description 和 Hook policy 做变异；行为 Eval 必须失败，contract replay 则只在 fixture/reference 漂移时失败。
- **残余风险**：stub 仍不能代表真实模型和宿主版本；上线判断需结合 online 多轮 Eval、真实 Hook 探针和人工审查。

### F-006：跨宿主能力声明混淆安全 Hook 与 Stop 自动提交

- **等级 / 状态 / 置信度**：P2 / 已验证文档漂移 / 高
- **证据位置**：E-009；[hooks.md 第 3 行](../docs/hooks.md#L3)、[第 13 行](../docs/hooks.md#L13)、[auto-commit 注释第 2 行](../runtime/hooks/auto-commit.mjs#L2)、[adapter manifest 第 38 行](../manifests/adapters.json#L38)
- **实际后果**：文档先说 full 为 Cursor/Qoder 安装安全 Hook，随后又说 Cursor/Qoder/Antigravity 不支持 hooks；实际三者均有 Hook 模板，只是 Stop 事件和稳定级别不同。维护者无法从文档稳定判断 PreToolUse、PermissionRequest 和 Stop 的支持情况。
- **根因**：单一 hooks=stable/preview/unsupported 无法表达事件差异，文档又把某一事件缺失泛化为全部 Hook 能力。
- **最小整改**：把能力拆成 preToolUse、permissionRequest、stopAutoCommit、trustObservable，并由 manifest 生成文档或做双向 parity。立即把“不支持 hooks”改成“不支持 Stop 自动提交”。
- **验证方式**：生成每个 adapter 的事件矩阵快照，断言 manifest、模板、docs 和 safety posture 一致；真实宿主 smoke 至少覆盖 allow 与 deny。
- **残余风险**：宿主协议会变化；stable 应绑定已验证宿主版本和最后验证日期。

### F-007：Memory 反馈闭环依赖人工纪律

- **等级 / 状态 / 置信度**：P3 / 观察项 / 中
- **证据位置**：E-010；[Memory README 第 14 行](../.agents/memory/README.md#L14)、[CURRENT 第 3 行](../.agents/memory/CURRENT.md#L3)、[PROJECT_STATE 第 3 行](../docs/memory/PROJECT_STATE.md#L3)
- **实际后果**：启动读取顺序、持久事实优先级和里程碑更新均有文字约定，但两个入口仍为空模板，也没有命令证明最后更新、最后验证或关联文件仍新鲜。Memory 可辅助恢复，不能作为当前完成证据。
- **根因**：Memory 是可选人读能力，写入触发、过期检测和源码变更关联未进入确定性验证层。
- **最小整改**：保持 Memory 可选，增加只读 memory:audit，报告空入口、过期日期、失效文件引用和 detect_changes 交集；只在用户要求保存或明确 handoff 时写入。
- **验证方式**：构造空模板、过期日期、已删除文件、命中变更范围和有效记忆五类 fixture，断言只报告、不自动改写。
- **残余风险**：结构检查不能判断文字是否真实；最终仍需源码和测试复核。

### F-008：四项工具规则长期停留在文档警告态

- **等级 / 状态 / 置信度**：P3 / 已验证治理债务 / 高
- **证据位置**：E-011；[rules manifest 第 7 行](../manifests/rules.json#L7)、[第 22 行](../manifests/rules.json#L22)
- **实际后果**：docs:audit 每次都输出 ast-grep、chrome-devtools-mcp、codebase-memory-mcp 和 rtk 四条 warning。维护者从 docs/rules 入口看不到仓库内镜像，永久预期 warning 也降低新 warning 的信号强度。安装器会向目标项目投影这些规则，所以这不是运行时缺文件。
- **根因**：对工具规则采用永久 warning，而不是完整镜像或显式、可审计的例外。
- **最小整改**：补齐四个 docs/rules 镜像并纳入 parity，或在 manifest 声明 docsParity exempt 和理由，让已审查例外静默、未知缺口失败。
- **验证方式**：docs:audit 无预期 warning；新增未声明 rules-only 文件时仍失败。
- **残余风险**：双份 Markdown 增加维护成本；采用镜像时需生成或 parity 保证单一事实源。

## 端到端路径审查

| 阶段 | 已有控制 | 主要断点 | 最小闭环 |
| --- | --- | --- | --- |
| 指令优先级 | AGENTS 明确优先级，启动读取治理 Memory。 | 实际激活指令与 32 KiB 截断没有项目收据。 | doctor 输出发现链、哈希、总字节数和截断项。 |
| Skill/工具路由 | description 原生选择；8 native、3 integration、0 Router。 | integration 可用性依赖宿主运行态。 | 明确 ready、degraded、unavailable。 |
| Hook/审批 | guarded policy、红区、出口和项目边界保护完整。 | 文件所有权、超时、CWD、Codex trust、并发语义。 | 事件级 capability、Git-root launcher、activation 状态、task-owned files。 |
| 验证 | lint/test/verify 分层；verification 有前后 Git 指纹。 | Stop 预算与宿主 deadline 不一致。 | 单一 deadline，检查前不改 index。 |
| Eval | schema、oracle、scoring、reference 合同完整。 | offline 只 replay fixture。 | contract replay 和 behavioral eval 分名、分 fingerprint、分结论。 |
| Memory | durable/local 分层和优先级明确。 | 写入、过期检测靠人工，入口为空。 | 只读 freshness audit，保存仍需明确意图。 |
| 跨宿主 | manifest、install map、schema 和测试覆盖八个 adapter。 | 单一 hooks capability 无法表达事件差异。 | 事件级机器矩阵生成文档并驱动 smoke。 |

## 已验证优势

1. **事务安装与恢复**：项目内事务锁、journal 和 preimage 支持 commit、rollback、recover；失败测试覆盖回滚与锁所有权。
2. **红区与覆盖保护**：真实写入需要 --write，Codex full 红区需要 --confirm-red-zone；未使用 --force 不覆盖用户文件，强制升级保留 backup。
3. **路径逃逸防护**：安装与恢复拒绝 symlink、junction、reparse 穿越；Hook 对项目边界外写入 fail-closed。
4. **验证收据**：verify 记录 ID、起止时间和前后 Git 指纹；检查期间仓库变化令 stable=false。
5. **Eval 合同**：suite、run、reference、oracle、scoring 和 schema 有确定性测试；offline 禁止 LLM rubric。缺口在被测对象，不在合同基本完整性。
6. **Skill 精简**：8 个 native 和 3 个显式 integration Skill，无 Router、无流程依赖；预算、安装闭包和退休目录均有测试。
7. **供应链约束**：项目内工具有固定版本与 lockfile，npm 默认 ignore-scripts，RTK 资产按平台固定 SHA-256，runtime audit 对 High/Critical fail-closed。
8. **复杂度纪律**：规则不强制规划、Review、子 Agent 或任务状态机，符合“收益明确才增加复杂度”的实践。

## 整改路线

### 立即修复

| 维护任务 | 可直接验收的完成条件 | 对应发现 |
| --- | --- | --- |
| Stop 自动提交增加显式 opt-in 和 dirty-at-start 拒绝策略 | 默认不提交未知归属变更；测试覆盖用户预存和并发修改。 | F-001 |
| 统一 Stop 总 deadline，验证期间不提前改 index | 外层 30 秒终止后 HEAD、index、working tree 与启动前一致。 | F-002 |
| 收窄 offline Eval 文档和 CI 完成主张 | 输出明确为 contract replay，不再声称证明当前 Agent 行为。 | F-005 |
| 修正“不支持 hooks”文案 | 准确区分安全 Hook 和 Stop 自动提交，parity 测试通过。 | F-006 |

### 下一迭代

| 维护任务 | 可直接验收的完成条件 | 对应发现 |
| --- | --- | --- |
| Hook 改为 Git-root 或项目根解析 | 从多级子目录和 worktree 启动均命中同一入口。 | F-003 |
| doctor 增加 Hook activation 模型 | 输出 installed、content-valid、activation；不可读时为 unknown。 | F-004 |
| 建立事件级跨宿主 capability matrix | PreToolUse、PermissionRequest、Stop、trust 分别建模并生成文档。 | F-006 |
| 新增加载当前资产的 behavioral Eval | 关键规则、Skill、Hook 变异必然导致失败，fingerprint 含资产哈希。 | F-005 |
| 清理四条永久 docs warning | docs:audit 无预期噪声，未知缺口仍失败。 | F-008 |

### 长期演进

| 维护任务 | 可直接验收的完成条件 | 对应发现 |
| --- | --- | --- |
| 为高并发任务提供独立 worktree 或 hunk 所有权 | 同文件混合修改不会被自动提交，冲突时降级为人工提交。 | F-001 |
| 建立真实宿主 Hook canary | 每个支持宿主验证 allow、deny、CWD、超时和激活，并记录版本。 | F-003、F-004、F-006 |
| 增加只读 Memory freshness audit | 能发现空入口、过期时间和失效引用，不自动保存或覆盖。 | F-007 |
| replay、stub behavioral、online canary 分层报告 | 每层单独 fingerprint、阈值、证明边界和降级原因。 | F-005 |

## 验证结果

全部命令于 2026-08-11 在基线 b70703e 上运行；报告写入前产品代码未变化。

| 命令 | 退出码 | 关键结果 | 证明边界 |
| --- | ---: | --- | --- |
| pnpm check | 0 | lint 144 文件；validation 通过；unit 115/115 | 当前静态、schema、核心单元合同。 |
| pnpm docs:audit | 0 | 75 篇通过，4 条已记录 warning | 文档基本合同；F-008 仍存在。 |
| pnpm skills:audit | 0 | 11 总计：8 native、3 integration、0 router | Skill inventory、预算和图校验。 |
| pnpm eval:check | 0 | evaluation contracts passed | Eval 资产、schema 和交叉引用。 |
| pnpm eval:offline | 0 | criticalPassRate=1，overallScore=1 | 只证明 deterministic replay；见 F-005。 |
| pnpm pack:contract | 0 | 233 文件，0 error | npm pack 表面完整且排除本地审计证据。 |
| 聚焦 Node 测试：Hook、auto-commit、Skill 闭包、项目验证、Eval 合同和 CI | 0 | 81/81 | 指定聚焦实现与合同。 |
| git diff --check；对未跟踪报告追加 no-index 检查 | 0 | 无 whitespace error | 报告文件没有 Git 空白错误。no-index 原始状态 1 仅表示报告与空文件存在内容差异。 |

### 未验证项

- 未运行 pnpm eval:online：当前 [项目配置第 24 行](../vibe-harness.config.json#L24) 的 onlineRunner 为 null，真实执行还需要模型或宿主凭据与外部调用；本次只读审查不扩大授权。
- 未在 Codex、Claude、Cursor、Qoder、ZCode、Antigravity 的真实 GUI 或 CLI 会话触发 Hook，因此没有声称信任、并发、CWD 和 timeout 已通过端到端验证。
- 未把 .codex/better-harness 既有生成报告作为结论来源，也未把当前分支历史归因给 Stop Hook。
- 未运行全量 test:integration 或 lifecycle smoke：本次没有修改 installer/runtime；用户指定的聚焦合同、check 和 pack:contract 已运行。既有优势由源码与对应聚焦测试支撑，不把未运行矩阵表述为本轮通过。

## 最终判断

Vibe-Harness 的静态治理与安装安全已达到可维护水平，尤其是事务写入、路径边界、红区确认、验证收据和依赖锁定。下一阶段不应增加更多流程角色，而应把运行态不确定性显式化：谁授权提交、哪些文件属于本任务、Hook 是否真的激活、deadline 是否允许清理，以及 Eval 实际执行了什么资产。

完成 F-001、F-002 和 F-005 后，证据真实性与最小权限会得到最大提升；随后用事件级 capability 和真实宿主 canary 控制跨宿主漂移。
