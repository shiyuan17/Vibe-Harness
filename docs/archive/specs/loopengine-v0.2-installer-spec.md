# LoopEngine v0.2 安装器增强规格

状态：Superseded。当前安装器行为以 [`docs/architecture.md`](../../architecture.md) 和现行测试为准；本文仅保留 v0.2 历史合同。

## 目标

v0.2 聚焦安装器增强：保持 v0.1 CLI 兼容，同时新增状态记录、差异预览、可控升级、备份、回滚和 MVP 项目安装模式。

## 行为

- `install --apply` 写入目标项目 `.loopengine/install-state.json`。
- `diff` 输出 expected、missing、same、changed、redZone 和 unmanaged 文件。
- `install --upgrade` 只更新 LoopEngine 管理且 hash 可追踪的文件；用户修改过的 managed 文件默认拒绝。
- `install --upgrade --force` 或普通 `--force` 覆盖前必须备份目标文件。
- `rollback` 默认 dry-run；真实回滚必须使用 `--apply`。
- rollback 涉及 `.codex/**` 等红区文件时必须使用 `--confirm-red-zone`。
- rollback 不覆盖安装后又被用户修改的文件；这些文件会保留并在输出中进入 `skipped`。
- rollback apply 完成后删除 `.loopengine/install-state.json`，保留 backups 用于人工审计。
- `init --project` 写入 `loopengine.config.json` 默认配置。
- `install --project <path> --target codex --profile minimal|core|full` 渲染 Codex `AGENTS.md` 模板；默认 dry-run，真实写入使用 `--write`。
- MVP `--write` 遇到已有目标文件默认失败；只有显式 `--force` 时才备份并覆盖。
- `validate --project` 校验配置结构、生成内容红线、目标文件安装一致性和 pack 自身完整性。
- v0.3 起 full/internal 安装项目内 `codebase-memory-mcp` runtime、初始索引和 MCP 受管配置；minimal/core 不安装该 MCP。
- MCP 不可用时，Agent 明确说明能力缺失并退回仓库搜索和源码阅读。
- `doctor` 只输出 LoopEngine 包校验和目标项目安装状态。

## 接口

- `loopengine diff --target <path> --profile <name>`
- `loopengine install --target <path> --profile <name> --apply --upgrade`
- `loopengine rollback --target <path> [--dry-run] [--apply] [--confirm-red-zone]`
- `loopengine init --project <path> [--force]`
- `loopengine install --project <path> --target codex --profile minimal|core|full [--dry-run] [--write] [--force]`
- `loopengine validate --project <path>`

## 非目标

- 本历史规格只覆盖 Codex；当前 Claude/Gemini 项目级 adapter 以 `manifests/adapters.json` 和 `docs/architecture.md` 为准。
- 不写入全局 Codex 配置。
- 不自动合并用户改过的文档。
- MCP runtime 和配置仅位于目标项目，不写入全局 Agent 或 MCP 配置。
