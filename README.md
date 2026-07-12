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
pnpm loopengine baseline --project ../some-project --write
pnpm loopengine verify --project ../some-project
```

MVP 模式使用 `--project <path>` 表示目标项目路径，使用 `--target codex` 表示安装 Codex adapter。安装器默认 dry-run；`--dry-run` 只打印目标路径、动作和渲染后的预览内容，不写文件。真实写入使用 `--write`。LoopEngine 只在项目根目录管理最小入口 `AGENTS.md`；其余治理资产写入 `docs/`、`.agents/skills/` 等命名空间目录，默认不会修改 `package.json`、`.npmrc`、`pnpm-workspace.yaml` 等 Node / pnpm 元文件。若项目已存在 `AGENTS.md`，LoopEngine 只会追加或更新 `<!-- LOOPENGINE:START -->` / `<!-- LOOPENGINE:END -->` 包围的受管块，保留其余本地内容；其他受管理文件如已存在，仍需显式加 `--force`，覆盖前会先备份到 `.loopengine/backups/`。

## 什么时候用 LoopEngine

| 场景 | 推荐做法 | 你会得到什么 |
| --- | --- | --- |
| 新项目接入 Codex governance | 先 `init`，再 `install --project ... --target codex --profile core --dry-run` | 先看写入面和风险，再决定是否 `--write`。 |
| 既有项目补齐 Agent 协作规范 | 直接把 LoopEngine 当成治理包安装器，用 `core` 起步 | 得到规则、模板、skills 和校验器的统一入口。 |
| 高风险任务要可验证 | 让 Agent 先判定为 `完整` 档，再给出证据、反例和回滚方案 | 任务不会跳过审查和验证步骤。 |
| 旧 Codex hooks 仍要兼容 | 继续使用 legacy/internal 生命周期 | 保持 `--target <path> --apply --confirm-red-zone` 语义。 |

## 核心使用流程

1. 初始化目标项目配置。

   ```bash
   pnpm loopengine init --project ../some-project
   ```

2. 先 dry-run 看写入面、红区和 profile。

   ```bash
   pnpm loopengine install --project ../some-project --target codex --profile core --dry-run
   ```

3. 确认无误后再真实写入。

   ```bash
   pnpm loopengine install --project ../some-project --target codex --profile core --write
   ```

4. 用 `validate` 检查配置、安装一致性和包自身校验。

   ```bash
   pnpm loopengine validate --project ../some-project
   ```

5. 用 `verify` 执行目标项目配置的治理 / lint / typecheck 命令。

   ```bash
   pnpm loopengine verify --project ../some-project
   ```

6. 安装一致后建立项目基线，供后续 Agent 读取项目事实、工作流和建议。

   ```bash
   pnpm loopengine baseline --project ../some-project --dry-run
   pnpm loopengine baseline --project ../some-project --write
   ```

`validate --project` 只做一致性与可用性检查，不执行目标项目命令。`verify --project` 才会真正执行配置里的命令；如果某条命令是手工流程，默认会阻断，只有显式使用 `--allow-manual` 才会继续。

`baseline --project` 默认只预览 `.loopengine/baseline.json` 和 `docs/loopengine/PROJECT_BASELINE.md`，不会写文件或执行目标项目命令。使用 `--write` 建档，使用 `--verify` 才执行 governance、lint、typecheck 并记录脱敏摘要；重复运行会报告 `initial`、`unchanged` 或 `changed` drift。该命令只属于 MVP `--project` 生命周期，不接受 legacy `--target` 或 `--apply`。

## 配置示例

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
  "hooks": {
    "mode": "guarded",
    "completionGate": "advisory"
  },
  "riskZones": {
    "red": ["auth", "global request layer", "ci/cd", "env"],
    "yellow": ["shared components", "stores", "routing", "request clients"]
  },
  "crossRepo": {
    "enabled": false,
    "backendRepo": ""
  },
  "projectRules": {
    "mode": "auto",
    "overrides": {}
  },
  "memory": {
    "enabled": true,
    "path": ".agents/memory"
  }
}
```

你通常只需要改这几类字段：

- `profile`：决定装到什么治理面。
- `validationCommands`：决定 `verify` 跑什么。
- `riskZones`：告诉 Agent 哪些区域算红区 / 黄区。
- `governance.mode`：决定治理内核是 `basic`、`full` 还是 `off`。
- `hooks`：决定 full/internal hook 使用观测、保护或严格模式，以及完成门禁是否阻断。
- `projectRules` 和 `memory`：给项目专属规则和记忆目录留位置。

## 如何让 Agent 跑一轮 loop

LoopEngine 的工作流不是“直接给答案”，而是先把任务跑成一轮 loop：

1. 获取事实。
2. 做出决策。
3. 执行最小改动。
4. 验证结果。
5. 交付证据、风险和下一步。

你可以把这段话直接发给 Agent：

```text
请按 LoopEngine 的五步循环推进：
先只做事实收集和档位判断，不要直接改文件。
输出当前事实、关键假设、风险档位、需要我确认的点和下一步计划。
等我回复继续后，再执行并在结束时给出“主张 → 证据 → 反例 → 剩余风险”。
```

如果任务会多轮推进，可以再补一句：

```text
如果你发现范围变化或风险升级，请先停下来重新做决策，不要默认继续。
```

## 提示词示例

### 安装前先看写入面

```text
请先对当前仓库做 LoopEngine dry-run 安装审查。
目标：判断应该用 core 还是 full profile，并说明会写入哪些文件、是否触及红区、是否会覆盖现有文件。
先不要写入，先输出安装计划和风险。
```

### 让 Agent 先路由

```text
按 using-loopengine 路由。当前是任务开始阶段，请先判断风险档位，只选择一个流程 skill 和一个验证/审查 skill。
如果信息不足，先列出需要我确认的内容，不要直接猜。
```

### 快速文档任务

```text
这是快速档位任务，只读文档，不改代码。
请按“主张 → 证据 → 反例 → 剩余风险”输出结论，并给出需要补充的文档位置。
```

### 轻量代码任务

```text
这是轻量档位任务，范围只限于指定文件。
先列验收标准和写入范围，再做最小改动，最后给出验证命令和结果。
```

### 完整高风险任务

```text
这是完整档位任务，涉及红区 / 外部契约 / 发布。
先给出风险档位判断、回滚方案、验证计划和需要人工确认的点，再继续执行。
```

## 工作流档位选择

| 档位 | 适用场景 | 读取方式 |
| --- | --- | --- |
| `快速` | 只读、纯文档、低风险文案，不改运行时、公开契约或红区 | 先收集事实，再给结论。 |
| `轻量` | 单一范围的小改动，可用聚焦验证证明 | 先固定写入范围和验收标准。 |
| `完整` | 红区、安全、数据库、发布、跨层、外部契约、多 Agent 或父子任务 | 先做决策，再执行，再验证。 |

不确定时直接升级到 `完整`。不要让 Agent 静默猜测档位，应该先把判断说出来。

## 常见操作场景

### 1. dry-run 审查安装计划

先看安装器准备写什么，再决定是否真实写入：

```bash
pnpm loopengine install --project ../some-project --target codex --profile core --dry-run
```

你会看到目标路径、动作列表和渲染后的预览内容。这个阶段不会写文件。

### 2. 调整项目配置

`loopengine.config.json` 里最常改的是这三块：

- `validationCommands`：把 `lint` / `typecheck` / `governance` 对到项目真实命令。
- `riskZones`：把你项目里真正的红区、黄区写进去。
- `governance.mode`：如果项目不需要治理门禁，可以设为 `off`；需要基础门禁就保留 `basic`。

### 3. 安装后跑目标项目校验

安装完成后先校验安装一致性，再跑目标项目验证命令：

```bash
pnpm loopengine validate --project ../some-project
pnpm loopengine verify --project ../some-project
```

`validate` 关注安装是否一致；`verify` 才会真正执行配置里的命令。

### 4. 使用 full profile

`full` 会在 `core` 基础上增加 durable memory、release、Pencil、troubleshooting、loop、review 和更完整的执行能力。适合要长期维护、跨层改动、发布前审查、或者需要更强证据链的任务。

### 5. 继续兼容旧内部生命周期

如果你在维护旧 Codex hooks 或内部 profile，继续使用 legacy/internal 生命周期：

```bash
pnpm loopengine install --target ../some-project --profile codex-internal --dry-run
pnpm loopengine install --target ../some-project --profile codex-internal --apply --confirm-red-zone
pnpm loopengine validate --target ../some-project --profile codex-internal
pnpm loopengine doctor --target ../some-project
```

这里不要混入 MVP 的 `--project` 语义。`--apply` 是 legacy/internal 的真实写入开关，红区文件还要再加 `--confirm-red-zone`。

## 验证门禁

```bash
pnpm test
pnpm check
git diff --check
```

`pnpm check` 会运行 lint、pack validation 和测试。Pack validation 不只校验 manifest、install map、核心文件存在性和脱敏词，也会检查 skill frontmatter、description 触发导向、工作流、模板、测试 / 审查 / Git / 工作流规则是否包含可执行字段，避免治理文档退化成空壳。

安装后的项目可直接运行零依赖治理校验器：

```bash
node .agents/loopengine/governance/validate.mjs
```

`core` 默认执行 basic 文档和任务门禁；`full` 增加 task/backlog、durable memory、设计预览配对和发布治理。LoopEngine 不自动修改目标项目 `package.json`。

`core` 会在 `.agents/loopengine/tools/playwright-cli/` 安装隔离的 Playwright CLI bootstrap，并在首次使用时准备 Chromium。`full` / `codex-internal` 则在真实安装阶段立即初始化 Playwright、codebase-memory-mcp、Open Code Review 和 Agentmemory；首次安装需要网络、时间和额外磁盘空间。四个 runtime 使用精确 lockfile，写入 `.agents/loopengine/tools/`，状态写入 `.loopengine/tool-state/`。组件失败不会伪装成完成：安装报告和 `doctor` 使用 `ready`、`pending`、`pending-config` 或 `degraded`，同时继续安装其他组件。

MVP full 使用 `--project <path> --target codex --write --confirm-red-zone`；legacy/internal 使用 `--target <path> --apply --confirm-red-zone`。full/internal 会把 codebase-memory 和 agentmemory 注册到项目 `.codex/config.toml` 的 LoopEngine 受管块，不写用户级 Codex 配置。OCR 只从当前进程环境读取凭据；没有可用凭据时安装 runtime，但状态为 `pending-config`，不会把 secret 写入项目。

## 旧内部安装生命周期

旧命令仍可使用，用于包含 Codex hooks 的内部 profile。两条生命周期不要混用：

- MVP 接入使用 `--project <path> --target codex --write`。
- legacy/internal 生命周期使用 `--target <path> --apply --confirm-red-zone`。

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

Agentmemory 在 `full` / `codex-internal` 中安装一个 `.agents/skills/agentmemory/` 入口和项目内 stdio MCP runtime，不启动 3111/3113 常驻服务。安装使用 `--omit=optional` 排除非必需的本地 embedding/ONNX 依赖，保存、检索、恢复、遗忘、汇总和 session 历史流程按需读取该目录的 `references/`。升级时，install map 显式声明的旧顶层 memory skills 只会在 `--upgrade` 且旧 install state 可验证时退役：未修改文件先备份再删除，用户修改过的文件保留并报告，`rollback` 可恢复已退役文件。

## Profiles

- `minimal`：MVP 最小 Codex 包，包含会话开始/结束协议，不安装 heavy rules 或 skills。
- `core`：标准工程治理包，包含 coding / frontend / API / task / workflow / review 规则、基础 validator、常规 bundled skills、skill 编写检查和懒加载 Playwright CLI bootstrap。
- `full`：完整治理包，增加 durable memory、release、Pencil、troubleshooting、对抗审查、loop、四个项目内工具 runtime、Codex hooks 和默认未启用的 Git hooks。
- `codex-internal`：等同 full，使用 legacy/internal 的 `--target` / `--apply` 生命周期。
- `codex-minimal`：安装 AGENTS 与最小规则/模板集。
- `docs-only`：只安装治理内核、专项规则、中文模板和 schema。

## 当前状态

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| Codex `minimal` / `core` / `full` 安装 | 已完成 | `--project <path> --target codex` 支持 dry-run、write、validate。 |
| 安装后项目基线 | 已完成 | `baseline --project` 生成 JSON 快照和 Markdown 工作流建议，支持 dry-run、write、verify 和 drift。 |
| legacy `codex-internal` 生命周期 | 已完成 | 支持 diff、upgrade、backup、rollback 和红区确认。 |
| 中文治理内核 | 已完成 | `minimal` 起安装五步循环、三档风险、轻量反证和无 Skill 降级合同。 |
| Skills 路由 | 已完成 | core 使用 `using-loopengine` 按需加载流程、专项和验证 Skill；full 补充对抗审查、release、Pencil、loop 和 subagent 能力。 |
| 项目内工具 | 已完成 | core 懒加载 Playwright；full/internal 初始化 Playwright、codebase-memory、Open Code Review 和 Agentmemory。 |
| Pack validation | 已完成 | 校验 manifests、schema、源文件存在性、skill frontmatter / description、脱敏词、工作流 / 模板质量门禁和结构化治理资产。 |
| Codex hooks | 已完成 | full/internal 安装官方 PascalCase 事件、项目内 runner 和 guarded 默认策略。 |
| Git hooks | 已完成 | full/internal 安装版本化模板；需显式设置本仓库 `core.hooksPath`，doctor 只读报告状态。 |
| 非 Codex adapter | 后续路线 | Claude、Cursor、OpenCode 等暂不创建适配器。 |

## 安全边界

LoopEngine 不写入全局 Codex 配置，也不修改 `.git/config`。目标项目已有文件默认不覆盖；如需覆盖必须显式使用 `--force`。基线不会记录绝对项目路径、凭据、源码或验证命令原始输出；受管基线被用户修改后同样默认拒绝覆盖，强制更新前会备份。`.codex/hooks.json` 和 `.codex/config.toml` 属于红区文件，在非 dry-run 安装时必须显式确认；后者只更新 LoopEngine MCP 受管块并保留本地内容。Hook 事件、模式、Git 启用方式和限制见 `docs/hooks.md`。

## codebase-memory-mcp

`full` / `codex-internal` 会在项目内安装 `codebase-memory-mcp@0.9.0`，把缓存限制到 `.loopengine/tool-state/codebase-memory-mcp/`，并以 `moderate`、`persistence=false` 为目标项目建立初始索引。安装器不会调用第三方全局 `install` 命令，也不会修改全局 Agent/MCP 配置。

MCP 可用时，安装后的规则要求 Agent 先用 `list_projects` / `index_status` 确认索引，再按任务使用 `index_repository`、`search_graph`、`trace_call_path`、`detect_changes` 或 `get_architecture`。MCP 不可用或索引失败时必须说明缺少该能力，并退回 `rg` 与直接源码阅读。

回滚会删除未修改的项目内 runtime 生成目录和工具状态，并只移除 `.codex/config.toml` 的 LoopEngine MCP 受管块；块外本地配置保持不变。真实安装或强制升级前会记录状态和备份；若需要撤销，优先使用 `loopengine rollback`。
