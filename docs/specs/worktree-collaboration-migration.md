# Worktree 本地交付迁移

当前协议为事务 v6：stage 直接合并本地 develop，不访问远端、不运行质量验证、不推送。

## 新事务

- 主检出必须在 develop；dirty develop 自动 checkpoint，固定主题为 `chore(worktree): checkpoint local develop before merge`。
- 记录合并前 HEAD、checkpoint、事务 ID、冻结源 HEAD 和本地 merge commit；冲突保留主检出现场。
- 成功状态为 `local_integrated`；清理未完成为 `local_integrated_cleanup_pending`。两者都不证明远端交付。
- Harness 创建记录是自动清理依据；仅端口登记、目录名或宿主采用记录不能证明创建归属。
- Parent 成员提交映射留在 Git common dir，源树删除后仍可核对本地完成。

## 旧事务

v1–v5 仅只读展示、冲突恢复或安全丢弃，提示“旧远端事务需迁移”。不重放旧远端动作，也不根据旧字段生成本地完成证明。旧私有引用和历史记录保留供人工核对，不自动删用户数据。

本决策取代 ADR-0013、ADR-0017、ADR-0021、ADR-0024、ADR-0027 中的旧交付步骤；历史正文不改写。ADR-0014 的服务 teardown best-effort 原则继续有效，其旧命令示例不再作为当前入口。

## 安装与回滚

先用安装器 dry-run 查看差异，再按既有 `--write` 与红区确认规则更新目标项目。同步 runtime、规则、Skills 和安装映射；不修改全局 Agent 配置。

退役受管文件只在旧哈希匹配时移除，用户修改报告冲突。源码回滚使用本次逆向补丁，安装回滚使用安装器备份，不整仓 reset；已经生成的业务提交单独按其 SHA 处理，不自动撤销。
