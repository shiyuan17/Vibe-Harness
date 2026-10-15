# Vibe-Harness

### 交付与生命周期

新项目默认 `delivery.default = managed-mr`（squash）；可用 `--delivery local-land` 选择 no-ff 或 `--delivery inspect-only` 只读。旧配置不声明 delivery 时保留 legacy，仅提示迁移。安装 profile 与 delivery profile 是不同维度。

- `node .agents/runtime/commands/run.mjs worktree cleanup --project . --task <id> --delivery managed-mr --receipt <completion.json> --merge-evidence <merge.json>` 默认预览；`--write` 才清理。可用 `--mr <iid>` 读取 GitLab merge evidence，读取失败 blocked。
- `node .agents/runtime/commands/run.mjs task checkpoint <id> --project . --reason pre-compaction --write` 保存恢复状态；`task event <id> --reason resume|continue|pre-compaction` 是宿主显式事件入口，不代表已安装宿主监听。
- `node .agents/runtime/commands/run.mjs runtime service start --project . --service frontend --port 5173 --write` 启动配置声明的服务；`status` 只读，`stop --write` 仅停止可证明归属的登记服务。
- 新模式完整完成须完整收据、当前指纹和全部必需验收通过；验证命令通过不等于 MR、浏览器、数据库或发布通过。

配置示例与迁移边界见 [交付生命周期规格](docs/specs/delivery-lifecycle.md)。

[English](README.en.md) | [简体中文](README.md)

Vibe-Harness 为 Codex、Claude Code、Gemini CLI、Cursor、Qoder、ZCode、Antigravity 和 OpenCode 安装项目级规则、领域 Skills、可选 Eval、显式工具插件和安全 Hook。它只写目标项目，不修改全局 Agent 配置。

默认执行路径只有一条：`获取可信事实 -> 判定并执行 -> 聚焦验证 -> 简洁交付`。判定只用于按证据、歧义和复杂度选择直接实施、继续查证、澄清、请求授权、规划或拆分；快速、轻量、完整三档只用于选择风险控制和验证强度。

## 在已安装项目启用 Micro

安装本身不会扫描业务、生成 probe 或自动启用 Micro。先在本仓库预演升级，确认不会覆盖项目自有文件，再按原安装参数执行 `--write` 并验证。已安装的 `.agents/runtime/commands/run.mjs` 和 `.agents/runtime/lib/micro-runner.mjs` 必须一同更新；需要 Node 22+ 和 Git 工作树。

    pnpm vibe-harness install --project <项目绝对路径> --dry-run
    pnpm vibe-harness validate --project <项目绝对路径>

只为**选定的局部不变量**编写经审阅的项目 probe，例如 `scripts/probes/normalize.mjs` 导出 `default(args)`，并在目标项目 `vibe-harness.config.json` 的 `validationCommands.micro` 中显式增加：

```json
[
  {
    "id": "normalize-example",
    "kind": "pure",
    "entry": "scripts/probes/normalize.mjs",
    "args": { "value": "example" },
    "costTier": "quick",
    "scopes": ["affected", "layer"],
    "maxDurationMs": 3000,
    "maxOutputBytes": 2048,
    "network": "deny",
    "workspaceWrite": "deny",
    "allowedEnv": []
  }
]
```

使用 `node .agents/runtime/commands/run.mjs verify --project . --micro normalize-example --plan --json` 查看计划，去掉 `--plan` 才执行。未声明 ID 和旧 `command` 格式在受管入口被拒绝；普通 REPL 仅供探索。Micro 通过只证明局部观察，任务完成仍须运行受影响的正式测试；不可信 probe 的网络隔离不能仅靠 Node 权限模型，细节见 [Micro 规则](docs/rules/micro-verification.md)。

## 全量安装（推荐）

一条提示词即可完成 full profile、全部稳定工具插件、Linear 读写集成与 memory 资产的多宿主安装，不必再逐个启用插件、Linear 或宿主：

    将 Vibe-Harness 全量安装（--preset everything）到 TARGET_PROJECT_ABSOLUTE_PATH，宿主为 codex、zcode、opencode。你在 Vibe-Harness 仓库中执行：
    pnpm install
    pnpm vibe-harness init --project <TARGET_PROJECT_ABSOLUTE_PATH> --targets codex,zcode,opencode --preset everything
    pnpm vibe-harness install --project <TARGET_PROJECT_ABSOLUTE_PATH> --write --confirm-red-zone
    pnpm vibe-harness validate --project <TARGET_PROJECT_ABSOLUTE_PATH>
    pnpm vibe-harness doctor --project <TARGET_PROJECT_ABSOLUTE_PATH>
    只有目标项目缺少 vibe-harness.config.json 时才需要 init；我授权本次安装写入项目级 Hook 与 MCP 红区配置，并放行 zcode/opencode 的预览能力。everything 已内含 provision，无需再写 --provision。只写目标项目，不修改全局 Agent、MCP 或 Git 配置；报告实际写入与未完成项。

等价命令：

```bash
pnpm install
pnpm vibe-harness init --project ../full-project --targets codex,zcode,opencode --preset everything
pnpm vibe-harness install --project ../full-project --dry-run
pnpm vibe-harness install --project ../full-project --write --confirm-red-zone
pnpm vibe-harness validate --project ../full-project
pnpm vibe-harness doctor --project ../full-project
```

`--preset everything` 展开为 full、三个受管 runtime 插件、Linear 读写与 memory；`--plugin all` 仅选择三个 runtime 插件。红区写入仍需 `--confirm-red-zone`。

```json
{
  "targets": ["codex", "zcode", "opencode"],
  "profile": "full",
  "preset": "everything"
}
```

## 快速开始

需要 pnpm 10+，以及 Node.js 20.19+、22.18+ 或 24+。

在 Vibe-Harness 仓库中选择并复制下面一条提示词，将 TARGET_PROJECT_ABSOLUTE_PATH 替换为目标项目绝对路径。先确定项目需要的全部宿主，并将 codex、claude、gemini、cursor、qoder、zcode、antigravity 或 opencode 写入唯一、非空的 targets 数组。三条提示词面向首次安装；已有安装使用后文的升级流程。

以下提示词中的宿主选择应覆盖项目实际使用的全部八类 adapter，并写入同一个 targets 数组；不要按编辑器分别安装。

### minimal

    将 Vibe-Harness minimal profile 安装到 TARGET_PROJECT_ABSOLUTE_PATH。你正在 Vibe-Harness 仓库中执行：先检查 Node.js 与 pnpm 版本并安装本仓库依赖；根据当前 Agent 宿主选择 codex、claude 或 gemini adapter。若目标项目不存在 vibe-harness.config.json，则用所选 adapter 和 minimal profile 初始化；若配置或已有安装状态不匹配，停止并报告，禁止使用 --force。先执行 install dry-run，确认没有冲突、越界写入或意外覆盖后再使用 --write 正式安装，最后运行 validate --project。minimal 不安装任何可选插件，也不建立代码索引。只允许写入目标项目，不修改全局 Agent、MCP 或 Git 配置。报告实际写入、验证结果和任何未完成项。

### core（推荐）

    在 TARGET_PROJECT_ABSOLUTE_PATH 安装 core profile。先检查 dry-run，再对授权范围使用 --write，红区追加 --confirm-red-zone；不使用 --force，不修改全局配置。codebase-memory-mcp 仅分发使用规范，不安装工具、不写 MCP 配置、不构建索引。最后执行 validate 和 doctor。

### full

    在 TARGET_PROJECT_ABSOLUTE_PATH 安装 full profile。先检查 dry-run，再对授权范围使用 --write，红区追加 --confirm-red-zone；不使用 --force，不修改全局配置。codebase-memory-mcp 仅分发使用规范，不安装工具、不写 MCP 配置、不构建索引。最后执行 validate 和 doctor。

core/full 包含外部 codebase-memory-mcp 使用规范，不安装工具。等价 core 安装：

```bash
pnpm install
pnpm vibe-harness init --project ../some-project --target codex --profile core
pnpm vibe-harness install --project ../some-project --target codex --profile core --dry-run
pnpm vibe-harness install --project ../some-project --target codex --profile core --write --confirm-red-zone
pnpm vibe-harness validate --project ../some-project
pnpm vibe-harness verify --project ../some-project --plan
pnpm vibe-harness verify --project ../some-project --tier standard
pnpm vibe-harness verify --project ../some-project --full
pnpm vibe-harness doctor --project ../some-project
```

`validate` 只检查安装一致性，不执行任何测试。执行项目验证使用：

```bash
pnpm vibe-harness verify --project ../some-project
```

`verify` 不带 `--tier` 时默认只执行快速层，层命令来自项目 `vibe-harness.config.json` 的 `validationCommands.tiers`（未声明时按包脚本推导，完全推导不出才退回 changed paths 驱动的 `auto` 风险计划）。快速层是默认路径，中等层与深度层必须显式升级：`--tier standard|deep` 按层累计，`--full` 运行完整矩阵并与 `--tier` 互斥。`--plan` 只预览计划——范围与成本层、选中检查、被延迟的 `deferredChecks` 与其下一层入口 `nextTier`、以及标记为 `not_selected` 的未选中项（未配置项保持 `not_configured`）——不执行任何命令。

三种结论互不替代：`validate` 只证明安装一致，快速层 `verify` 只证明当前实施单元未被破坏，集成、发布或整体完成必须取得 `--tier standard|deep` 或 `--full` 的对应证据；快速层通过时收据标注 `scopeStatus: partial`，未取得被延迟层证据前不得对外宣称完成。

验证 JSON 还包含本轮 ID、时间和非持久化 Git 工作树指纹；检查期间工作树变化时返回 PROJECT_VERIFICATION_STALE。

### 项目内确定性脚本

`core` 和 `full` 默认安装项目级脚本入口；`minimal` 与 `docs-only` 不安装。它们把可机械核验的工作交给脚本，把范围选择和结果解释留给 Agent：

```bash
node .agents/runtime/commands/run.mjs env --project . --json
node .agents/runtime/commands/run.mjs context --project . --json
node .agents/runtime/commands/run.mjs changes --project . --json
node .agents/runtime/commands/run.mjs verify --project . --plan --json
node .agents/runtime/commands/run.mjs verify --project . --json
node .agents/runtime/commands/run.mjs worktree check --project . --strict --json
node .agents/runtime/commands/run.mjs slice --project . --file <path> --from <n>
node .agents/runtime/commands/run.mjs patch --project . --spec <spec.json>
```

`verify --plan` 只预览已配置检查，不执行命令；脚本不提供任意命令执行接口，不自动修改配置或联网。验证命令来自 `vibe-harness.config.json` 的 `validationCommands`，失败、超时、危险命令和验证期间工作树变化都会明确报告。成本分层按「最小充分成本」默认走快：`verify` 不带 `--tier` 时只执行快速层（随改动同步、失败阻塞当前实施单元），中等层与深度层必须显式升级——`--tier standard|deep` 选定成本层，`--full` 运行完整风险矩阵与全部声明层。快速层通过时收据标注 `scopeStatus: partial` 并列出被延迟的检查与下一层入口，未取得被延迟层的证据前不得宣称集成、发布或整体完成。

`worktree`、`slice` 和 `patch` 默认只读：`worktree check` 汇总隔离单元、merge-back、依赖链接与端口登记事实并给出 `cleanupAllowed` 建议；`worktree bootstrap` 按六步（`worktree add` → 依赖链接 → 端口分段与 env 文件 → 声明的 envFiles → 声明的 setupCommands → 工具链探针）执行，默认只出计划、追加 `--write` 才落盘，目标命中 `hooks.redZonePaths` 时还需 `--confirm-red-zone`；端口按主检出 `.vibe-harness/worktree-ports.json` 的登记表分段并由 `.vibe-harness/worktree-ports.lock` 串行化，主检出缺 `node_modules` 时 bootstrap 以 `blocked` 结束而不是静默继续。`worktree cleanup` 只在追加 `--write` 时落盘，且 cleanup 在分支尚未并入 `worktree.baseRef` 或工作区不干净时拒绝执行、绝不删除分支；`worktree recover` 清理崩溃残留——引导中断留下的不完整 worktree、目录已消失的 prunable 绑定与带归因证据的孤立分支/端口登记——同样默认只出计划，分支删除仅限从未离开基线的证据门内；`slice` 打印指定行区间，`patch` 按 spec 在内存中完成带守卫的区间或序列替换，全部通过后才写盘。三者替代 `node -e` 内联片段与项目内一次性脚本。

## 多宿主安装

同一个项目只安装一次。配置中的 targets 数组声明全部宿主；不带 --target 的 install、upgrade、verify、validate、doctor 和 diff 处理全部目标，带 --target 时只选择配置或 install-state 中仍存在的一个宿主，绝不隐式追加。

公共规则、runtime、memory 和 Eval在项目根以 shared owner 维护一份；宿主入口、原生 Skills、MCP 和 Hook 以 adapter:id owner 维护投影。不要在项目子目录重复安装来模拟多宿主支持。

## 执行模型

- 快速：只读、解释、文档和微小非行为变化，通常只需静态核对。
- 轻量：可逆的本地行为改动，运行与受影响范围匹配的检查。
- 完整：安全、生产、发布、数据迁移、公共契约、红区、不可逆或跨仓变更，扩大验证并准备回滚。

单 Agent 默认完成任务。用户显式调用的 `open-code-review`、浏览器验证、Eval 和项目测试仍可正常使用。任务 Markdown 是可选的人读记录，不参与运行时判断。

## Profiles and roles

core 安装十一个原生 Skills，full 安装十四个原生 Skills，并默认启用七个角色人格。角色系统采用“单主角色动态切换”：每个原子动作只激活一个角色，可叠加至多一个领域 Skill；它不是固定七阶段流水线。

| Profile | 安装内容 |
| --- | --- |
| `minimal` | 平台说明、安全边界、Git/Test 规则和可选任务/交付模板 |
| `core` | `minimal` 加通用工程规则、十一个原生 Skills、项目内确定性脚本和离线 Eval |
| `full` | `core` 加三个原生 Skills、在线 Eval 和已支持宿主的安全 Hook，共十四个原生 Skills |
| `docs-only` | 规则、模板和 schemas，不安装 runtime、Skills、MCP 或 Hook |

三个显式交付 Skill 统一采用显示名 `Vb …` 和调用标识 `vb-…`：

| 显示名称 | 调用标识 | 兼容旧触发词 |
| --- | --- | --- |
| Vb Git Split Push | `$vb-git-split-push` | `$git-deliver` |
| Vb Git Develop Flow | `$vb-git-develop-flow` | `$gd-flow` |
| Vb Linear Worktree Develop | `$vb-linear-worktree-develop` | `$lwflow` |

Split Push 复用原 git-deliver 能力，按项目 Git 规范和逻辑变更分批提交，验证通过后普通推送当前分支；不创建 worktree 或执行合并。旧名称仅作兼容触发词；升级安装会迁移受管旧 Skill 文件，本地修改过的副本由安装器保留并报告冲突。

显式调用 `$vb-git-develop-flow` 可在仓库外 worktree 实现并本地合入、推送 `develop`；安装可写 Linear 插件后显式调用 `$vb-linear-worktree-develop` 可先把当前计划同步为 Parent/子任务 DAG，再仅执行本次节点。两者不新增终端命令，也不修改默认 delivery；主检出不干净或缺少必要写入/Claim 能力时停止。

外部工具仍只通过 `--plugin` 显式启用。所有宿主配置文件均属于红区写入，需要 `--confirm-red-zone`。

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
    "eval": null,
    "tiers": {
      "quick": [],
      "standard": [],
      "deep": []
    }
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
    "allowedEgressHosts": []
  },
  "riskZones": {
    "red": ["auth", "secrets", "ci-cd", "env"],
    "yellow": ["shared-libs", "state", "routing", "io-clients"],
    "pathPatterns": { "red": [], "yellow": [] }
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

受管 runtime 插件为 `chrome-devtools-mcp`、`playwright-cli` 和 `open-code-review`。codebase-memory-mcp 使用规范随通用规则分发，工具由用户或宿主独立管理。

```bash
pnpm vibe-harness install --project ../some-project --target codex --profile core --plugin chrome-devtools-mcp --dry-run
pnpm vibe-harness install --project ../some-project --target codex --profile core --plugin chrome-devtools-mcp playwright-cli --write
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

preserve-retired 选项会保留升级计划中本应退休的资产，并在结果中报告 retained；不使用该选项时，升级退休行为保持不变。

### 退出码

| 退出码 | 含义 |
|--------|------|
| 0 | 成功（或降级但传了 `--allow-degraded`）。 |
| 1 | 失败：状态无效、安装错误或未处理异常。 |
| 2 | 部分跳过：卸载或回滚因用户修改保留了部分文件；或健康检查降级且未传 `--allow-degraded`。 |

## 安全边界

- 未使用 `--force` 时不覆盖已有项目文件。项目自有的受管种子（`docs/memory/*`、`.agents/memory/*`）在内容漂移时保留项目内容、把当前内容重新记录为基线，并在 `retainedProjectOwned`（`reason: project-owned-drift`）与 `PROJECT_OWNED_FILE_RETAINED` 告警中报告；其他受管文件漂移仍然以 `Refusing to upgrade user-modified file` 拒绝。
- 所有真实写入使用 `--write`；红区写入需要显式确认。
- 安装器不修改全局 Agent 配置或 `.git/config`。
- Codex、Cursor、Qoder 和 ZCode Hook 会把 `PreToolUse` 和权限事件归一到同一安全策略，用于阻止危险 Git、全局配置写入、凭据外传、红区文件上传、越界写入，以及（配置 `allowedEgressHosts` 白名单后）非白名单主机出口。RTK Hook 路由仍只支持 Codex。
- 完成主张必须由本轮有效证据支持；无法验证时缩小主张并说明风险。

## Roles

full 默认启用七个角色人格，其他 profile 可用 roles.enabled 显式启用。每个原子动作只激活一个角色，并可叠加至多一个领域 Skill；目标或动作类型改变时才重新路由。ZCode 角色插件只写项目目录，doctor 报告 manual-activation-required；宿主权限表达不足时报告降级映射。角色配置、权限和路由详见 [角色文档](docs/roles.md)。

## 文档

- [文档索引](docs/README.md)
- [架构](docs/architecture.md)
- [迁移指南](docs/migration-guide.md)
- [Hook 安全策略](docs/hooks.md)
- [Eval](docs/evals.md)
- [贡献指南](CONTRIBUTING.md)

## License

[MIT](LICENSE)
