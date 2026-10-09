# CLAUDE.md

项目：{{projectName}}

## 启动

{{installedSurface.startupLines}}

## 硬边界

{{managedBlock.hardBoundsLines}}
- 当前宿主提供稳定的 PreToolUse 与 PermissionRequest 安全 Hook；配置文件存在只证明 configured-unverified，需在 Claude Code 中复核实际激活状态。

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
