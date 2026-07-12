# Agentmemory Skill 收敛规格

## 目标

- `full` / `codex-internal` 只暴露一个顶层 `agentmemory` skill。
- 保存、检索、恢复、遗忘、汇总和 session 历史流程作为入口内的按需 references。
- 已安装旧入口通过显式、可审查、可回滚的升级动作退役，不删除用户拥有或修改的文件。

## 安装契约

- `install-map.entries` 描述当前安装面；`retiredEntries` 只描述明确退役的受管目标。
- `retiredEntries` 项结构为 `{ group, target, redZone? }`，目标不得重复、越界或与当前 entry 冲突。
- 普通安装忽略退役声明。仅 `--upgrade`、profile 包含对应 group、旧 install state 管理该目标且文件存在时生成退役动作。
- 当前 hash 等于旧 `targetHash` 时生成 `retire`；否则生成非阻塞的 `retire-modified` 并保留文件。

## 写入与回滚

- `retire` 在删除前再次校验 hash 并写入项目内 backup，删除后记录到 install state 的 `retiredFiles`。
- rollback 对缺失目标执行 `restore-retired`；目标已被重新创建时以 `target-recreated` 跳过。
- full MVP 真实升级使用 `--project <path> --target codex --profile full --write --upgrade --confirm-red-zone`；legacy/internal 使用 `--target <path> --profile codex-internal --apply --upgrade --confirm-red-zone`。
