# Cognis

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/shiyuan17/Cognis/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/shiyuan17/Cognis/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20.19%2B-339933?logo=node.js&logoColor=white)](package.json)
[![pnpm](https://img.shields.io/badge/pnpm-10%2B-F69220?logo=pnpm&logoColor=white)](package.json)

**让 AI 不只会改代码，还能用证据说明任务真的完成了。**

Cognis 让 Codex、Claude Code 和 Gemini CLI 使用同一套规划、执行与验证方式。它把项目说明、任务校验、状态快照和可选工具组合起来，让 AI 能说明改了什么，以及怎样确认结果正确。所有内容都放在项目内，不会修改电脑上的全局 Agent 配置。

> [!IMPORTANT]
> Cognis 会先展示准备修改的内容，确认后才写入。除非使用 `--force`，否则它不会覆盖已有文件。修改 Codex 的敏感配置前，还会要求额外确认。

## 从常见问题到可验证结果

| 常见问题 | Cognis 怎么处理 | 用户得到什么 |
| --- | --- | --- |
| AI 还没有理解任务，就直接开始改代码。 | 使用五步工作流程，并按风险选择快速、轻量或完整档位。 | 简单任务可以快速完成；高风险任务会先给出方案和撤销办法。 |
| AI 只说“已经完成”，却没有提供依据。 | 任务模板用 `AC-ID` 连接每条验收标准和对应证据，validator（自动检查程序）会检查已完成任务。 | 可以用命令、产物、审查或人工确认逐项核对完成结果。 |
| 多个 Agent 覆盖共享修改，或直接采信彼此自报的测试。 | v2 父子任务合同定义扁平 DAG、写入范围、串并行批次、merge-back 状态和集成验证。 | 只有真正独立的 child 才并行；父 Agent 核对最终 diff，并在目标工作区重新运行检查。 |
| 重要的 coding 上下文被长段落淹没。 | `core`、`full` 和 `docs-only` 会为复杂请求和回复按内容选择 checkbox todo、列表、比较表格和跨平台信息块。 | 简单回答保持简洁，计划、进度、证据和决策更容易扫读，同时不改写代码或命令输出。 |
| Agent 规则或 Skill 改变后缺少行为回归证据。 | 使用 Eval-ID 场景把离线和真实 Agent 运行结果与批准的 evaluation reference 比较。 | 提示和治理变更不只比较文件，还能核对 critical 行为。 |
| 长任务跨会话后丢失重要上下文。 | `baseline` 记录项目、安装、工具和验证状态；项目记忆与交接模板保留决策和已知问题。 | 新会话可以直接读取项目事实，不必只靠聊天记录重新整理。 |
| 不同 AI 编程工具中的规则逐渐不一致。 | 为 Codex、Claude Code 和 Gemini CLI 提供原生项目文件和经过测试的安装级别（`profiles`）。 | 每个工具都能用自己支持的格式获得同一套核心工作规则。 |
| 安装或更新公共规则时担心覆盖项目文件。 | 提供 dry-run 预览、明确标记的内容区域、备份、校验、安全卸载和回滚。 | 写入前可以检查变化，也能撤销 Cognis 管理的内容而不影响项目其他文件。 |
| 代码理解、浏览器检查、审查和记忆工具分散在不同环境中。 | Codex `full` 会在项目内准备代码库索引、Playwright、Chrome DevTools MCP 和 Open Code Review；Agentmemory 在依赖风险解决前保持显式 preview。 | 常用工具跟随项目保存；工具不可用时会明确报告为 `degraded`。 |

## 为什么不只写一个 AGENTS.md

`AGENTS.md` 可以告诉 AI 应该怎样工作，但它本身不会安装有版本的规则和 skills，也不会校验任务证据、记录项目状态，或安全地更新和移除自己的文件。Cognis 把平台主说明文件作为入口，再补上这些检查和管理能力。你仍然可以自由编辑原有内容，因为 Cognis 只更新带有明确标记的那一段。

## 快速开始

需要 pnpm `10` 或更高版本，并安装以下任一 Node.js 版本：`20.19+`、`22.18+` 或 `24+`。

```bash
pnpm install
pnpm cognis init --project ../some-project --target codex
pnpm cognis install --project ../some-project --target codex --profile core --dry-run
pnpm cognis install --project ../some-project --target codex --profile core --write
pnpm cognis validate --project ../some-project
```

这些命令会依次完成四件事：

1. 在目标项目中创建 Cognis 配置文件。
2. 预览 Cognis 准备安装的文件。
3. 确认预览后，写入推荐的 `core` 安装内容。
4. 检查文件是否安装完整，内容是否仍然一致。

`install` 默认只写治理资产。项目内工具使用独立命令预览和安装：

```bash
pnpm cognis provision --project ../some-project --target codex --profile full --dry-run
pnpm cognis provision --project ../some-project --target codex --profile full --write
```

`install --provision` 保留一条命令完成两阶段的兼容路径。写入被中断时，`recover --project <project>` 只预览活跃事务，`recover --project <project> --write` 才恢复 preimage。

## 支持哪些 AI 编程工具

| 工具 | 项目主文件 | 可选安装级别 | Cognis 可以安装什么 |
| --- | --- | --- | --- |
| Codex | `AGENTS.md` | `minimal`、`core`、`full`、`docs-only` | 使用说明、skills、通过 MCP 接入的项目工具，以及通过 hooks 自动执行的检查 |
| Claude Code | `CLAUDE.md` | `minimal`、`core`、`docs-only`；`full` preview | 项目说明和 skills；实验性 full 映射需要 `--allow-preview` |
| Gemini CLI | `GEMINI.md` | `minimal`、`core`、`docs-only`；`full` preview | 项目说明和 skills；实验性 full 映射需要 `--allow-preview` |

MCP 让 AI 可以调用当前项目配套的工具；hooks 会在 AI 工作到特定阶段时自动运行检查。Cognis 目前只为 Codex 安装这两类能力。

Claude Code 与 Gemini CLI 的 `full` 默认被 preview 门禁阻止，只有显式使用 `--allow-preview` 才生成计划。报告会列出 preview 与缺失能力，不会把不完整映射标记为 stable。

## AI 会按什么步骤工作

```text
理解任务 -> 选择方案 -> 执行修改 -> 检查结果 -> 说明完成情况
```

| 流程 | 适用场景 | AI 至少要做到什么 |
| --- | --- | --- |
| 快速 | 阅读、文档和其他低风险任务 | 先确认事实，再给出清楚的结论和依据。 |
| 轻量 | 范围明确的小改动 | 修改前说明会动哪些文件，以及准备怎样检查结果。 |
| 完整 | 安全、发布、敏感配置、公开接口、跨层修改或多个 Agent 协作 | 先给出方案再修改，保留撤销办法，并在完成前取得独立 Red Team 审查包的“批准”结论。 |

无法确定风险时，使用完整流程。

多 Agent 工作仍为每个任务只维护一个 `docs/tasks/` 下的 Markdown。新任务使用控制版本 2；只有父 Agent 能派发 child 和更新任务状态，child 不得再次委派。`doctor` 会提示 legacy v1 父子合同但不会把它们判为无效，只有 `--verbose` 才显示待迁移路径。

## 选择安装级别

安装级别在命令和配置中叫作 `profile`。每个 profile 都是一组已经搭配好的 Cognis 文件和功能。

| Profile | 会安装什么 | 适合什么项目 |
| --- | --- | --- |
| `minimal` | Agent 主说明文件、硬边界、Git 与测试规则、v2 任务模板 | 只需要基本规则，不需要额外 skills 或工具的小项目 |
| `core` | `minimal` 的全部内容，加上常用工程规则、v1/v2 任务与任务图检查、Red Team 完成门禁、skills 路由和按需启动的 Playwright | 大多数项目，建议从这里开始 |
| `full` | `core` 的全部内容，加上多 Agent 执行 Skill、项目记忆、高级流程 skills、四个 stable 项目工具、preview Agentmemory 资产、Codex MCP 配置和 Codex hooks | 长期维护或风险较高的 Codex 项目 |
| `docs-only` | 使用说明、公共规则、v2 模板和 schemas，不安装可执行 runtime、skills、MCP 或 hooks | 只希望使用文档规则的项目 |
每个 profile 实际包含哪些文件，由 `manifests/profiles.json` 定义。

## 更多命令

<details>
<summary><strong>标准项目安装方式</strong></summary>

大多数用户都应该使用这种方式。`--project` 后面填写项目目录，`--target` 选择 AI 编程工具；查看预览并确认无误后，再使用 `--write` 写入。

```bash
# 创建项目配置
pnpm cognis init --project ../some-project --target codex

# 先预览，再安装
pnpm cognis install --project ../some-project --target codex --profile core --dry-run
pnpm cognis install --project ../some-project --target codex --profile core --write

# 检查安装内容是否仍然有效
pnpm cognis validate --project ../some-project
```

命令默认输出方便脚本读取的精简 JSON。需要更容易阅读的短报告时，添加 `--output summary`；需要查看完整文件预览和诊断路径时，添加 `--verbose`。

安装 Claude Code 或 Gemini CLI 时，`init` 和 `install` 必须使用相同的 target：

```bash
pnpm cognis init --project ../claude-project --target claude
pnpm cognis install --project ../claude-project --target claude --profile core --write

pnpm cognis init --project ../gemini-project --target gemini
pnpm cognis install --project ../gemini-project --target gemini --profile core --write
```

</details>

<details>
<summary><strong>项目设置</strong></summary>

大多数用户只需要在运行 `init` 后检查一次这个文件。Cognis 会创建 `cognis.config.json`，你可以在其中选择安装级别、填写项目检查命令，并标出需要谨慎修改的区域。

```json
{
  "projectName": "ExampleProject",
  "language": "zh-CN",
  "packageManager": "pnpm",
  "target": "codex",
  "profile": "core",
  "validationCommands": {
    "lint": null,
    "typecheck": null,
    "governance": "node .agents/cognis/governance/validate.mjs",
    "eval": null
  },
  "evaluations": {
    "enabled": false,
    "suites": [],
    "reference": "evals/references/project.json",
    "thresholds": { "criticalPassRate": 1, "overallScore": 0.9, "maxCapabilityRegression": 0.05 },
    "onlineRunner": null,
    "repetitions": 3
  },
  "governance": { "mode": "basic" },
  "hooks": {
    "mode": "guarded",
    "completionGate": "advisory"
  },
  "riskZones": {
    "red": ["auth", "global request layer", "ci/cd", "env"],
    "yellow": ["shared components", "stores", "routing", "request clients"]
  },
  "crossRepo": { "enabled": false, "backendRepo": "" },
  "projectRules": { "mode": "auto", "overrides": {} },
  "memory": { "enabled": true, "path": ".agents/memory" }
}
```

配置文件中的 `target` 必须与后续命令使用的 `--target` 一致。Cognis 会读取目标项目的信息，但不会修改它的 `package.json`。

</details>

<details>
<summary><strong>运行评测驱动开发检查</strong></summary>

```bash
pnpm cognis eval check --project ../some-project
pnpm cognis eval run --project ../some-project --mode offline
pnpm cognis eval run --project ../some-project --mode offline --write
```

evaluation `reference` 与项目 `baseline` 相互独立。更新 reference 必须使用 `eval reference --write --confirm-reference-update`；Cognis 不会自动提升 reference。详见[评测驱动开发](docs/evals.md)。

</details>

<details>
<summary><strong>按需选择安装内容</strong></summary>

如果预设的 profiles 都不合适，可以使用这个高级功能。你可以在 `cognis.config.json` 中填写 modules，也可以只在某次安装命令中指定：

```bash
pnpm cognis install --project ../some-project --target codex --profile core --modules agents,rules,skills --dry-run
pnpm cognis install --project ../some-project --target codex --profile core --modules agents,rules,skills --write
```

可选 modules 包括 `agents`、`rules`、`templates`、`governance`、`skills`、`memory`、`playwright`、`chrome-devtools`、`codebase-memory`、`open-code-review`、`agentmemory` 和 `hooks`。Cognis 会自动补上必需的依赖。命令报告会通过 `requestedModules`、`resolvedModules` 和 `implicitModules` 分别列出你选择的内容、最终安装的内容和自动补充的依赖。

</details>

<details>
<summary><strong>检查项目并保存状态快照</strong></summary>

安装完成后可以使用这组命令。`validate` 检查 Cognis 文件，`verify` 执行项目配置的检查命令，`baseline` 则保存当前项目与安装状态的快照。

```bash
# 检查 Cognis 配置和已安装文件，不执行项目命令
pnpm cognis validate --project ../some-project

# 执行配置中的 governance、lint 和 typecheck 命令
pnpm cognis verify --project ../some-project

# 预览或保存项目状态快照
pnpm cognis baseline --project ../some-project --dry-run
pnpm cognis baseline --project ../some-project --write

# 执行项目检查，并把安全的结果摘要写入快照
pnpm cognis baseline --project ../some-project --verify --write
```

如果某项检查必须由人工完成，`verify` 默认会停下来；只有明确添加 `--allow-manual` 才会继续。状态快照会记录有用的项目信息，但不会保存源码、凭据、项目绝对路径或命令的原始输出。

</details>

<details>
<summary><strong>安全移除 Cognis</strong></summary>

使用下面的命令先预览，再移除标准项目安装：

```bash
pnpm cognis uninstall --project ../some-project --target codex --dry-run
pnpm cognis uninstall --project ../some-project --target codex --write
```

Cognis 只删除自己安装且没有被修改的文件。对于共用的说明文件和 MCP 配置，它只移除自己标记的那一段。项目配置、状态快照、备份、无关文档和修改过的文件都会保留。

</details>

<details>
<summary><strong>从旧版 Codex 安装迁移</strong></summary>

旧版 profile 和命令已移除。对仍含旧 install-state 的项目，先运行标准 init；Cognis 会把旧状态归一为 `full` 或 `minimal`，然后使用标准升级命令写回 canonical profile。

```bash
pnpm cognis init --project ../some-project
pnpm cognis install --project ../some-project --target codex --profile full --dry-run --upgrade
pnpm cognis install --project ../some-project --target codex --profile full --write --upgrade --confirm-red-zone
pnpm cognis validate --project ../some-project
pnpm cognis doctor --project ../some-project
```

`--target` 只选择 adapter，不再接受项目路径；所有真实写入使用 `--write`。

</details>

<details>
<summary><strong>内置工具与命令状态</strong></summary>

当安装或健康检查报告问题时，可以查看这一节。`core` 会准备 Playwright，并在第一次需要浏览器检查时完成启动。Codex `full` 还会准备 `codebase-memory-mcp`、Chrome DevTools MCP、Open Code Review 和 Agentmemory preview 资产。

Cognis 只会把 MCP 设置写入项目 `.codex/config.toml` 中自己标记的区域。凭据只从当前终端环境读取，绝不会保存到项目中。

`chrome-devtools` 模块固定使用 `chrome-devtools-mcp@1.6.0`，通过项目内入口以系统 Google Chrome 的无头隔离模式启动。它关闭使用统计、更新检查和 CrUX 补充数据，脱敏 network header，不转发任意命令参数，也不连接个人 Chrome profile 或远程调试端口。Provisioning 会调用 `list_pages` 完成真实浏览器 smoke；Chrome 缺失或启动失败会报告 `CHROME_LAUNCH_FAILED`，且不会持久化页面、header、响应体、凭据或原始进程环境。

Open Code Review 的 endpoint 按以下顺序解析：完整的 `OCR_LLM_URL` + `OCR_LLM_TOKEN` + `OCR_LLM_MODEL`，当前用户 `~/.opencodereview/config.json` 的 active provider，兼容的 `ANTHROPIC_*` 或 `OPENAI_*` 环境变量，最后才是当前 Codex provider 的 `~/.codex/config.toml`。解析结果只传给 Open Code Review 子进程，不会写入 `cognis.config.json`、`.cognis/tool-state` 或 MCP 配置。配置缺失或不完整时保持 `pending-config`，并只输出脱敏诊断。

codebase-memory 的索引范围始终是目标项目。Cognis 将 `CBM_ALLOWED_ROOT` 和子进程 cwd 固定为项目根；索引该根时传递 `--repo-path .`，让 ASCII、空格和 Windows 中文路径经过同一套校验。根边界错误使用 `INDEX_PATH_OUTSIDE_ALLOWED_ROOT`；本地索引缓存损坏时，下一次 provision 会自动清理受管缓存并重建，重试仍失败则报告 `INDEX_CORRUPT_REINDEX_REQUIRED`。`index_status` 仍必须确认状态为 `ready`、根路径匹配，并返回合法的节点和边数量。

Install、validate 和 doctor 使用相同的三种状态：

| 状态 | 退出码 | 表示什么 |
| --- | --- | --- |
| `ready` | `0` | 治理资产有效，且没有已尝试 provisioning 的工具失败；尚未 provision 的工具以 `pending` 或 `pending-config` 告警展示。 |
| `invalid` | `1` | 配置或已安装文件与 Cognis 的预期不一致。 |
| `degraded` | `2` | 某个必需工具、凭据或功能当前不可用。 |

`--allow-degraded` 可以为自动化流程把退出码改成 `0`，但不会隐藏问题。报告仍会保留 `ok: false`、`status: "degraded"`、警告和建议的处理办法。`pending` 与 `pending-config` 不会让资产优先安装失败；运行 `provision --write` 后出现的真实工具失败，以及未完成的 provisioning 进程标记，才会使健康状态降级。

维护者使用 `pnpm runtime:audit` 按 provision 的真实依赖面执行审计。Critical、High 或审计不可用会使命令失败，Moderate 保留为可见告警；Agentmemory 在 provision 和强制审计中都排除 optional 依赖。

Cognis 会在 `.cognis/tool-state/tools.json` 逐工具记录版本、包来源、起止时间、结果和脱敏日志摘要，并在 install、validate、doctor 和 summary 输出中展示。失败诊断包含失败阶段、稳定错误码、可用时的退出码及限长输出尾部；项目路径和类似凭据的值会被替换，绝不保存原始命令环境或完整输出。provisioning 被中断时会保留 `.cognis/tool-state/provisioning.json`，`doctor` 只报告并降级，不会自动修改环境。

</details>

## Cognis 会修改什么

- 只在目标项目内写入，不修改用户级或全局 Agent 配置。
- 除非使用 `--force`，否则不替换已有文件；确实需要替换时会先创建备份。
- 对于共用的说明文件和 Codex MCP 配置，只更新带有明确标记的 Cognis 区域。
- 不修改 `.git/config`。只有在当前仓库中明确设置 `core.hooksPath` 后，打包的 Git hooks 才会启用。
- `.codex/` 中的文件属于敏感配置。Codex `full` 或内部安装要修改这些文件时，必须添加 `--confirm-red-zone`。
- 公共文件中不会写入私有项目名称、业务约定、个人路径或具体任务数据。

## 进一步了解

- [文档索引](docs/README.md)
- [Cognis 的目录和组成](docs/architecture.md)
- [从旧版本迁移](docs/migration-guide.md)
- [自动 hooks 如何工作](docs/hooks.md)
- [各版本的变化](CHANGELOG.md)
- [最小项目示例](examples/minimal-project/README.md)
- [贡献指南](CONTRIBUTING.md)

## 贡献代码前的检查

变更分类、文档影响、验证、PR 与发布流程以中文[贡献指南](CONTRIBUTING.md)为唯一真值；`AGENTS.md` 只保留 Agent 必须常驻读取的命令速查和硬边界。

## License

[MIT](LICENSE)
