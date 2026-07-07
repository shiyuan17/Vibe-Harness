# LoopEngine 架构说明

LoopEngine 是一套 Codex 优先的可复用 AI coding governance 包。MVP 保持运行时足够轻：使用 Node.js ESM 脚本、JSON manifests、Markdown 规则包，以及带确定性渲染能力的文件复制式安装器。

## 子系统

- `rules/`：可复用 governance 规则。minimal 包含入口红线、CodeGraph 和 `session-protocol`；core 覆盖工程实现、任务、Workflow、Git、API、前端、日志管理与协作边界；full 补充 release、Pencil、task-management、troubleshooting、review 和 loop。这里不得包含项目专属名称、业务契约、本地端口、任务编号或源项目当前状态。
- `templates/`：可复用生命周期产物模板，包括 task intake、spec、plan、handoff、review packet 和 workflow packet。
- `skills/`：轻量 `SKILL.md` 包，用来把 Agent 路由到既有 workflow。`skills/core` 提供治理和专项检查，`skills/integrations` 提供 agentmemory / review / browser 等可选集成。Skills 只补强规则，不覆盖目标项目的 `AGENTS.md`。
- `workflows/`：profile 级交付流程，覆盖 Fast Path、Lightweight、Full、Review 和 Loop opt-in 场景。
- `adapters/codex/`：Codex 安装表面，包括可渲染的 `AGENTS.md` 模板和 install map。
- `manifests/`：catalog 与 profile 的真值来源。MVP 对外 profile 是 `minimal`、`core` 和 `full`；旧 profile 继续保留用于内部兼容。
- `scripts/`：CLI、安装计划器、状态/回滚处理、pack validation、项目配置校验和模板渲染。

## 安装流程

1. `loopengine init --project <path>` 写入 `loopengine.config.json`。
2. `loopengine install --project <path> --target codex --profile <profile> --dry-run` 渲染预览内容，不写入文件。
3. `loopengine install --project <path> --target codex --profile <profile> --write` 渲染并写入文件；如果目标文件已存在，默认拒绝覆盖；只有显式使用 `--force` 时才会先备份到 `.loopengine/backups/` 再覆盖。
4. `loopengine validate --project <path>` 校验配置结构、生成内容的必需红线、目标文件安装一致性、源项目专属标识和 pack 有效性。

旧安装命令 `--target <project-path> --profile codex-internal --apply` 继续保留，用于兼容已有使用方。

## CodeGraph 集成

- `loopengine codegraph install-cli [--dry-run] [--version <version>]` 是唯一会尝试安装 CodeGraph CLI 的入口；默认执行全局 npm 安装，安装后用 `codegraph --version` 验证。
- `loopengine codegraph status [--target <path>]` 只检查 CLI 是否可用、版本号和目标项目是否存在 `.codegraph/`，不会创建索引。
- `doctor` 会输出 `codegraph` 状态，但 CLI 缺失不使 doctor 失败。
- `rules/codegraph.md` 作为最小规则安装到 `docs/rules/codegraph.md`，只指导 Agent 在目标仓库已有 `.codegraph/` 时优先使用 CodeGraph；MCP 配置仅提示 `codegraph install --print-config codex`，LoopEngine 不写全局 Agent 配置。

## 深化规则与 Skills

- `session-protocol` 是入口级协议，定义每次会话开始前的任务确认、工作区事实、风险档位和验证计划，以及每次会话结束时必须输出的摘要、影响、验证、风险、Git / worktree / merge-back 状态和后续动作。
- `core` profile 安装 coding、frontend、API、log-management、AI collaboration、project directory、task lifecycle 与 skill routing 规则，并安装完整 bundled skills，包括 workflow、API/interface、TDD、debugging、verification、review、browser 和 agentmemory 能力。
- `full` profile 在 core 基础上安装 DB、release、Pencil、task management、troubleshooting、review、loop 规则与扩展 workflow；skills 不再依赖外部包。
- `handoff-rules` 是恢复型交接协议，适用于暂停、转交、未完成、阻塞或需要下一位执行者恢复的场景；`handoff` 名称保留给 agentmemory 恢复会话，治理交接模板使用 `workflow-handoff`。

## 安全模型

- 安装器不会写入全局 Agent 配置。
- MVP 的 `minimal`、`core` 和 `full` profile 不安装 Codex hooks；带 hooks 的内部 profile 仍然需要显式红区确认。
- MVP `--write` 默认拒绝覆盖已有目标文件；`--force` 覆盖前会备份已有目标文件。
- Pack validation 会拒绝 reusable core 目录中的源项目专属标识。
- 生成的 `AGENTS.md` 必须包含 git status、红区确认、验证证据和 Workflow Packet 指引。
