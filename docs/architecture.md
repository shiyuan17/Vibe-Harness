# LoopEngine 架构说明

LoopEngine 是一套 Codex 优先的可复用 AI coding governance 包。MVP 保持运行时足够轻：使用 Node.js ESM 脚本、JSON manifests、Markdown 规则包，以及带确定性渲染能力的文件复制式安装器。

## 子系统

- `rules/`：可复用 governance 规则。这里不得包含项目专属名称、业务契约、本地端口、任务编号或源项目当前状态。
- `templates/`：可复用生命周期产物模板，包括 task intake、spec、plan、handoff、review packet 和 workflow packet。
- `skills/`：轻量 `SKILL.md` 包，用来把 Agent 路由到既有 workflow。Skills 只补强规则，不覆盖目标项目的 `AGENTS.md`。
- `workflows/`：profile 级交付流程，覆盖 Fast Path、Lightweight、Full、Review 和 Loop opt-in 场景。
- `adapters/codex/`：Codex 安装表面，包括可渲染的 `AGENTS.md` 模板和 install map。
- `manifests/`：catalog 与 profile 的真值来源。MVP 对外 profile 是 `minimal`、`core` 和 `full`；旧 profile 继续保留用于内部兼容。
- `scripts/`：CLI、安装计划器、状态/回滚处理、pack validation、项目配置校验和模板渲染。

## 安装流程

1. `loopengine init --project <path>` 写入 `loopengine.config.json`。
2. `loopengine install --project <path> --target codex --profile <profile> --dry-run` 渲染预览内容，不写入文件。
3. `loopengine install --project <path> --target codex --profile <profile> --write` 渲染并写入文件；如果目标文件已存在，会先备份到 `.loopengine/backups/`。
4. `loopengine validate --project <path>` 校验配置结构、生成内容的必需红线、源项目专属标识和 pack 有效性。

旧安装命令 `--target <project-path> --profile codex-internal --apply` 继续保留，用于兼容已有使用方。

## 安全模型

- 安装器不会写入全局 Agent 配置。
- MVP 的 `minimal`、`core` 和 `full` profile 不安装 Codex hooks；带 hooks 的内部 profile 仍然需要显式红区确认。
- MVP `--write` 写入前会备份已有目标文件。
- Pack validation 会拒绝 reusable core 目录中的源项目专属标识。
- 生成的 `AGENTS.md` 必须包含 git status、红区确认、验证证据和 Workflow Packet 指引。
