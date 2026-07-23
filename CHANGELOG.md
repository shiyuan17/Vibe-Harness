# 更新日志

## Unreleased

- 新项目默认启用 v0.8 `adaptive` 结果优先路径，既有缺失字段项目保持 `strict`；新增 `init --workflow`、workflow 报告、兼容升级写回和 baseline 观测。
- Codex adaptive Hook 收敛为 6 个事件，普通 Stop 不再运行全量治理/Eval；宿主按 description 直接选择单个聚焦 Skill，交付收敛为结果、实际变更和本轮验证。
- 原生 Skill 集全局收敛为 core 4 个、full 7 个；退休 Router 与计划/TDD/验证/Review/多 Agent 流程 Skill，新增影响分级澄清、Codex `agents/openai.yaml`、触发/近邻评测及 old/new/no-Skill 冻结基线。Browser 与 Agentmemory 改为显式集成。
- 新增 40 案例 × 3 次的 adaptive/strict 对照合同、12 案例 smoke 子集、配对非劣 bootstrap、critical 零回退和全部尝试每成功任务成本报告。
- 新增 v0.7 自适应单/多 Agent 编排：在风险档位之后按需求类型和 all-of 拆分门禁选择模式，简单任务固定单 Agent，复杂耦合任务串行，仅对独立、可验证且有真实平台能力的完整任务自动派发；保留 v2 合同、人工安全门禁和 fan-in 独立核验。
- 新增显式 `--plugin` 安装面：`core` 与 `full` 默认均不安装外部工具；`-all`、单选、多选和 `none` 分别管理 RTK、ast-grep、codebase-memory-mcp、Chrome DevTools MCP、Playwright CLI 与 Open Code Review，并将规范化选择持久化到 install-state。Agentmemory runtime 因上游 High 漏洞暂停提供，安全审计门禁保持不变。
- 新增项目内 RTK `v0.43.0` 与 `@ast-grep/cli@0.44.1`：提供命令输出压缩、结构化搜索规则、checksum/lockfile 校验、doctor 状态和安全回退。
- 新增 v0.6 父子任务多 Agent 治理合同：v1 保持可读，新模板默认 v2，跨文档 validator 校验扁平 DAG、批次、依赖、冲突和写入范围。
- `doctor` 新增非阻断 legacy task-contract 摘要；治理 Runtime 与 Codex Subagent hooks 提供最小上下文、禁止再委派和父 Agent fan-in 提醒，不宣称阻止 subagent 启动。
- 父任务完成前必须关闭 child 与 merge-back、记录目标工作区集成验证证据，并取得最终 diff 的独立 Red Team 批准。

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
- core 默认包含 Review 门禁；full 增加 task/backlog、durable memory 和 Pencil 配对检查。
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
- 深化 rules / skills：core 增加 coding、frontend、API、AI collaboration 等工程规则与专项 skills；full 增加 memory skills、release、Pencil、task-management 和 troubleshooting。
- 强制覆盖或升级前生成目标项目本地备份。
- 回滚红区文件时要求显式 `--confirm-red-zone`。

## 0.1.0

- 初始化 Codex 优先的内部治理包。
- 新增规则、模板、核心 skills、workflows、manifests、Codex adapter、dry-run 安装器、校验器、测试和示例。
- 收口 CLI 语义：默认 dry-run，真实写入使用 `--apply`，红区写入使用 `--confirm-red-zone`。
- 新增目标项目安装状态校验、manifest/install-map 结构校验和发布前 smoke 检查说明。
