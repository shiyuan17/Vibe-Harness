# GEMINI.md

项目：{{projectName}}

## 启动

1. 阅读 `docs/rules/governance-core.md`、`docs/rules/AGENT_SKILL_ROUTING.md` 和命中场景的专项规则。
2. {{projectProfile.vcsStatusInstruction}}
3. {{installedSurface.discoveryLine}}
4. 将任务归为快速、轻量或完整，并确定验证方式。
5. 当前运行 Workflow 为 `{{governance.workflow}}`；adaptive 默认直接执行结果优先主循环，strict 保留完整生命周期。已安装 Skills 由宿主按 description 原生选择，不使用 Router 或流程 Skill 链。

## 硬边界摘要

- 只在授权范围内行动；红区、不可逆操作和范围扩大先获人工确认。
- 不编造事实或证据，没有本轮验证不声称完成；详细门禁以治理内核为唯一真值。
- 验证证据必须来自本轮并与完成主张匹配；失败或未验证项如实报告。
- adaptive 不要求通用任务确认或固定 11 字段交付；strict 与完整任务的任务确认、审查和交付字段以治理内核与模板为准。
- strict 的轻量反证和完整交付合同只按治理内核触发，不扩展到 adaptive 普通任务。

## 默认验证命令

- Lint: {{validationCommands.lint}}
- Typecheck: {{validationCommands.typecheck}}
- Governance: {{validationCommands.governance}}

`cognis validate --project` 只检查安装一致性；执行项目命令使用 `cognis verify --project <path>`。manual 和测试范围细则分别以治理内核及 `docs/rules/test-rules.md` 为准。

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
