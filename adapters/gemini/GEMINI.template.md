# GEMINI.md

项目：{{projectName}}

## 启动

1. 先读取 `docs/rules/governance-core.md`；只有出现 Skill 或专项领域信号时再读取 `docs/rules/AGENT_SKILL_ROUTING.md` 和一个命中的专项规则。
2. {{projectProfile.vcsStatusInstruction}}
3. {{installedSurface.discoveryLine}}
4. 将任务归为快速、轻量或完整，并选择与主张匹配的验证。
5. 使用“获取事实 → 直接执行 → 聚焦验证 → 简洁交付”的单一路径；宿主按 description 直接选择领域 Skill。

## 硬边界

- 只在授权范围内行动；红区、生产、权限、凭据、外部写入和不可逆操作先获人工确认。
- 不编造事实或证据；没有本轮有效验证不得声称完成。
- 任务记录是可选的人读文档，不触发测试、Review、子 Agent 或完成门禁。
- 当前宿主无运行时安全 Hook，红区与出口保护降级；敏感操作请依赖人工确认与代码审查。

## 默认验证命令

- Lint: {{validationCommands.lint}}
- Typecheck: {{validationCommands.typecheck}}
- Test: {{validationCommands.test}}
- Eval: {{validationCommands.eval}}

`vibe-harness validate --project` 只检查安装一致性；`vibe-harness verify --project <path>` 执行项目已配置的验证命令。测试范围细则见 `docs/rules/test-rules.md`。

## 已安装表面

{{installedSurface.profileLine}}
{{installedSurface.codebaseMemoryMcpLine}}
{{installedSurface.rulesLine}}
{{installedSurface.engineeringRulesLine}}
{{installedSurface.operationalRulesLine}}
{{installedSurface.templatesLine}}
{{installedSurface.skillsLine}}
{{installedSurface.memorySkillsLine}}
{{installedSurface.hooksLine}}
{{installedSurface.toolingLine}}
{{installedSurface.skillRoutingLine}}

规则优先级：平台系统与用户本轮指令优先；目标项目明确的本地规则优先于 Vibe-Harness 默认规则；目录级规则只作用于其子树。同一层级冲突时停止并请求确认。
