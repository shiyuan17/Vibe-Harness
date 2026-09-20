# Vibe-Harness 工作区规则

项目：{{projectName}}

实现前先读取 docs/rules/governance-core.md；仅当领域 Skill 的 description 与当前任务匹配时才加载。所有写入保持在项目内，红区（red zone）操作必须显式人工确认，并使用与变更面匹配的命令验证主张。

长任务（预计执行超过 60 分钟，或发生第一次上下文压缩）先建立状态锚点（已安装 Vibe-Harness 运行时命令的项目用 `node .agents/runtime/commands/run.mjs task init|update --project <path> --write`，锚点与收据位于 `.vibe-harness/tasks/`，重复验证用 `run.mjs verify --reuse`；已建锚点后再次压缩必须先更新锚点再继续写入）；项目未提供锚点入口时以最后一次交付记录充当恢复基准；命中 Skill 触发场景时先读该 Skill 的 SKILL.md 再行动。

编辑前先检查项目状态。任何红区操作都需人工确认，完成后验证结果。

{{installedSurface.memoryLoadLine}}
{{installedSurface.discoveryLine}}
{{installedSurface.clarificationPostureLine}}
{{installedSurface.responseModeLine}}
