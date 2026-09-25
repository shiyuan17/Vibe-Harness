# Vibe-Harness 迁移指南

## 旧产品边界

Vibe-Harness 不接管 Cognis 或 LoopEngine 安装。发现旧产品配置、状态目录或受管标记时会以 VIBE_HARNESS_LEGACY_UNSUPPORTED 拒绝写入；请先备份并移除旧资产，再初始化 Vibe-Harness。

已删除的 governance.mode、governance.workflow、hooks.completionGate 和 validationCommands.governance 会触发 VIBE_HARNESS_OBSOLETE_GOVERNANCE_CONFIG。Vibe-Harness 不静默兼容或改写这些配置。

## target 与 state 迁移

旧标量 target 仍可读取，但禁止与 targets 同时存在。只有 install --upgrade --write 会在同一事务中将旧配置持久化为唯一、非空的 targets 数组，并将 state v4 的 adapter 与无 owner 记录迁移为 state v5 的 targets 和 owners。

迁移前先执行 install --upgrade --dry-run。若任一宿主投影、同路径内容或结构化 MCP/Hook 节点冲突，事务不会写入配置、投影或 state。红区写入仍要求 --confirm-red-zone。

## 验证分层迁移

validationCommands.tiers.quick/standard/deep 是可选的分层验证面；缺少该字段的旧配置仍可运行，verify 按目标项目声明的包脚本推导有效层，推导不出任何命令时退回风险计划。

行为变化：verify 不再默认执行 lint/typecheck/test/eval 四项。不带 --tier 时只执行快速层，快速层通过仍返回 status ready，但收据标注 scopeStatus: partial 并列出被延迟的检查与下一层入口；全部声明层改由 --tier standard|deep 显式表达（按层累计只执行各层声明的命令），--full 则在全部层命令之外追加风险派生检查、运行完整风险矩阵并与 --tier 互斥。CI 或发布门禁若要保持旧的全量语义，改用 --tier deep（或 --full），只声明快速层的项目不受影响。

只有 install --upgrade 会补齐缺失的层键：它按目标项目声明的脚本与固定的 Maven/.NET 入口保守推导，已有数组（包括空数组，表示该层被显式禁用）不会被覆盖。dry-run 会显示 configUpdate.addedTiers 与推导结果；真实写回 vibe-harness.config.json 属于红区写入，必须显式传 --confirm-red-zone，并在同一事务内回滚。

## 多宿主生命周期

- 不带 --target 的 install、upgrade、validate、doctor 和 diff 处理全部配置目标。
- --target 只选择配置或状态中仍存在的宿主，不会隐式添加。
- 手工从配置删除 target 只报告 stale projection；必须通过 uninstall --target id --write 显式移除。
- 最后一个目标和共享资产必须通过 uninstall --all-targets --write 移除。
- 单宿主卸载不得删除 shared runtime、memory、Eval 或项目根索引。

## 启用安装预设

已有安装可以在不改动其它宿主的前提下升级到聚合安装面：先执行 install --preset everything --dry-run，检查 configUpdate、requestedPlugins、requestedModules、targets 与红区计划，再用 install --preset everything --write --confirm-red-zone 把 preset 与 profile 写入 vibe-harness.config.json，并在同一事务内安装展开后的插件与 memory 模块。

补写 preset 属于红区写入，缺少 --confirm-red-zone 时命令直接拒绝。写入后 validate 与 doctor 不接受 --preset，只按配置重放同一安装面；继续使用无 preset 配置的安装不受影响，也不需要迁移。

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

## 项目自有种子漂移

docs/memory/* 和 .agents/memory/* 是项目自有的受管种子：安装器只播种一次，之后由项目维护。升级或重装时若这些文件与 install-state 记录的基线不同，安装器保留项目写入的内容、把当前内容重新记录为新基线，并在报告里以 retainedProjectOwned（reason: project-owned-drift）和 PROJECT_OWNED_FILE_RETAINED 告警列出，不再以 Refusing to upgrade user-modified file 中断。dry-run 也会列出同样的目标。

其他受管文件（rules、roles、skills、runtime 等）漂移仍然 fail-closed：--force 会先备份再覆盖，否则必须先手工收敛内容。角色文件的处理维持不变，见 Role migration。

## Role migration

升级到包含角色模块的 full profile 会生成宿主中立的 .agents/roles/ 和对应的原生 Agent 投影。旧安装不会被强制替换：非受管同名文件直接冲突，用户修改过的受管角色在 upgrade、rollback 和 uninstall 时保留并报告。禁用角色会在下一次升级中按 hash 安全退役。

ZCode 只生成项目内插件目录，不写全局 agents；完成安装后须在 ZCode 中手动启用，doctor 状态为 manual-activation-required。Gemini 与 ZCode 的角色能力保持 preview，未完成 canary 前不得宣称 stable。

## Breaking workflow migration

- 升级会移除 Vibe-Harness 管理的 Stop Hook 和未修改的 auto-commit runtime。用户自定义 Hook、未标记的 Stop 节点和已修改 runtime 会保留并在结果中报告。
- Vibe-Harness 不再自动执行 git commit 或 git push。提交与推送只能在用户明确授权后人工执行。
- 自动化脚本必须将 pnpm eval:offline 改为 pnpm eval:replay；旧命令和脚本不保留兼容入口。
- Codex Hook 定义变更后，项目文件一致性不代表 runtime 已激活。升级后在 Codex 中运行 /hooks，重新复核并信任当前项目定义。
