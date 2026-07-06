# LoopEngine

LoopEngine 是一套 Codex 优先的可复用 AI coding governance 包。它把协作规则、workflow 档位、任务生命周期模板、skills、manifests 和默认 dry-run 的安装器打包在一起，让新项目可以快速接入一套更稳的 Agent 协作流程。

LoopEngine 参考 ECC 的组织方式：规则、skills、manifests、adapters、installer。当前 MVP 聚焦 `Codex 可安装`：通过项目配置渲染 `AGENTS.md`，提供 `minimal` / `core` / `full` 三档 profile，并保留既有内部安装生命周期。

## 快速开始

```bash
pnpm install
pnpm loopengine init --project ../some-project
pnpm loopengine install --project ../some-project --target codex --profile core --dry-run
pnpm loopengine install --project ../some-project --target codex --profile core --write
pnpm loopengine validate --project ../some-project
```

MVP 模式使用 `--project <path>` 表示目标项目路径，使用 `--target codex` 表示安装 Codex adapter。安装器默认 dry-run；`--dry-run` 只打印目标路径、动作和渲染后的预览内容，不写文件。真实写入使用 `--write`，若目标文件已存在，会先备份到 `.loopengine/backups/`。

`loopengine.config.json` 示例：

```json
{
  "projectName": "ExampleProject",
  "language": "zh-CN",
  "packageManager": "pnpm",
  "target": "codex",
  "profile": "core",
  "validationCommands": {
    "lint": "pnpm lint",
    "typecheck": "pnpm check:type",
    "governance": "pnpm run check:governance"
  },
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

- `minimal`：入口红线、`git status --short`、红区人工确认、验证证据和 Workflow Packet。
- `core`：`minimal` + 八阶段 Workflow、lifecycle-v2 task 模型、templates、核心 skills 和 skill 路由。
- `full`：`core` + memory、review / open-code-review 优先策略、loop opt-in 规则。

## 验证门禁

```bash
pnpm test
pnpm run validate
git diff --check
```

`pnpm run validate` 会校验 manifest、install map、核心文件存在性，以及 reusable core 目录中是否出现源项目专属标识。

## 旧内部安装生命周期

旧命令仍可使用，用于包含 Codex hooks 的内部 profile：

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

- `minimal`：MVP 最小 Codex 包。
- `core`：MVP 标准 Codex 包。
- `full`：MVP 完整治理包，不安装 hooks。
- `codex-internal`：安装 AGENTS、规则、模板、核心 skills、workflows 和 Codex hooks。
- `codex-minimal`：安装 AGENTS 与最小规则/模板集。
- `docs-only`：只安装规则、模板和 workflows。

## 安全边界

LoopEngine 不写入全局 Codex 配置。目标项目已有文件默认不覆盖；如需覆盖必须显式使用 `--force`。`.codex/hooks.json` 等红区文件在非 dry-run 安装时必须显式确认。

回滚策略保持简单透明：安装器只复制文件，不修改全局配置，不自动合并已有文件。真实安装或强制升级前会记录状态和备份；若需要撤销，优先使用 `loopengine rollback`，也可以按 `.loopengine/install-state.json` 中的记录手工处理。
