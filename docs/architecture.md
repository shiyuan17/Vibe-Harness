# LoopEngine 架构说明

LoopEngine 是 Codex 优先的可复用 AI coding governance 包。运行时使用 Node.js ESM、JSON manifests、Markdown 治理资产和文件复制式安装器。

## 子系统

- `rules/`：`governance-core` 是五步循环、风险和证据的唯一流程真值；其余文件只保存工程专项约束。
- `templates/`：无 Skill 环境使用的中文任务和交付模板；专项模板与对应 skill 共置。
- `skills/`：`using-loopengine` 负责路由，canonical skills 按需提供规格、计划、实现、验证、审查和恢复流程。
- `runtime/governance/`：解析 `docs/tasks/*.md`，校验中文字段、AC-ID、完成证据和完整流程控制块。
- `adapters/codex/`：包含精简 AGENTS 模板、install map 和 legacy/internal hooks。
- `manifests/`：rules、skills 和 profiles 的 catalog 真值；不再维护 workflow catalog。
- `schemas/`：manifest schema 和完整流程中文控制块 schema。

## 安装流程

1. `loopengine init --project <path>` 创建项目配置。
2. `loopengine install --project <path> --target codex --profile <profile> --dry-run` 只预览。
3. MVP 使用 `--write` 写入；legacy/internal 使用 `--apply --confirm-red-zone`。
4. `loopengine validate --project <path>` 校验安装一致性，不执行目标项目命令。
5. `loopengine verify --project <path>` 顺序执行 governance、lint 和 typecheck。

## Profile

- minimal：最小安装，包含 AGENTS、治理内核、Git/Test 规则和中文 task/delivery 模板，不安装 skills、runtime、hook 或 MCP 安装面。
- core：通用安装，在 minimal 上增加专项规则、中文任务 runtime/schema、`using-loopengine` 和常规 skills；不安装 hook、`codebase-memory-mcp` 或 agentmemory MCP 安装面。
- full：全安装，在 core 上增加 `codebase-memory-mcp`、agentmemory skill 家族、`.agents/memory/` 本地回退库和 Codex hooks；真实写入 hooks 需要红区确认。
- codex-internal：兼容全安装入口，等同 full，并保留 legacy/internal 生命周期。
- docs-only：仅安装治理内核、专项规则、中文模板、memory 文档和 schema。

## 中文任务数据流

人工只维护 `docs/tasks/<任务编号>.md`。所有任务使用中文元数据、AC-ID 表格和验证计划；完整档位额外嵌入中文 JSON 控制块。validator 从 Markdown 解析公共合同，再用 schema 校验控制块，并在完成状态核对证据覆盖、人工确认、独立核验和 merge-back。

## 安全模型

- 安装器不写全局 Agent 配置，不默认覆盖目标项目文件。
- AGENTS 使用受管块更新；其他冲突文件只有 `--force` 才备份并覆盖。
- reusable 目录不得包含源项目标识、业务契约、个人路径或具体任务编号。
- 红区、不可逆操作和高风险最终批准保留人工或独立核验门禁。
