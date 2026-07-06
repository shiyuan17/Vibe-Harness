# LoopEngine

LoopEngine 是一套 Codex 优先的可复用 AI coding governance 包。它把协作规则、workflow 档位、任务生命周期模板、skills、manifests 和默认 dry-run 的安装器打包在一起，让新项目可以快速接入一套更稳的 Agent 协作流程。

LoopEngine 参考 ECC 的组织方式：规则、skills、manifests、adapters、installer。`0.1.0` 版本聚焦内部 Codex 复用，不承诺完整多工具适配。

## 快速开始

```bash
pnpm install
pnpm check
pnpm loopengine install --target ../some-project --profile codex-internal --dry-run
```

安装器默认 dry-run。真实写入 Codex hook 文件时，需要显式添加 `--apply --confirm-red-zone`。

## Profiles

- `codex-internal`：安装 AGENTS、规则、模板、核心 skills、workflows 和 Codex hooks。
- `codex-minimal`：安装 AGENTS 与最小规则/模板集。
- `docs-only`：只安装规则、模板和 workflows。

## 安全边界

LoopEngine 不写入全局 Codex 配置。目标项目已有文件默认不覆盖；如需覆盖必须显式使用 `--force`。`.codex/hooks.json` 等红区文件在非 dry-run 安装时必须显式确认。
