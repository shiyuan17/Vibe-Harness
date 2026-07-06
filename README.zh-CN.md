# LoopEngine

LoopEngine 是一套 Codex 优先的可复用 AI coding governance 包。它把协作规则、workflow 档位、任务生命周期模板、skills、manifests 和默认 dry-run 的安装器打包在一起，让新项目可以快速接入一套更稳的 Agent 协作流程。

LoopEngine 参考 ECC 的组织方式：规则、skills、manifests、adapters、installer。`0.1.0` 版本聚焦内部 Codex 复用，不承诺完整多工具适配。

## 快速开始

```bash
pnpm install
pnpm check
pnpm loopengine install --target ../some-project --profile codex-internal --dry-run
pnpm loopengine validate --target ../some-project --profile codex-internal
```

安装器默认 dry-run；`--dry-run` 只是显式表达预览模式。真实写入必须添加 `--apply`。如果安装内容包含 `.codex/hooks.json` 等红区文件，还必须额外添加 `--confirm-red-zone`。

```bash
pnpm loopengine install --target ../some-project --profile codex-internal --apply --confirm-red-zone
```

`loopengine validate --target <path>` 用来检查目标项目是否已经具备当前 profile 期望的文件；不带 `--target` 时校验 LoopEngine 包自身。`loopengine doctor --target <path>` 会同时输出包校验结果和目标项目安装状态。

## Profiles

- `codex-internal`：安装 AGENTS、规则、模板、核心 skills、workflows 和 Codex hooks。
- `codex-minimal`：安装 AGENTS 与最小规则/模板集。
- `docs-only`：只安装规则、模板和 workflows。

## 安全边界

LoopEngine 不写入全局 Codex 配置。目标项目已有文件默认不覆盖；如需覆盖必须显式使用 `--force`。`.codex/hooks.json` 等红区文件在非 dry-run 安装时必须显式确认。

回滚策略保持简单透明：安装器只复制文件，不修改全局配置，不自动合并已有文件。真实安装前先保存 dry-run 输出；若需要撤销，按输出中的 `target` 列表删除本次新增文件，或从项目版本控制中还原。
