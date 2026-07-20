# Cognis 架构说明

Cognis 是跨平台、Codex 完整能力优先的可复用 AI coding governance 包。运行时使用 Node.js ESM、JSON manifests、Markdown 治理资产和文件复制式安装器。

## 子系统

- `rules/`：`governance-core` 是五步循环、风险和证据的唯一流程真值；其余文件只保存工程专项约束。
- `templates/`：无 Skill 环境使用的中文任务和交付模板；专项模板与对应 skill 共置。
- `skills/`：`using-cognis` 负责路由，canonical skills 按需提供规格、计划、实现、验证、审查和恢复流程。
- `runtime/governance/`：将中英文 Markdown 视图解析为语言无关 TaskDocument IR，再校验 AC-ID、完成证据、完整流程控制块、跨文档任务图和结构化 Red Team 审查包。
- `runtime/hooks/`：规范化 Codex 事件并执行可移植的安全、上下文和完成策略。
- `runtime/evals/`：提供项目内离线评测 runtime 和 full 使用的 Codex 在线 runner；runner 只在一次性项目中执行。
- `runtime/tools/`：固定版本的项目内工具 bootstrap；稳定 full 默认 provision 四个工具，Agentmemory 在风险接受前保持 opt-in preview。
- `scripts/lib/project-baseline.js`：汇总项目画像、安装状态、验证摘要、drift 和后续工作流，生成受管 JSON/Markdown 基线。
- `adapters/codex/`：包含精简 AGENTS 模板、共享 install map 和官方 PascalCase Codex hook 配置。
- `adapters/claude/`、`adapters/gemini/`：包含项目级 `CLAUDE.md` / `GEMINI.md` 模板；Skills target 由 adapter catalog 转换。
- `adapters/git/`：包含默认不启用的版本化 pre-commit / pre-push 入口。
- `manifests/`：rules、skills、profiles 和 adapters 的 catalog 真值；`profiles.json` 是能力组唯一来源，`adapters.json` 只声明平台安装面与能力边界。
- `schemas/`：manifest、完整流程中文控制块和 suite/run/reference 评测 schema。

## 安装流程

1. `cognis init --project <path> --target <codex|claude|gemini>` 创建项目配置。
2. `cognis install --project <path> --target <adapter> --profile <profile> --dry-run` 只预览；CLI target 与配置不一致时拒绝执行。
3. 所有 profile 使用 `--write` 事务性写入；Codex full 写入红区另需 `--confirm-red-zone`。事务按 preflight、journal、preimage、apply、state v3 commit 顺序执行。
4. `cognis provision --project <path> --profile <profile>` 独立预览工具；只有 `--write` 才执行。`install --provision` 是兼容的一站式入口。
5. 中断事务由 `cognis recover --project <path>` 预览，显式 `--write` 才逆序恢复；`doctor` 只读报告锁和 journal。
6. 工具子进程使用 allowlist 环境与独立进程组；SIGINT、SIGTERM、超时和输出上限都会先清理进程树。失败诊断脱敏后写入工具状态。
7. `cognis validate --project <path>` 校验安装一致性和组件状态，不执行目标项目命令。
8. `cognis eval check|run|reference --project <path>` 校验、执行和显式批准评测 reference。
9. `cognis baseline --project <path>` 默认预览双层基线；`--write` 建档，`--verify` 才顺序执行 governance、lint、typecheck 和 eval。
10. `cognis verify --project <path>` 顺序执行 governance、lint、typecheck 和 eval。

Open Code Review 的运行配置解析顺序固定为完整 `OCR_LLM_*` 环境变量、用户级 Open Code Review active provider、Anthropic/OpenAI 兼容环境变量、Codex provider TOML。解析后的 endpoint、model、protocol 和 token 只存在于子进程环境；项目配置、MCP 受管块和工具状态不保存凭据。codebase-memory 则把项目根作为 `CBM_ALLOWED_ROOT` 和 cwd，根索引统一使用 `--repo-path .`，并用 `index_status` 二次确认根路径、状态以及 nodes/edges。路径越界和损坏缓存分别使用 `INDEX_PATH_OUTSIDE_ALLOWED_ROOT` 与 `INDEX_CORRUPT_REINDEX_REQUIRED`，后者会在下一次 provision 中自动重建受管缓存。

Chrome DevTools MCP 固定为项目内 `chrome-devtools-mcp@1.6.0`，只调用 lockfile 对应的本地入口。wrapper 以系统 Google Chrome 的无头隔离模式运行，固定关闭遥测、更新检查和 CrUX，脱敏 network header，不接入个人 profile、远程调试端口或任意外部路径。依赖 lockfile 未变化时可复用安装，但每次真实 provision 都通过 `list_pages` 重跑浏览器 smoke；Chrome 启动失败稳定映射为 `CHROME_LAUNCH_FAILED`。子进程环境使用系统启动变量 allowlist，不继承 token、云凭据或带凭据代理；工具状态只保存版本、阶段、时间和脱敏诊断，不保存页面、header、响应体或原始环境。

默认 JSON 是稳定、紧凑的机器接口，preview 只含 hash、字节数和摘要；`--verbose` 才含完整正文和绝对诊断路径，`--output summary` 输出短报告和工具降级原因。工具诊断会脱敏项目路径与凭据，仅保存限长尾部。install、validate、doctor 共用 `ready=0`、`invalid=1`、`degraded=2` 健康合同；未执行 provisioning 的 `pending`/`pending-config` 只产生告警，已尝试 provisioning 的失败或未完成进程标记才进入 degraded。`--allow-degraded` 只覆盖退出码，不改变报告状态。

## Adapter 边界

- Codex：`AGENTS.md`、`.agents/skills/`、项目 `.codex/config.toml` 与 `.codex/hooks.json`，支持全部 profiles。
- Claude Code：`CLAUDE.md`、`.claude/skills/`；`minimal/core/docs-only` stable，full 能力映射为 preview。
- Gemini CLI：`GEMINI.md`、`.gemini/skills/`；`minimal/core/docs-only` stable，full 能力映射为 preview。
- adapter capability v2 使用 `unsupported/preview/stable` 描述 instructions、skills、hooks、policy、MCP、sandbox、memory 和 plugin；preview full 必须显式 `--allow-preview`，且不写用户级配置。

install state 记录 adapter；缺少该字段的 schemaVersion 1 状态按 Codex 读取。三种入口都只更新 `COGNIS` 受管块，upgrade/uninstall 必须与原 adapter 一致。

## 基线数据流

baseline 先复用项目 profile 探测、安装一致性、命令状态和工具状态，再生成 `.cognis/baseline.json` 与 `docs/cognis/PROJECT_BASELINE.md`。JSON 是 schemaVersion 1 的机器合同，Markdown 是派生的人读报告；两者登记到 install-state `generatedFiles`，重复运行只覆盖 hash 仍匹配的受管文件，项目重新安装时保留未修改的登记。

drift 只比较项目画像、安装摘要、工具和验证状态，排除生成时间。持久化内容不包含绝对路径、源码、凭据或命令 stdout/stderr；工作流只引用当前 profile 实际安装的 skills。

evaluation reference 与项目 baseline 分离。reference 只保存批准的 fingerprint 和聚合分数；run 保存在 `.cognis/evals/runs/`，只有显式 `--write` 才落盘。

## Profile

- minimal：最小安装，包含平台入口、治理内核、Git/VCS/Test 规则和默认 v2 中文 task/delivery 模板，不安装 skills、runtime、hook 或 MCP 安装面。
- core：通用安装，在 minimal 上增加专项规则、v1/v2 任务 runtime/schema、跨文档任务图 validator、`using-cognis` 和 inline fallback skills；不安装 hook、`codebase-memory-mcp` 或 agentmemory MCP 安装面。
- full：全安装，在 core 上增加多 Agent 执行 Skill、五个项目内工具 runtime、经 `index_status` 验证的 codebase 初始索引、三个 MCP 注册、agentmemory skill、`.agents/memory/` 本地回退库和 Codex hooks；其中 Chrome DevTools MCP 使用受管项目配置和无头隔离 smoke，稳定 provision 排除 Agentmemory，显式 `--allow-preview` 后才能安装该依赖面，真实写入红区仍需确认。
- docs-only：仅安装平台入口、治理内核、专项规则、v2 中文模板、memory 文档和 schema，不安装 runtime、Skills、MCP 或 hooks。

## 中文任务数据流

人工只维护 `docs/tasks/<任务编号>.md`。无 `控制版本` 的控制块按 v1 读取；新模板默认 v2。`language` 支持 `zh-CN` 与 `en-US`；两种 Markdown 视图都归一为 schemaVersion 1 TaskDocument IR，状态、阶段和结果使用语言无关枚举。validator 先逐文档校验控制块、证据覆盖、人工确认、独立核验和 merge-back，再校验 v2 父子双向关系、扁平 DAG、批次、依赖、冲突和写入范围重叠。

只有父 Agent 能派发并维护任务文档。child 使用最小上下文，不能再委派，只返回固定结构化结果；父 Agent 在 fan-in 时核对实际 diff 与证据、持久化状态，并在目标工作区执行集成验证。`doctor` 默认只汇总 v1/v2 数量，`--verbose` 才显示 legacy 路径。

## 安全模型

- 安装器不写全局 Agent 配置，不默认覆盖目标项目文件。
- 所有项目写路径使用 realpath 与逐段 lstat 校验，拒绝 symlink、junction 和 reparse-point 穿越。
- install 使用项目内独占事务锁和 preimage；状态只在文件全部成功后以 stateVersion 3 提交。
- MCP 只写项目 `.codex/config.toml` 的受管块；第三方输出和凭据不进入状态文件。
- 安装器不修改 `.git/config`；Git hooks 只能由用户显式设置本仓库 `core.hooksPath` 后启用。
- AGENTS 使用受管块更新；其他冲突文件只有 `--force` 才备份并覆盖。
- baseline 默认 dry-run；未登记或 hash 已变化的档案只有 `--force` 备份后才能覆盖。
- reusable 目录不得包含源项目标识、业务契约、个人路径或具体任务编号。
- 红区、不可逆操作和高风险最终批准保留人工或独立核验门禁。
