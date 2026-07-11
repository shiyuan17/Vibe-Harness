# AGENTS.md - LoopEngine 贡献指南

LoopEngine 用来打包可复用的 AI coding governance 资产。源项目只能作为只读输入；通用核心内容不得包含项目专有标识；声称完成前必须验证安装器和校验器行为。

## 命令面边界

- MVP 接入命令使用 `--project <temp-project> --target codex --write`。
- legacy/internal profile 使用 `--target <temp-project> --apply --confirm-red-zone`。
- 不要混用 `--project` 和 legacy `--apply` 语义；文档、测试和交付说明必须写清使用的是哪条生命周期。

## 必跑检查

- `pnpm test`
- `pnpm check`
- `pnpm loopengine init --project <temp-project>`
- `pnpm loopengine install --project <temp-project> --target codex --profile core --dry-run`
- `pnpm loopengine install --project <temp-project> --target codex --profile core --write`
- `pnpm loopengine validate --project <temp-project>`
- `pnpm loopengine install --target <temp-project> --profile codex-internal --dry-run`
- `pnpm loopengine install --target <temp-project> --profile codex-internal --apply --confirm-red-zone`
- `pnpm loopengine validate --target <temp-project> --profile codex-internal`
- `pnpm loopengine doctor --target <temp-project>`

## 安全规则

1. 安装器不得写入全局 Agent 配置。
2. 未使用 `--force` 时不得覆盖目标项目已有文件。
3. 真实写入必须使用 `--apply`；未显式确认时不得写入红区文件。
4. 项目专有示例不得进入 `rules`、`templates`、`skills/core`、`workflows`、`adapters`、`manifests`、`schemas` 等通用核心目录。
5. 优先用 dry-run 和命令输出作为证据，不用猜测代替验证。

## CodeGraph

若仓库根目录存在 `.codegraph/`，理解或定位代码前先使用 CodeGraph；若不存在则跳过，不要擅自初始化。未安装 CLI 时先运行 `loopengine codegraph install-cli`。
