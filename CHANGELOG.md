# 更新日志

## Unreleased

- eval offline reference 按内容变更再生成（B5-d，需维护者提交前审查 diff）：evals/references/vibe-harness-core.offline.json 与 evals/results/vibe-harness-core.offline.json 经确定性重放（buildOfflineRun）再生，.agents/evals/references/ 镜像同步。diff 范围仅含预期漂移组：config（B4-a install map 红区补标）、hooks（P1-5 hook 启动提速复用 git root）、rules（B2 拆段与 B3 跨文件收敛）、skills（B4-b description 改写，文件数 99→100 为 2026-08-18 892ee58 新增 linear-workflow 参考文件——上一次发布未再生成 reference，approvedAt 停留在 2026-08-12，本次一并追平）；aggregateHash 与各组 hash 相应更新，run status/overallScore/criticalPassRate 保持 passed/1/1。此前 test:eval 中 2 项指纹断言失败随本次再生成消除，pnpm eval:check 与 pnpm test:eval 全绿（152 pass / 0 fail / 1 既有跳过）。按 test-rules「reference 更新必须单独审查并显式确认」，请在提交前审查三个 JSON 的 diff。
- 治理记忆种子化（P2-7）：docs/memory/PROJECT_STATE.md 从空模板填入真实状态（P0/P1 已落地、P2 五批次进行中、B5-d reference 再生成为交付确认项，恢复提示指向审查报告、TECH_DEBT 与改进队列）；docs/memory/IMPROVEMENTS.json 按 schemaVersion 1 填入 P2-1..P2-10 十个候选（9 项 implemented、P2-10 Claude permissions.deny 兜底为 eligible-for-owner-review 待 owner 评审，ID 按 improvements-audit 的 type:code:targetAsset 摘要派生）；.agents/memory/CURRENT.md 同步为当前真实状态并带当日验证日期。自安装校验（validateSelfInstalledArtifacts）要求无占位符的 replace 源与安装副本逐字一致，直接改 docs/memory 会漂移——按 TECH_DEBT 模板既有先例给 templates/memory/PROJECT_STATE.md、memory/CURRENT.md 补渲染说明注释（{{projectName}} 占位符，安装时渲染、副本各自维护），templates/memory/IMPROVEMENTS.json 补 "project": "{{projectName}}" 字段（schema 同步新增可选 project 属性，mergeImprovementCandidates 重写时保留该字段）；docs/memory/ARCHITECTURE、FAILURE_LEARNINGS、KNOWN_BUGS 三个仍为纯模板（暂无真实内容可填，未动）。已用 validateJsonAgainstSchema 校验队列零错误、auditMemory 对本仓库运行通过。AGENTS.md 启动序列不变。
- EVAL-SPLIT fixture 一致性护栏：tests/eval-contract.test.js 新增契约测试，锁定 canary 套件三个 EVAL-SPLIT 用例（plan-task-split）内嵌的 AGENTS.md fixture 文本必须逐字一致（三处此前为独立复制，存在漂移风险），并锚定硬触发与 4+ 阈值关键句；docs/evals.md 注记该 fixture 文本派生自 governance-core 拆分判定段（第三条硬触发「探索加实现预计超出单次上下文」与软信号 `multi test layers` 属意译），更新 governance-core 拆分判定段时需同步 fixture。不引入 fixture 自动生成（生成器需中→英翻译）。
- 新增 `pnpm docs:sync` 镜像生成器（scripts/sync-rules.js）：从 rules/*.md 一键再生 docs/rules/ 镜像，契约与 docs:audit 的 rules parity 对齐——跳过渲染模板 project-specific-rules.md（其 docs 副本按目标项目渲染）、按固定命名映射渲染 agent-skill-routing.md → AGENT_SKILL_ROUTING.md、行尾归一化后一致即跳过写入（幂等且不动 mtime），并报告无 rules 来源的 docs 孤儿文件（退出非零）。生成器定位为手动收敛工具，不进 check 链，docs:audit 继续兜底校验双份一致；CONTRIBUTING.md 补一行使用指引。新增 tests/docs-sync.test.js（纳入 test:unit）覆盖命名映射与模板排除、幂等与孤儿报告、docs/rules 缺失时创建与 rules 树缺失时空报告；真实仓库运行 19 个镜像文件全部 already-in-sync、零写入。
- eval:behavioral 变异覆盖补齐为「每控件每个 required 片段独立变异」：变异数由每控件仅变异第一个片段（共 4 个）补齐为全部片段独立变异（共 10 个：2+2+3+3），变异 ID 带片段序号并在报告中记录被移除片段文本；变异检测改为诚实语义——控件本已失败时不再空真报告 detected（仅在观察到由通过翻转为失败时计检出），status 判定不变。新增 tests/eval-behavioral.test.js 并纳入 test:unit：真实包锁定每控件变异数与全部检出、全片段 fixture 通过、缺失非首片段时对应 case 失败且该控件变异不空真。
- Skill description 语言护栏与统一（宿主按 description 文本路由）：pack 校验新增两层语言一致性检查——单条 description 不得中英混写（内嵌技术词如 $git-deliver、Playwright 可容忍）、全部 Skill 的 description 必须同用一种文字；git-deliver 与 browser-verification 的 description 由中文改写为英文（正文保持中文），git-deliver 的 Codex openai.yaml 元数据同步英文化（原为 9 个原生 Skill 中唯一中文元数据）；eval-driven-development 的 description 补负向边界 `not deterministic logic, bug fixes with known causes, or deterministic refactors`。原生 Skill 身份预算由 1100 字符重校准为 1300：英文 description 同等信息量下字符数更高但 token 占用更低（1300 英文字符约 330 token，原中文 1100 字符约 625 token），预算意图是上下文经济性而非字符数本身。skills/ 与 .agents/skills/ 双份同步；manifest-schema 测试新增真实包全英文断言与混写/分裂/全中文三类构造用例。
- 红区三清单修齐并新增交叉校验（安全语义）：RED_ZONE_PATTERNS 移除从未生效的 `.gemini/` 死正则（gemini 安装面仅含 `.gemini/skills/` 技能内容，runtime 清单与 redZonePrefixes 均无 `.gemini/`），补入 `vibe-harness.config.json`、`.vibe-harness/install-state.json` 与 `.agents/runtime/hooks/` 三个控制面模式；install map 的 8 条 `.agents/runtime/hooks/**` 条目补标 redZone。行为变化：含 hooks 组的安装（尤其 gemini full，此前因无任何红区条目可免确认写入 runtime hook 脚本）现在统一要求 `--confirm-red-zone`。新增 `validateRedZoneConsistency` 三向校验（安装目标命中运行时红区必须被门禁 / 运行时路径必须有安装期门禁 / 正则条目必须覆盖至少一条真实路径，防死正则再积累），接入 `pnpm check`；新增 `tests/red-zone-consistency.test.js` 覆盖三类漂移回归。`.githooks/` 不在运行时清单的观察记入 TECH_DEBT（TD-2026-09-02-1）。
- 跨文件规范重复收敛 4 组（rules/ 与 docs/rules/ 双份同步）：git credential helper 由 git-rules 保留完整定义、linear-workflow 改引用；Envelope mode/effect 枚举统一措辞并为 git-rules 的领域性缺项（linearWrite）补互见；checkpoint 字段清单由 governance-core 保留完整、linear-workflow 改引用式并保留其 Git/PR/MR 状态核对特有内容；writeScope 路径验证由 ai-collab-rules 保留完整定义、linear-workflow 保留 Linear 投影特有部分。
- governance-core 默认循环的 1039 字符巨型单段拆为三个编号子项（直接执行与最小改动 / 拆分判定 / Envelope 模式与枚举），原句文本逐字保留；措辞锁定收敛为「同一句规则文本只被一个测试文件锁定」：rules-depth 保持权威存在性断言，execution-simplification、linear-workflow、mvp-spec、project-profile 中重复的中文措辞断言删除或改为结构性断言。
- 测试断言与套件对齐：canary 套件断言对齐实际状态（risk 允许 critical/high 且 critical 占比 ≥ 80%，workflowDemand 对齐套件 7 项排序）；删除 linear-workflow.test.js 中断言 `.github/workflows/hotfix-back-sync.yml` 的死测试块（该文件在全部 git 历史从未存在）；上轮审查遗留项（hotfix-back-sync、负载敏感 flaky、并行度标准、reference 更新流程）记入 TECH_DEBT。
- 修复 Windows 上 `vibe-harness verify` 执行 pnpm/npm/yarn 验证命令的 EINVAL 失败：.cmd 垫片统一经 `cmd.exe /c` 启动（对齐 git-hook 既有模式），并新增 Windows 回归测试。
- 行为正确性修复：install 增加未知选项白名单并在 usage 补 `--provision`；删除 rollback/uninstall/provision 三处不可达的重复 target 检查；diff/rollback/uninstall/baseline 输出统一经公共报告脱敏（绝对路径不再进入 stdout）；单 target uninstall 部分失败时 remainingState 同步移除该 target 并写入 configUpdate；install 对全部所选 adapter 的指令模板渲染做校验（此前仅第一个）。
- 规范对齐：governance-core 的失败绕过条款升级为「降低断言、删除断言或无理由跳过相关测试」与 test-rules 同精度（双份同步）；AGENTS.md 已安装表面补记 browser-verification integration Skill。
- 流程提速：test:integration 由串行改为 --test-concurrency=2（26 个测试文件经并行安全审计：动态端口、pid 隔离 npm cache、mkdtemp 临时目录、文件级子进程隔离），全量实测 1691s/1521s（两次并发运行），较串行基线 4288s 提速约 2.5–2.8×；validate 等命令向 diffMultiTargetInstall 传入已构建安装计划消除二次全量规划；pack 静态 manifest/schemas/install-map 读取改经 readPackJson 进程级缓存（目标项目可变状态保持直读，避免同进程读改写污染）；多 target 规划改 Promise.all 并行；Hook bootstrap 定位的 git root 经环境变量传递给 hook，消除每次 guarded 工具调用的重复 git 子进程。
- 测试规则按社区实践补强：失败不得通过降低断言、删除断言或无理由跳过相关测试绕过；快照/golden baseline 与 Eval reference 统一「更新须单独审查显式确认」；新增覆盖率是诊断信号不是目标、缺陷修复先写复现测试、flaky 隔离限期修复（轮询替代 sleep）、断言行为而非实现细节且不引入仅测试使用的辅助路径；eval:replay 表述修正为契约重放（contract-replay，不执行当前 Agent 规则、Skill 或 Hook），eval:behavioral 变异验证写入测试与 Eval 边界节；关键句同步纳入 rules-depth 机器锁定。
- `pnpm test` 改为按序聚合 test:unit、test:eval、test:integration，修正原先以并发 4、超时 30 秒运行含集成测试全部文件的问题；managed-json-config、execution-observer-parity 纳入 test:unit，safety-posture 纳入 test:integration，消除三个脱离 CI 的测试文件；AGENTS.md 与 CONTRIBUTING.md 验证矩阵补充 `pnpm test:eval`。
- 执行内核默认循环新增计划拆分判定：计划完成后不默认直接执行也不默认拆分，先按硬触发（契约/schema/数据模型迁移、混合重构与行为修改、单次上下文装不下或单 Agent 无法稳定完成）加软信号计数（多模块、前后依赖、可并行、多验收阶段、多层测试）两级判定，0–1 项直接执行、2–3 项拆分、4 项及以上必须拆分并声明依赖；实施任务须可独立执行、独立验证、独立提交，操作步骤不得作为任务。
- 任务模板（中英文）新增可选「实施任务拆分」表；canary 套件升级至 2.8.0，新增 EVAL-SPLIT-001..003 覆盖直接执行、硬触发拆分与必须拆分带依赖三档判定；capability 目录注册 plan-task-split。
- 新增第八个正式 target OpenCode：共享根 AGENTS.md 受管块，安装原生 .opencode/skills，支持完整项目生命周期和项目级 MCP；不安装 OpenCode plugin Hook，并显式报告 DEGRADED_SAFETY_POSTURE。
- OpenCode 项目配置确定性选择 opencode.json 或 opencode.jsonc，使用固定 jsonc-parser 3.3.1 保留注释、尾逗号、格式和用户键；只管理 mcp.vibe-harness-*，并将两种配置文件纳入安装与运行时红区。

- Breaking change：项目配置升级为非空 targets 数组，install-state 升级为 stateVersion 5 并记录 shared 与 adapter 所有权；旧 target/state v4 仅在标准 upgrade write 事务中持久化迁移。
- 新增 Codex、Claude Code、Gemini CLI、Cursor、Qoder、ZCode 和 Antigravity 的单项目多宿主安装；公共 runtime、memory、Eval、工具 provisioning 与项目根索引只维护一份。
- 新增目标级卸载、all-targets 完整卸载、stale projection 报告、嵌套旧安装 doctor 检测，以及逐宿主 stable、preview、unsupported、skipped 和 conflict 状态。
- Antigravity rules、Skills 和 MCP 进入 stable；Hooks、sandbox 和 memory 保持 preview，Hook 协议支持 camelCase 输入、四种 decision 和高风险 fail-closed。

- **Breaking change**：产品更名为 Vibe-Harness。主 CLI、npm 包、配置文件、状态目录、环境变量和受管标记分别改为 `vibe-harness`、`@jw/vibe-harness`、`vibe-harness.config.json`、`.vibe-harness`、`VIBE_HARNESS_*` 和 `VIBE_HARNESS` 。
- **Breaking change**：旧品牌资产不提供兼容或迁移；检测到旧配置、状态目录或受管标记时以 `VIBE_HARNESS_LEGACY_UNSUPPORTED` 拒绝执行。
- **Breaking change**：删除治理链配置、CLI workflow 参数、任务 schema/runtime、审查角色、收据、完成门禁和对应 Hook 事件；旧配置以 `VIBE_HARNESS_OBSOLETE_GOVERNANCE_CONFIG` 只读拒绝。
- 默认执行统一为“获取事实 → 直接执行 → 聚焦验证 → 简洁交付”；风险档位只影响审批和验证范围。
- `vibe-harness verify` 顺序执行可选 `lint`、`typecheck`、`test`、`eval`；`validate` 只检查安装一致性。
- `full` 重定义为全部领域 Skills、可选 Eval 和 Codex 安全 Hook；Codex Hook 只保留 `PreToolUse` 与 `PermissionRequest`。
- 升级器会安全退役新计划不再包含的旧受管文件，并精确清理旧运行状态而保留其他 `.vibe-harness` 数据。
- `pnpm check` 收敛为 lint、pack/catalog 静态校验和快速产品单测；integration、lifecycle 与在线 Eval 保持显式命令。
- 新增显式 `--plugin` 安装面：`core` 与 `full` 默认均不安装外部工具；`-all`、单选、多选和 `none` 分别管理 RTK、ast-grep、codebase-memory-mcp、Chrome DevTools MCP、Playwright CLI 与 Open Code Review 共 6 个插件，并将规范化选择持久化到 install-state。Agentmemory runtime 因上游 High 漏洞暂停提供，不通过 `--plugin` 安装。
- 新增项目内 RTK `v0.43.0` 与 `@ast-grep/cli@0.44.1`：提供命令输出压缩、结构化搜索规则、checksum/lockfile 校验、doctor 状态和安全回退。
- docs(readme)：默认 README 改为中文（根 `README.md` 渲染中文），英文版移至 `README.en.md`，并删除 `README.zh-CN.md`；同步更新 `validateReadmeParity` 签名与错误标签、`manifests/capabilities.json` 文档清单、`docs/catalog.json` 条目以及 `docs/README.md` 链接。

## 0.5.0 - 2026-07-18

- 产品正式命名为 Cognis（智序，旧称 LoopEngine），package、主 CLI、配置、活动 runtime、Skill、评测及产物统一使用 Cognis 命名。
- 新增渐进兼容层：旧 CLI、配置、状态根、受管标记和环境变量继续可读；`install --upgrade` 以事务方式迁移配置并退休未修改的旧品牌资产。
- install state 升级为 stateVersion 4，记录 `product` 与 `storageNamespace`；旧安装升级后保留 `.loopengine/` 状态根，支持 recover、rollback 和 uninstall。
- 新增旧品牌 allowlist 审计，旧名称仅允许存在于兼容实现、迁移说明、兼容测试、归档和审计记录。

- 加固 Codex Hook 的破坏性 Git 与跨平台全局配置策略，Stop validator 缺失改为 unavailable，交付解析忽略示例和占位内容。
- 能力目录升级为 schemaVersion 2，Eval 变更门禁要求 capability 与 suite 精确匹配；online canary 增加隔离 HOME 配置写观测和连续 degraded 告警。
- 新增 `runtime:audit`，按真实 provision 参数阻断 Critical/High；`skills:audit` 改为真实 Skill 图审计，lint 覆盖所有分发脚本，CI 增加 Windows required matrix。
- 新增文档 Catalog、历史归档索引和 `docs:audit` 机械校验，并将文档漂移门禁接入 `pnpm check`。
- 将常驻治理收敛为“获取事实 → 做出决策 → 执行 → 验证 → 交付”，删除独立 workflows catalog 和重复生命周期规则。
- 任务真值改为中文 Markdown；完整档位使用中文 JSON 控制块和独立核验门禁。
- 新增 `using-cognis` router，模板随 skill 渐进披露；minimal/docs-only 使用短治理内核降级。
- 统一所有项目命令为 `--project` + `--write`；移除 `--apply`、路径型 `--target`、`codex-internal` 和 `codex-minimal`，旧 install-state 在标准升级时归一。
- task schema 和 full governance validator 增加 AC-ID、验收证据、责任人、确认状态、artifact 存在性和可声明时间盒门禁。
- Review Packet 对未修复的 Medium finding 强制要求有 owner、关闭条件和批准者的结构化延期。
- 完整档位任务新增 Red Team 完成门禁、结构化审查包和独立审查者校验；该能力随 core profile 安装，旧开放任务在完成前迁移。
- 新增 `cognis verify --project`，显式执行目标项目配置的验证命令，同时保持 `validate --project` 只读。
- 新增 `cognis baseline --project`，在安装后生成可比较的 JSON 快照和 Markdown 工作流建议，并支持可选验证与受管回滚。
- 新增 Failure、Retrospective 模板、core/full smoke script 和 GitHub Actions CI。
- Chrome DevTools MCP 新增为项目内受管工具：`full` 和显式 `chrome-devtools` 模块固定安装 `chrome-devtools-mcp@1.6.0`，以系统 Chrome 的无头隔离模式执行 console、network、Lighthouse 和 performance 诊断；`browser-verification` 使用“DevTools 定位、Playwright 回归”，两者不可用时再回退人工浏览器步骤。
- `codebase-memory-mcp` 安装改用稳定 flags 执行 moderate 索引，并以项目根目录匹配的 `index_status` ready 结果作为工具就绪门禁。
- 将六个 Agentmemory 薄 skill 收敛为单一入口和按需 references；升级器新增显式、hash 保护且可回滚的旧入口退役动作。
- 删除八个重复或薄包装 skill；OCR、契约、前端实现、任务拆解和交接职责并入 canonical skill 或规则，core/full skill 数量收敛为 13/18。

## 0.3.0

- 新增机器可校验的治理能力覆盖矩阵。
- 新增安装到目标项目的零依赖 basic/full 治理校验器和 Packet 校验器。
- task schema 增加恢复、阻塞、档位升级、verifier 和结构化跨仓证据字段。
- lint/typecheck 配置改为可选，`validate --project` 静态报告命令可用性且不执行用户命令。
- 深化通用治理规则并移除悬空来源引用。

## 0.2.0

- 新增 `.loopengine/install-state.json` 安装状态记录。
- 新增 `loopengine diff`、`install --upgrade` 和 `loopengine rollback`。
- 新增 MVP 项目模式：`loopengine init --project`、`install --project <path> --target codex --profile minimal|core|full --write`、`validate --project`。
- 新增 `loopengine.config.json`、Codex `AGENTS.md` 模板渲染和 `minimal` / `core` / `full` profiles。
- `validate --project` 现在会检查目标项目已安装文件是否与所选 profile 匹配。
- MVP `AGENTS.md` 安装改为受管块更新：保留目标项目原有内容，不默认修改 Node / pnpm 元文件。
- CLI 运行时错误改为结构化 JSON 输出，避免暴露 Node stack trace。
- Pack validation 接入 JSON Schema 校验，避免 schema 文件仅作为静态摆设。
- 强制覆盖或升级前生成目标项目本地备份。
- 回滚红区文件时要求显式 `--confirm-red-zone`。

## 0.1.0

- 初始化 Codex 优先的内部治理包。
- 新增规则、模板、核心 skills、workflows、manifests、Codex adapter、dry-run 安装器、校验器、测试和示例。
- 收口 CLI 语义：默认 dry-run，真实写入使用 `--apply`，红区写入使用 `--confirm-red-zone`。
- 新增目标项目安装状态校验、manifest/install-map 结构校验和发布前 smoke 检查说明。
