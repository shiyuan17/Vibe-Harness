# LoopEngine

LoopEngine 是一套 Codex 优先的可复用 AI coding governance 包。它把协作规则、workflow 档位、任务生命周期模板、skills、manifests 和默认 dry-run 的安装器打包在一起，让新项目可以快速接入一套更稳的 Agent 协作流程。

LoopEngine 参考 ECC 的组织方式：规则、skills、manifests、adapters、installer。当前 MVP 聚焦 `Codex 可安装`：通过项目配置渲染 `AGENTS.md` 受管块，提供 `minimal` / `core` / `full` 三档 profile，并保留既有内部安装生命周期。

## 快速开始

```bash
pnpm install
pnpm loopengine init --project ../some-project
pnpm loopengine install --project ../some-project --target codex --profile core --dry-run
pnpm loopengine install --project ../some-project --target codex --profile core --write
pnpm loopengine validate --project ../some-project
pnpm loopengine verify --project ../some-project
```

MVP 模式使用 `--project <path>` 表示目标项目路径，使用 `--target codex` 表示安装 Codex adapter。安装器默认 dry-run；`--dry-run` 只打印目标路径、动作和渲染后的预览内容，不写文件。真实写入使用 `--write`。LoopEngine 只在项目根目录管理最小入口 `AGENTS.md`；其余治理资产写入 `docs/`、`.agents/skills/` 等命名空间目录，默认不会修改 `package.json`、`.npmrc`、`pnpm-workspace.yaml` 等 Node / pnpm 元文件。若项目已存在 `AGENTS.md`，LoopEngine 只会追加或更新 `<!-- LOOPENGINE:START -->` / `<!-- LOOPENGINE:END -->` 包围的受管块，保留其余本地内容；其他受管理文件如已存在，仍需显式加 `--force`，覆盖前会先备份到 `.loopengine/backups/`。

`loopengine.config.json` 示例：

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
    "governance": "node .agents/loopengine/governance/validate.mjs"
  },
  "governance": { "mode": "basic" },
  "riskZones": {
    "red": ["auth", "global request layer", "ci/cd", "env"],
    "yellow": ["shared components", "stores", "routing", "request clients"]
  },
  "crossRepo": {
    "enabled": false,
    "backendRepo": ""
  }
}
```

## MVP Profiles

- `minimal`：治理内核、codebase-memory-mcp 使用规则、`git status --short`、红区人工确认、验证证据和中文任务/交付模板。
- `core`：`minimal` + 五步中文治理、Markdown 任务校验器、工程规则、模板和 `using-loopengine` 路由 skills。
- `full`：`core` + task/backlog、durable governance memory、release / Pencil / troubleshooting、loop 和高级执行能力。

## 验证门禁

```bash
pnpm test
pnpm check
git diff --check
```

`pnpm check` 会运行 lint、pack validation 和测试。Pack validation 不只校验 manifest、install map、核心文件存在性和脱敏词，也会检查 skill frontmatter、description 触发导向、工作流、模板、测试 / 审查 / Git / 工作流规则是否包含可执行字段，避免治理文档退化成空壳。

`validate --project` 只检查配置、安装一致性和命令可用状态，不执行目标项目命令。`verify --project` 会先完成这些检查，再按 governance、lint、typecheck 顺序执行已配置命令；manual 命令默认阻断，审查命令内容后可显式使用 `--allow-manual`。

安装后的项目可直接运行零依赖治理校验器：

```bash
node .agents/loopengine/governance/validate.mjs
node .agents/loopengine/governance/validate-packet.mjs --file path/to/packet.md
```

`core` 默认执行 basic 文档和 Packet 门禁；`full` 增加 task/backlog、durable memory、设计预览配对和发布治理。LoopEngine 不自动修改目标项目 `package.json`。

## 旧内部安装生命周期

旧命令仍可使用，用于包含 Codex hooks 的内部 profile。MVP 接入优先使用 `--project <path> --target codex --write`；legacy/internal 生命周期使用 `--target <path> --apply --confirm-red-zone`：

```bash
pnpm loopengine install --target ../some-project --profile codex-internal --apply --confirm-red-zone
```

`loopengine validate --target <path>` 用来检查目标项目是否已经具备旧 profile 期望的文件；不带 `--target` 或 `--project` 时校验 LoopEngine 包自身。`loopengine doctor --target <path>` 会同时输出包校验结果和目标项目安装状态。

## v0.2 安装生命周期

真实安装会写入 `.loopengine/install-state.json`，记录 profile、版本、写入文件、hash、红区文件和备份位置。该目录只存在于目标项目内，不写入全局配置。

```bash
pnpm loopengine diff --target ../some-project --profile codex-internal
pnpm loopengine install --target ../some-project --profile codex-internal --apply --upgrade --confirm-red-zone
pnpm loopengine rollback --target ../some-project --dry-run
pnpm loopengine rollback --target ../some-project --apply --confirm-red-zone
```

`diff` 用于审查 expected、missing、same、changed、redZone 和 unmanaged 文件。`install --upgrade` 只更新 LoopEngine 管理且 hash 可追踪的文件；用户改过的 managed 文件默认拒绝，使用 `--force` 时会先生成备份。`rollback` 默认 dry-run，真实回滚需要 `--apply`；涉及红区文件时必须加 `--confirm-red-zone`。

## Profiles

- `minimal`：MVP 最小 Codex 包，包含会话开始/结束协议，不安装 heavy rules 或 skills。
- `core`：标准工程治理包，包含 coding / frontend / API / task / workflow / review 规则、基础 validator、常规 bundled skills 和 skill 编写检查。
- `full`：完整治理包，增加 durable memory、release、Pencil、troubleshooting、对抗审查、loop 和高级执行能力，不安装 hooks。
- `codex-internal`：安装 AGENTS、全部规则、模板、skills 和 Codex hooks。
- `codex-minimal`：安装 AGENTS 与最小规则/模板集。
- `docs-only`：只安装治理内核、专项规则、中文模板和 schema。

## 当前状态

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| Codex `minimal` / `core` / `full` 安装 | 已完成 | `--project <path> --target codex` 支持 dry-run、write、validate。 |
| legacy `codex-internal` 生命周期 | 已完成 | 支持 diff、upgrade、backup、rollback 和红区确认。 |
| 中文治理内核 | 已完成 | `minimal` 起安装五步循环、三档风险、轻量反证和无 Skill 降级合同。 |
| Skills 路由 | 已完成 | core 使用 `using-loopengine` 按需加载流程、专项和验证 Skill；full 补充对抗审查、release、Pencil、loop 和 subagent 能力。 |
| Pack validation | 已完成 | 校验 manifests、schema、源文件存在性、skill frontmatter / description、脱敏词、工作流 / 模板质量门禁和结构化治理资产。 |
| Codex hooks | 占位兼容 | 仅保留 legacy placeholder，不作为默认 MVP 安装面。 |
| 非 Codex adapter | 后续路线 | Claude、Cursor、OpenCode 等暂不创建适配器。 |

## 安全边界

LoopEngine 不写入全局 Codex 配置。目标项目已有文件默认不覆盖；如需覆盖必须显式使用 `--force`。`.codex/hooks.json` 等红区文件在非 dry-run 安装时必须显式确认。

## codebase-memory-mcp

`codebase-memory-mcp` 是可选的代码结构与影响分析能力。LoopEngine 只向目标项目安装 `docs/rules/codebase-memory-mcp.md`，不会安装 MCP 服务、修改全局 Agent/MCP 配置或在 `doctor` 中探测服务状态。

MCP 可用时，安装后的规则要求 Agent 先用 `list_projects` / `index_status` 确认索引，再按任务使用 `index_repository`、`search_graph`、`trace_call_path`、`detect_changes` 或 `get_architecture`。MCP 不可用或索引失败时必须说明缺少该能力，并退回 `rg` 与直接源码阅读。

回滚策略保持简单透明：安装器只复制文件，不修改全局配置，不自动合并已有文件。真实安装或强制升级前会记录状态和备份；若需要撤销，优先使用 `loopengine rollback`，也可以按 `.loopengine/install-state.json` 中的记录手工处理。
