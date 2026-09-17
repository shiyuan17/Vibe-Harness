# CLAUDE.md

项目：{{projectName}}

## 启动

{{installedSurface.startupLines}}

## 硬边界

- 只在授权范围内行动；红区、生产、权限、凭据、外部写入和不可逆操作按 governance-core 的授权与批准规则执行；缺少覆盖授权时人工确认，已有覆盖授权不重复确认。
- 不编造事实或证据；没有本轮有效验证不得声称完成。
- 任务记录是可选的人读文档，不触发测试、Review、子 Agent 或完成门禁。
- 当前宿主提供稳定的 PreToolUse 与 PermissionRequest 安全 Hook；配置文件存在只证明 configured-unverified，需在 Claude Code 中复核实际激活状态。

## 默认验证命令

- Lint: {{validationCommands.lint}}
- Typecheck: {{validationCommands.typecheck}}
- Test: {{validationCommands.test}}
- Eval: {{validationCommands.eval}}

`vibe-harness validate --project` 只检查安装一致性；`vibe-harness verify --project <path>` 默认只执行快速层（开发中同步，失败阻塞当前实施单元）{{validationCommands.tiers.quick}}；中等层（阶段或合并前，{{validationCommands.tiers.standard}}）与深度层（异步或发布边界，{{validationCommands.tiers.deep}}）必须显式升级 `--tier standard|deep|all`，`--full` 运行完整矩阵。快速层通过时收据标注部分范围并给出下一层入口，未取得被延迟层的证据前不得宣称集成、发布或整体完成；深度层可由项目 CI 或独立 worktree 异步完成。测试范围细则见 `docs/rules/test-rules.md`。

## 已安装表面

{{installedSurface.profileLine}}
{{installedSurface.codebaseMemoryMcpLine}}
{{installedSurface.rulesLine}}
{{installedSurface.templatesLine}}
{{installedSurface.skillsLine}}
{{installedSurface.memorySkillsLine}}
{{installedSurface.hooksLine}}
{{installedSurface.toolingLine}}
{{installedSurface.skillRoutingLine}}

规则优先级：平台系统与用户本轮指令优先；目标项目明确的本地规则优先于 Vibe-Harness 默认规则；目录级规则只作用于其子树。先按优先级、适用范围和当前明确指令解析冲突；仅对仍影响结果且无法解决的实质冲突请求澄清。
