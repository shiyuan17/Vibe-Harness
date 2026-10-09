# GEMINI.md

项目：{{projectName}}

## 启动

{{installedSurface.startupLines}}

## 硬边界

{{managedBlock.hardBoundsLines}}
- 当前宿主无运行时安全 Hook，红区与出口保护降级；敏感操作请依赖人工确认与代码审查。

## 默认验证命令

- Lint: {{validationCommands.lint}}
- Typecheck: {{validationCommands.typecheck}}
- Test: {{validationCommands.test}}
- Eval: {{validationCommands.eval}}

{{managedBlock.verifySemanticsLine}}

## 已安装表面

{{installedSurface.profileLine}}
{{installedSurface.codebaseMemoryMcpLine}}
{{installedSurface.rulesLine}}
{{installedSurface.templatesLine}}
{{installedSurface.skillsLine}}
{{installedSurface.hooksLine}}
{{installedSurface.toolingLine}}
{{installedSurface.skillRoutingLine}}

{{managedBlock.rulesPriorityLine}}
