# LoopEngine

LoopEngine 是一套 Codex 优先的可复用 AI coding governance 包。它把协作规则、workflow 档位、任务生命周期模板、skills、manifests 和默认 dry-run 的安装器打包在一起，让新项目可以快速接入一套更稳的 Agent 协作流程。

LoopEngine 参考 ECC 的组织方式：规则、skills、manifests、adapters、installer。`0.2.0` 版本继续聚焦内部 Codex 复用，并增强安装器的 diff、upgrade、backup 和 rollback 能力。

## 快速开始

```bash
pnpm install
pnpm check
pnpm loopengine install --target ../some-project --profile codex-internal --dry-run
pnpm loopengine diff --target ../some-project --profile codex-internal
pnpm loopengine validate --target ../some-project --profile codex-internal
```

安装器默认 dry-run；`--dry-run` 只是显式表达预览模式。真实写入必须添加 `--apply`。如果安装内容包含 `.codex/hooks.json` 等红区文件，还必须额外添加 `--confirm-red-zone`。

```bash
pnpm loopengine install --target ../some-project --profile codex-internal --apply --confirm-red-zone
```

`loopengine validate --target <path>` 用来检查目标项目是否已经具备当前 profile 期望的文件；不带 `--target` 时校验 LoopEngine 包自身。`loopengine doctor --target <path>` 会同时输出包校验结果和目标项目安装状态。

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

- `codex-internal`：安装 AGENTS、规则、模板、核心 skills、workflows 和 Codex hooks。
- `codex-minimal`：安装 AGENTS 与最小规则/模板集。
- `docs-only`：只安装规则、模板和 workflows。

## 安全边界

LoopEngine 不写入全局 Codex 配置。目标项目已有文件默认不覆盖；如需覆盖必须显式使用 `--force`。`.codex/hooks.json` 等红区文件在非 dry-run 安装时必须显式确认。

回滚策略保持简单透明：安装器只复制文件，不修改全局配置，不自动合并已有文件。真实安装或强制升级前会记录状态和备份；若需要撤销，优先使用 `loopengine rollback`，也可以按 `.loopengine/install-state.json` 中的记录手工处理。
