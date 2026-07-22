# AGENTS.md

项目：{{projectName}}

## 启动

1. 阅读 `docs/rules/governance-core.md`、`docs/rules/AGENT_SKILL_ROUTING.md` 和命中场景的专项规则。
2. {{projectProfile.vcsStatusInstruction}}
3. {{installedSurface.discoveryLine}}
4. 将任务归为快速、轻量或完整，并确定验证方式。
5. 已安装 Skills 时先使用 `using-cognis` 路由；Skills 未安装时按路由规则和治理内核 fallback 执行。

## 硬边界摘要

- 只在授权范围内行动；红区、不可逆操作和范围扩大先获人工确认。
- 不编造事实或证据，没有本轮验证不声称完成；详细门禁以治理内核为唯一真值。
- 任务确认、验证证据、轻量反证、独立审查和交付字段只在治理内核与模板维护细则。

## 默认验证命令

- Lint: {{validationCommands.lint}}
- Typecheck: {{validationCommands.typecheck}}
- Governance: {{validationCommands.governance}}

`cognis validate --project` 只检查安装一致性；执行项目命令使用 `cognis verify --project <path>`。manual 和测试范围细则分别以治理内核及 `docs/rules/test-rules.md` 为准。

## 已安装表面

{{installedSurface.profileLine}}
{{installedSurface.codebaseMemoryMcpLine}}
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
