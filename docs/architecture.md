# LoopEngine 架构说明

LoopEngine 是 Codex 优先的可复用 AI coding governance 包。运行时使用 Node.js ESM、JSON manifests、Markdown 治理资产和文件复制式安装器。

## 子系统

- `rules/`：`governance-core` 是五步循环、风险和证据的唯一流程真值；其余文件只保存工程专项约束。
- `templates/`：无 Skill 环境使用的中文任务和交付模板；专项模板与对应 skill 共置。
- `skills/`：`using-loopengine` 负责路由，canonical skills 按需提供规格、计划、实现、验证、审查和恢复流程。
- `runtime/governance/`：解析 `docs/tasks/*.md`，校验中文字段、AC-ID、完成证据和完整流程控制块。
- `runtime/hooks/`：规范化 Codex 事件并执行可移植的安全、上下文和完成策略。
- `runtime/tools/`：四个固定版本的项目内工具 bootstrap；full/internal 由统一 provisioner 安装、初始化和检查。
- `scripts/lib/project-baseline.js`：汇总项目画像、安装状态、验证摘要、drift 和后续工作流，生成受管 JSON/Markdown 基线。
- `adapters/codex/`：包含精简 AGENTS 模板、install map 和官方 PascalCase Codex hook 配置。
- `adapters/git/`：包含默认不启用的版本化 pre-commit / pre-push 入口。
- `manifests/`：rules、skills 和 profiles 的 catalog 真值；不再维护 workflow catalog。
- `schemas/`：manifest schema 和完整流程中文控制块 schema。

## 安装流程

1. `loopengine init --project <path>` 创建项目配置。
2. `loopengine install --project <path> --target codex --profile <profile> --dry-run` 只预览。
3. MVP 使用 `--write` 写入；legacy/internal 使用 `--apply --confirm-red-zone`。
4. full/internal 写入完成后初始化四组件；失败记录为 degraded 并继续其他组件。
5. `loopengine validate --project <path>` 校验安装一致性和组件状态，不执行目标项目命令。
6. `loopengine baseline --project <path>` 默认预览双层基线；`--write` 建档，`--verify` 才顺序执行 governance、lint 和 typecheck。
7. `loopengine verify --project <path>` 顺序执行 governance、lint 和 typecheck。

## 基线数据流

baseline 先复用项目 profile 探测、安装一致性、命令状态和工具状态，再生成 `.loopengine/baseline.json` 与 `docs/loopengine/PROJECT_BASELINE.md`。JSON 是 schemaVersion 1 的机器合同，Markdown 是派生的人读报告；两者登记到 install-state `generatedFiles`，重复运行只覆盖 hash 仍匹配的受管文件，项目重新安装时保留未修改的登记。

drift 只比较项目画像、安装摘要、工具和验证状态，排除生成时间。持久化内容不包含绝对路径、源码、凭据或命令 stdout/stderr；工作流只引用当前 profile 实际安装的 skills。

## Profile

- minimal：最小安装，包含 AGENTS、治理内核、Git/Test 规则和中文 task/delivery 模板，不安装 skills、runtime、hook 或 MCP 安装面。
- core：通用安装，在 minimal 上增加专项规则、中文任务 runtime/schema、`using-loopengine` 和常规 skills；不安装 hook、`codebase-memory-mcp` 或 agentmemory MCP 安装面。
- full：全安装，在 core 上增加四个项目内工具 runtime、codebase 初始索引、两个 MCP 注册、agentmemory skill、`.agents/memory/` 本地回退库和 Codex hooks；真实写入红区需要确认。
- codex-internal：兼容全安装入口，等同 full，并保留 legacy/internal 生命周期。
- docs-only：仅安装治理内核、专项规则、中文模板、memory 文档和 schema。

## 中文任务数据流

人工只维护 `docs/tasks/<任务编号>.md`。所有任务使用中文元数据、AC-ID 表格和验证计划；完整档位额外嵌入中文 JSON 控制块。validator 从 Markdown 解析公共合同，再用 schema 校验控制块，并在完成状态核对证据覆盖、人工确认、独立核验和 merge-back。

## 安全模型

- 安装器不写全局 Agent 配置，不默认覆盖目标项目文件。
- MCP 只写项目 `.codex/config.toml` 的受管块；第三方输出和凭据不进入状态文件。
- 安装器不修改 `.git/config`；Git hooks 只能由用户显式设置本仓库 `core.hooksPath` 后启用。
- AGENTS 使用受管块更新；其他冲突文件只有 `--force` 才备份并覆盖。
- baseline 默认 dry-run；未登记或 hash 已变化的档案只有 `--force` 备份后才能覆盖。
- reusable 目录不得包含源项目标识、业务契约、个人路径或具体任务编号。
- 红区、不可逆操作和高风险最终批准保留人工或独立核验门禁。
