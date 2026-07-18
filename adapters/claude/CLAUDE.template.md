# CLAUDE.md

项目：{{projectName}}

## 启动

1. 阅读 `docs/rules/governance-core.md`、`docs/rules/AGENT_SKILL_ROUTING.md` 和命中场景的专项规则。
2. {{projectProfile.vcsStatusInstruction}}
3. {{installedSurface.discoveryLine}}
4. 将任务归为快速、轻量或完整，并确定验证方式。
5. 已安装 Skills 时先使用 `using-cognis` 路由；Skills 未安装时按路由规则和治理内核 fallback 执行。

## 五条硬约束

1. 只在授权范围内行动，不覆盖无关改动。
2. 红区、不可逆操作和范围扩大必须先获得人工确认。
3. 不编造 API、字段、权限、数据、验证证据或发布结果。
4. 没有本轮新鲜证据，不声称完成、修复或通过。
5. 完整或高风险任务必须由独立核验者审查。

轻量反证：验证时记录“主张 → 证据 → 反例 → 剩余风险”。交付使用 `docs/templates/delivery.md`；任务需要持久化时使用中文 `docs/templates/task.md`。

## 默认验证命令

- Lint: {{validationCommands.lint}}
- Typecheck: {{validationCommands.typecheck}}
- Governance: {{validationCommands.governance}}

`cognis validate --project` 只检查安装一致性；实际执行配置命令使用 `cognis verify --project <path>`。manual 命令只有检查内容后才使用 `--allow-manual`。

## 已安装表面

{{installedSurface.profileLine}}
{{installedSurface.rulesLine}}
{{installedSurface.engineeringRulesLine}}
{{installedSurface.operationalRulesLine}}
{{installedSurface.templatesLine}}
{{installedSurface.skillsLine}}
{{installedSurface.memorySkillsLine}}
{{installedSurface.reviewLoopLine}}
{{installedSurface.hooksLine}}
{{installedSurface.toolingLine}}

{{installedSurface.skillRoutingLine}}

规则优先级：平台系统与用户本轮指令优先；目标项目明确的本地规则优先于 Cognis 默认规则；目录级规则只作用于其子树。同一层级冲突时停止并请求确认。
