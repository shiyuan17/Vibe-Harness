# LoopEngine v0.2 安装器增强规格

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
- `codegraph install-cli` 通过显式子命令安装全局 CodeGraph CLI，安装后运行 `codegraph --version` 验证。
- `codegraph status` 只检查 CLI 状态、版本和目标项目 `.codegraph/` 是否存在，不创建索引。
- `doctor` 输出 CodeGraph 状态，但不因 CLI 缺失失败。

## 接口

- `loopengine diff --target <path> --profile <name>`
- `loopengine install --target <path> --profile <name> --apply --upgrade`
- `loopengine rollback --target <path> [--dry-run] [--apply] [--confirm-red-zone]`
- `loopengine init --project <path> [--force]`
- `loopengine install --project <path> --target codex --profile minimal|core|full [--dry-run] [--write] [--force]`
- `loopengine validate --project <path>`
- `loopengine codegraph install-cli [--dry-run] [--version <version>]`
- `loopengine codegraph status [--target <path>]`

## 非目标

- 不新增非 Codex adapter。
- 不写入全局 Codex 配置。
- 不自动合并用户改过的文档。
- 不自动运行 `codegraph init`，不提交 `.codegraph/`。
