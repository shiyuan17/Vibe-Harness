# 更新日志

## Unreleased

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
