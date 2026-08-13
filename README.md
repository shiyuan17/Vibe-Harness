# Vibe-Harness

[English](README.en.md) | [简体中文](README.md)

Vibe-Harness 为 Codex、Claude Code、Gemini CLI、Cursor、Qoder、ZCode、Antigravity 和 OpenCode 安装项目级规则、领域 Skills、可选 Eval、显式工具插件和安全 Hook。它只写目标项目，不修改全局 Agent 配置。

默认执行路径只有一条：`获取事实 -> 直接执行 -> 聚焦验证 -> 简洁交付`。快速、轻量、完整三档只用于选择风险控制和验证强度。

## 快速开始

需要 pnpm 10+，以及 Node.js 20.19+、22.18+ 或 24+。

在 Vibe-Harness 仓库中选择并复制下面一条提示词，将 TARGET_PROJECT_ABSOLUTE_PATH 替换为目标项目绝对路径。先确定项目需要的全部宿主，并将 codex、claude、gemini、cursor、qoder、zcode、antigravity 或 opencode 写入唯一、非空的 targets 数组。三条提示词面向首次安装；已有安装使用后文的升级流程。

以下提示词中的宿主选择应覆盖项目实际使用的全部八类 adapter，并写入同一个 targets 数组；不要按编辑器分别安装。

### minimal

    将 Vibe-Harness minimal profile 安装到 TARGET_PROJECT_ABSOLUTE_PATH。你正在 Vibe-Harness 仓库中执行：先检查 Node.js 与 pnpm 版本并安装本仓库依赖；根据当前 Agent 宿主选择 codex、claude 或 gemini adapter。若目标项目不存在 vibe-harness.config.json，则用所选 adapter 和 minimal profile 初始化；若配置或已有安装状态不匹配，停止并报告，禁止使用 --force。先执行 install dry-run，确认没有冲突、越界写入或意外覆盖后再使用 --write 正式安装，最后运行 validate --project。minimal 不安装任何可选插件，也不建立代码索引。只允许写入目标项目，不修改全局 Agent、MCP 或 Git 配置。报告实际写入、验证结果和任何未完成项。

### core（推荐）

    将 Vibe-Harness core profile 安装到 TARGET_PROJECT_ABSOLUTE_PATH，并安装、启用 codebase-memory-mcp 后建立初始代码索引。你正在 Vibe-Harness 仓库中执行：先检查 Node.js 与 pnpm 版本并安装本仓库依赖；根据当前 Agent 宿主选择 codex、claude 或 gemini adapter。若目标项目不存在 vibe-harness.config.json，则用所选 adapter 和 core profile 初始化；若配置或已有安装状态不匹配，停止并报告，禁止使用 --force。install 的 dry-run 和正式安装都必须显式选择 --plugin codebase-memory-mcp；先检查 dry-run 的冲突、越界写入、覆盖和红区计划，通过后再使用 --write。我明确授权本次安装写入由该插件规划的项目级 MCP 红区配置，正式安装时使用 --confirm-red-zone。安装后先预览 provision，再使用 provision --write 安装并启用项目内固定版本 runtime、关闭 auto_index 与 auto_watch、建立索引、验证索引属于目标项目且状态 ready，并完成 MCP handshake。最后运行 validate --project 和 doctor --project；只有安装一致且 codebaseMemoryMcp 状态为 ready 时才报告完整成功，否则报告失败阶段和恢复命令。不得修改全局 Agent、MCP 或 Git 配置。

### full

    将 Vibe-Harness full profile 安装到 TARGET_PROJECT_ABSOLUTE_PATH，并安装、启用 codebase-memory-mcp 后建立初始代码索引。你正在 Vibe-Harness 仓库中执行：先检查 Node.js 与 pnpm 版本并安装本仓库依赖；根据当前 Agent 宿主选择 codex、claude 或 gemini adapter。若目标项目不存在 vibe-harness.config.json，则用所选 adapter 和 full profile 初始化；若配置或已有安装状态不匹配，停止并报告，禁止使用 --force。install 的 dry-run 和正式安装都必须显式选择 --plugin codebase-memory-mcp；先检查 dry-run 的冲突、越界写入、覆盖和红区计划，通过后再使用 --write。我明确授权本次 full 安装写入其规划的项目级 Hook 与 MCP 红区配置，正式安装时使用 --confirm-red-zone。安装后先预览 provision，再使用 provision --write 安装并启用项目内固定版本 runtime、关闭 auto_index 与 auto_watch、建立索引、验证索引属于目标项目且状态 ready，并完成 MCP handshake。最后运行 validate --project 和 doctor --project；只有安装一致且 codebaseMemoryMcp 状态为 ready 时才报告完整成功，否则报告失败阶段和恢复命令。不得修改全局 Agent、MCP 或 Git 配置。

core 和 full 的快速提示词显式增加 codebase-memory-mcp；这不会改变 profile 本身“外部工具必须通过 --plugin 选择”的合同。手动执行等价的 core 安装：

```bash
pnpm install
pnpm vibe-harness init --project ../some-project --target codex --profile core
pnpm vibe-harness install --project ../some-project --target codex --profile core --plugin codebase-memory-mcp --dry-run
pnpm vibe-harness install --project ../some-project --target codex --profile core --plugin codebase-memory-mcp --write --confirm-red-zone
pnpm vibe-harness provision --project ../some-project --target codex --profile core --dry-run
pnpm vibe-harness provision --project ../some-project --target codex --profile core --write
pnpm vibe-harness validate --project ../some-project
pnpm vibe-harness doctor --project ../some-project
```

`validate` 只检查安装一致性。执行项目验证使用：

```bash
pnpm vibe-harness verify --project ../some-project
```

`verify` 依次执行已配置的 `lint -> typecheck -> test -> eval`，未配置的项会跳过。

验证 JSON 还包含本轮 ID、时间和非持久化 Git 工作树指纹；检查期间工作树变化时返回 PROJECT_VERIFICATION_STALE。

## 多宿主安装

同一个项目只安装一次。配置中的 targets 数组声明全部宿主；不带 --target 的 install、upgrade、validate、doctor 和 diff 处理全部目标，带 --target 时只选择配置或 install-state 中仍存在的一个宿主，绝不隐式追加。

公共规则、runtime、memory、Eval 和 codebase-memory 索引在项目根以 shared owner 维护一份；宿主入口、原生 Skills、MCP 和 Hook 以 adapter:id owner 维护投影。不要在项目子目录重复安装来模拟多宿主支持。

## 执行模型

- 快速：只读、解释、文档和微小非行为变化，通常只需静态核对。
- 轻量：可逆的本地行为改动，运行与受影响范围匹配的检查。
- 完整：安全、生产、发布、数据迁移、公共契约、红区、不可逆或跨仓变更，扩大验证并准备回滚。

单 Agent 默认完成任务。用户显式调用的 `open-code-review`、浏览器验证、Eval 和项目测试仍可正常使用。任务 Markdown 是可选的人读记录，不参与运行时判断。

## Profiles

core 安装六个原生 Skills，full 安装九个原生 Skills。

| Profile | 安装内容 |
| --- | --- |
| `minimal` | 平台说明、安全边界、Git/Test 规则和可选任务/交付模板 |
| `core` | `minimal` 加通用工程规则、六个原生 Skills 和离线 Eval |
| `full` | `core` 加三个原生 Skills、在线 Eval 和已支持宿主的安全 Hook，共九个原生 Skills |
| `docs-only` | 规则、模板和 schemas，不安装 runtime、Skills、MCP 或 Hook |

外部工具和 memory 仍只通过 `--plugin` 显式启用。所有宿主配置文件均属于红区写入，需要 `--confirm-red-zone`。

```bash
pnpm vibe-harness install --project ../some-project --target codex --profile full --dry-run
pnpm vibe-harness install --project ../some-project --target codex --profile full --write --confirm-red-zone
```

Claude Code 和 Gemini CLI 使用相同的四个 profile；其 preview 能力需要显式 `--allow-preview`。

## Adapter 支持

Codex、Cursor、Qoder、ZCode 和 OpenCode 共用 AGENTS.md 中唯一的宿主中立受管块。Antigravity 的 rules、Skills 和 MCP 为 stable；Hooks、sandbox 和 memory 集成为 preview，尚不与 Codex 完全等价。OpenCode 的 instructions、Skills、policy 和 MCP 为 stable，sandbox 和 memory 为 preview，Hooks、plugin 和 goals 为 unsupported。

OpenCode 的 full profile 需要显式允许 preview。它使用已有的 opencode.json 或 opencode.jsonc，两者同时存在时报冲突；JSONC 注释、尾逗号、格式和用户配置会保留。OpenCode 不安装项目 plugin Hook，因此始终报告 DEGRADED_SAFETY_POSTURE。

| Target | 项目指令 | Skills | 项目级 Hook / MCP 配置 |
| --- | --- | --- | --- |
| OpenCode | AGENTS.md | .opencode/skills/ | opencode.json 或 opencode.jsonc；仅 MCP，不安装 Hook |
| Antigravity | .agents/rules/vibe-harness.md | .agents/skills/ | .agents/mcp_config.json；Hook 为 preview |
| Codex | `AGENTS.md` | `.agents/skills/` | `.codex/` |
| Claude Code | `CLAUDE.md` | `.claude/skills/` | preview 能力 |
| Gemini CLI | `GEMINI.md` | `.gemini/skills/` | preview 能力 |
| Cursor | `AGENTS.md` | `.cursor/skills/` | `.cursor/hooks.json`、`.cursor/mcp.json` |
| Qoder | `AGENTS.md` | `.qoder/skills/` | `.qoder/settings.json`、`.mcp.json` |
| ZCode | `AGENTS.md` | 不自动安装 | `.zcode/config.json` |

ZCode 尚未公开项目级 Skill 的磁盘路径，因此 Vibe-Harness 不会写入 `~/.zcode`，也不会猜测项目 Skill 目录；需要时请通过 ZCode UI 手动导入。受管 JSON 只更新 Vibe-Harness 的 MCP server 和 Hook 组，用户已有配置会保留。

## 项目配置

`vibe-harness init` 创建以下结构：

```json
{
  "projectName": "ExampleProject",
  "language": "zh-CN",
  "packageManager": "pnpm",
  "targets": ["codex"],
  "profile": "core",
  "validationCommands": {
    "lint": null,
    "typecheck": null,
    "test": null,
    "eval": null
  },
  "evaluations": {
    "enabled": false,
    "suites": [],
    "reference": "evals/references/project.json",
    "thresholds": {
      "criticalPassRate": 1,
      "overallScore": 0.9,
      "maxCapabilityRegression": 0.05
    },
    "onlineRunner": null,
    "repetitions": 3
  },
  "hooks": {
    "allowedWriteRoots": [],
    "allowedEgressHosts": [],
    "mode": "guarded"
  },
  "riskZones": {
    "red": ["auth", "secrets", "ci-cd", "env"],
    "yellow": ["shared-libs", "state", "routing", "io-clients"]
  },
  "crossRepo": {
    "enabled": false,
    "backendRepo": ""
  },
  "projectRules": {
    "mode": "auto",
    "overrides": {}
  },
  "clarification": {
    "posture": "balanced"
  },
  "memory": {
    "enabled": true,
    "path": ".agents/memory"
  }
}
```

旧字段 `governance.mode`、`governance.workflow`、`hooks.completionGate` 和 `validationCommands.governance` 会触发 `VIBE_HARNESS_OBSOLETE_GOVERNANCE_CONFIG`。Vibe-Harness 不静默兼容或自动修改项目配置。

## 显式工具

Linear 工作流是单独的外部集成：linear-mcp 使用读写端点，linear-mcp-readonly 使用只读端点，两者互斥且都不会被 plugin all 选中。Codex、Cursor、Qoder、ZCode、Antigravity 和 OpenCode 会生成项目级 Remote MCP 配置；Claude 与 Gemini 安装相同规则和 Skill，但报告 MCP 手工配置降级。安装器不写入 Token 或 OAuth 凭据，配置完成后仍需按宿主提示完成 Linear 原生认证。

可选插件包括 `rtk`、`ast-grep`、`codebase-memory-mcp`、`chrome-devtools-mcp`、`playwright-cli` 和 `open-code-review`。Agentmemory runtime 因上游 High 漏洞暂停提供，不作为 `--plugin` 选项；如需记忆能力，请通过 `--modules memory` 安装 memory 模块。

```bash
pnpm vibe-harness install --project ../some-project --target codex --profile core --plugin -rtk --dry-run
pnpm vibe-harness install --project ../some-project --target codex --profile core --plugin -rtk ast-grep --write
pnpm vibe-harness install --project ../some-project --target codex --profile core --plugin linear-mcp --write --confirm-red-zone
pnpm vibe-harness install --project ../some-project --target codex --profile core --plugin linear-mcp-readonly --write --confirm-red-zone
pnpm vibe-harness install --project ../some-project --target codex --profile core --plugin none --write
```

插件选择会保存在项目 install-state 中。`--modules` 是替换 profile 模块集合的高级接口，不是插件增量接口。

## 升级与移除

旧 target 配置仍可读取，但只有 install --upgrade --write 会把它和 state v4 原子迁移到 targets 与带 owners 的 state v5。手工从配置删除 target 只报告 stale projection，不会在升级中隐式删除。目标级卸载移除一个投影；最后一个目标和共享资产必须使用 --all-targets 完整卸载。

升级会比较旧 install-state 与新安装计划。计划不再包含且未修改的受管文件会在 `--upgrade --write` 下退役；已修改文件只报告冲突，不会删除。过期运行时状态会精确清理，不会删除整个 `.vibe-harness`。

```bash
pnpm vibe-harness install --project ../some-project --target codex --profile core --dry-run --upgrade
pnpm vibe-harness install --project ../some-project --target codex --profile core --write --upgrade
pnpm vibe-harness uninstall --project ../some-project --target codex --dry-run
pnpm vibe-harness uninstall --project ../some-project --target codex --write
pnpm vibe-harness uninstall --project ../some-project --all-targets --write
```

### 退出码

| 退出码 | 含义 |
|--------|------|
| 0 | 成功（或降级但传了 `--allow-degraded`）。 |
| 1 | 失败：状态无效、安装错误或未处理异常。 |
| 2 | 部分跳过：卸载或回滚因用户修改保留了部分文件；或健康检查降级且未传 `--allow-degraded`。 |

## 安全边界

- 未使用 `--force` 时不覆盖已有项目文件。
- 所有真实写入使用 `--write`；红区写入需要显式确认。
- 安装器不修改全局 Agent 配置或 `.git/config`。
- Codex、Cursor、Qoder 和 ZCode Hook 会把 `PreToolUse` 和权限事件归一到同一安全策略，用于阻止危险 Git、全局配置写入、凭据外传、红区文件上传、越界写入，以及（配置 `allowedEgressHosts` 白名单后）非白名单主机出口。RTK Hook 路由仍只支持 Codex。
- 完成主张必须由本轮有效证据支持；无法验证时缩小主张并说明风险。

## 文档

- [文档索引](docs/README.md)
- [架构](docs/architecture.md)
- [迁移指南](docs/migration-guide.md)
- [Hook 安全策略](docs/hooks.md)
- [Eval](docs/evals.md)
- [贡献指南](CONTRIBUTING.md)

## License

[MIT](LICENSE)
