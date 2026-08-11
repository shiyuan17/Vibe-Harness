# Vibe-Harness 迁移指南

## 旧产品边界

Vibe-Harness 不接管 Cognis 或 LoopEngine 安装。发现旧产品配置、状态目录或受管标记时会以 VIBE_HARNESS_LEGACY_UNSUPPORTED 拒绝写入；请先备份并移除旧资产，再初始化 Vibe-Harness。

已删除的 governance.mode、governance.workflow、hooks.completionGate 和 validationCommands.governance 会触发 VIBE_HARNESS_OBSOLETE_GOVERNANCE_CONFIG。Vibe-Harness 不静默兼容或改写这些配置。

## target 与 state 迁移

旧标量 target 仍可读取，但禁止与 targets 同时存在。只有 install --upgrade --write 会在同一事务中将旧配置持久化为唯一、非空的 targets 数组，并将 state v4 的 adapter 与无 owner 记录迁移为 state v5 的 targets 和 owners。

迁移前先执行 install --upgrade --dry-run。若任一宿主投影、同路径内容或结构化 MCP/Hook 节点冲突，事务不会写入配置、投影或 state。红区写入仍要求 --confirm-red-zone。

## 多宿主生命周期

- 不带 --target 的 install、upgrade、validate、doctor 和 diff 处理全部配置目标。
- --target 只选择配置或状态中仍存在的宿主，不会隐式添加。
- 手工从配置删除 target 只报告 stale projection；必须通过 uninstall --target id --write 显式移除。
- 最后一个目标和共享资产必须通过 uninstall --all-targets --write 移除。
- 单宿主卸载不得删除 shared runtime、memory、Eval 或项目根索引。

## 嵌套旧安装

禁止通过子目录重复安装来模拟多宿主。doctor 发现根安装与子目录旧安装后，只报告问题，不自动删除。

无损迁移顺序固定为：

1. 在根项目配置全部 targets。
2. 在根项目执行 dry-run upgrade。
3. 在根项目执行 upgrade write；涉及红区时显式确认。
4. 对根项目执行全目标 validate 和 doctor。
5. 分别在每个嵌套安装根执行显式完整卸载。

嵌套项目目录和用户文件不会自动删除。卸载前确认 doctor 报告的路径和 install-state 版本，并保留已修改受管文件的冲突报告。

## 命令边界

所有项目命令使用 --project path；--target 只选择 adapter。所有真实修改使用 --write，不使用 --apply。完整流程优先 dry-run，并以 validate、doctor 和命令输出作为迁移证据。

## Breaking workflow migration

- 升级会移除 Vibe-Harness 管理的 Stop Hook 和未修改的 auto-commit runtime。用户自定义 Hook、未标记的 Stop 节点和已修改 runtime 会保留并在结果中报告。
- Vibe-Harness 不再自动执行 git commit 或 git push。提交与推送只能在用户明确授权后人工执行。
- 自动化脚本必须将 pnpm eval:offline 改为 pnpm eval:replay；旧命令和脚本不保留兼容入口。
- Codex Hook 定义变更后，项目文件一致性不代表 runtime 已激活。升级后在 Codex 中运行 /hooks，重新复核并信任当前项目定义。
