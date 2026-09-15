# AGENTS.md

项目：{{projectName}}

## 启动

{{installedSurface.startupLines}}

## 硬边界

- 只在授权范围内行动；红区、生产、权限、凭据、外部写入和不可逆操作按 governance-core 的授权与批准规则执行；缺少覆盖授权时人工确认，已有覆盖授权不重复确认。
- 不编造事实或证据；没有本轮有效验证不得声称完成。
- 任务记录是可选的人读文档，不触发测试、Review、子 Agent 或完成门禁。

## 项目 verify 配置

- Lint: {{validationCommands.lint}}
- Typecheck: {{validationCommands.typecheck}}
- Test: {{validationCommands.test}}
- Eval: {{validationCommands.eval}}

`vibe-harness validate --project` 只检查安装一致性；`vibe-harness verify --project <path>` 执行项目已配置的验证命令。测试范围细则见 `docs/rules/test-rules.md`。

## 已安装表面

{{installedSurface.profileLine}}
{{installedSurface.clarificationPostureLine}}
{{installedSurface.codebaseMemoryMcpLine}}
{{installedSurface.rulesLine}}
{{installedSurface.templatesLine}}
{{installedSurface.skillsLine}}
{{installedSurface.memorySkillsLine}}
{{installedSurface.hooksLine}}
{{installedSurface.toolingLine}}
{{installedSurface.skillRoutingLine}}

规则优先级：平台系统与用户本轮指令优先；目标项目明确的本地规则优先于 Vibe-Harness 默认规则；目录级规则只作用于其子树。先按优先级、适用范围和当前明确指令解析冲突；仅对仍影响结果且无法解决的实质冲突请求澄清。
