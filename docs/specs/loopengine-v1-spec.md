# LoopEngine v1 规格

状态：Superseded。本文仅保留 legacy/internal v1 基线；当前治理契约以 `loopengine-v0.5-simplified-governance-spec.md` 为准。

## 目标

构建一套可复用的 Codex 优先 AI coding governance 包，并通过默认 dry-run 的 CLI 安装到其他项目中。

## 成功标准

- 项目可以独立使用，包含自己的 package manifest、测试、校验器、manifests、规则、模板、skills、workflows 和 Codex adapter。
- `loopengine install` 能为 `codex-internal`、`codex-minimal`、`docs-only` 三个 profile 生成安装计划。
- 默认不覆盖目标项目已有文件。
- 写入红区 Codex hook 文件必须显式确认。
- 通用核心目录不得包含源项目标识、个人绝对路径、具体任务编号或领域业务词。

## 非目标

- 完整多 harness 兼容延后处理。
- 不迁移运行时应用代码。
- 不写入全局 Codex 配置。
- 项目专有业务契约只能放在 examples 中。

## 接口

- `loopengine install --target <path> --profile <name> [--dry-run] [--apply] [--force] [--confirm-red-zone]`
- `loopengine validate --target <path>`
- `loopengine doctor --target <path>`

安装默认 dry-run。真实写入必须使用 `--apply`；红区写入必须同时使用 `--confirm-red-zone`。`--apply` 与 `--dry-run` 不应同时出现。

`validate` 不带 `--target` 时校验 LoopEngine 包自身；带 `--target` 时检查目标项目是否已经具备所选 profile 的期望文件。`doctor` 用于输出包校验和目标安装状态。

## 验证

发布前运行 `pnpm check`，对临时目标目录执行 dry-run install、真实安装 smoke、`loopengine validate --target <temp-project>` 和 `loopengine doctor --target <temp-project>`。
