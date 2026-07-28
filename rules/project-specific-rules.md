# 项目专属规则

本文件由 Cognis 根据目标项目文件和 `cognis.config.json` 渲染。当前事实优先于历史记忆；目标项目明确的本地规则优先于 Cognis 默认规则，目录级规则只作用于其子树，同一层级冲突时停止并请求确认。

## 项目画像

- 技术栈：{{projectProfile.stackSummary}}
- 包管理器：`{{projectProfile.packageManager}}`
- 版本控制：{{projectProfile.vcsSummary}}
- 状态命令：`{{projectProfile.vcsStatusCommand}}`
- 关键目录 / 模块：{{projectProfile.directoryGuidance}}

## 编码规范

- {{projectProfile.codingStandards}}
- 优先沿用目标项目已有分层、命名、错误处理和测试写法。
- 新增依赖前先确认现有栈不能满足，并说明维护状态、许可证、体积和安全风险。
- 不手改构建产物、依赖缓存、生成目录或 VCS 元数据。

## 验证规范

- 默认验证：{{projectProfile.verificationSummary}}
- Lint：`{{validationCommands.lint}}`
- Typecheck：`{{validationCommands.typecheck}}`
- Test：`{{validationCommands.test}}`
- Eval：`{{validationCommands.eval}}`
- 无法运行某项验证时，交付必须说明原因、替代证据和剩余风险。

## Git / VCS 规范

- 编辑前运行 `{{projectProfile.vcsStatusCommand}}`，识别用户未归属改动。
- Git 项目按 `docs/rules/git-rules.md` 管理分支、提交、worktree 和 merge-back。
- SVN 项目不得套用 Git commit / branch 假设；交付时报告 `svn status` 结果和本地修改范围。
- 混合 Git/SVN 痕迹时，以当前任务实际改动所在工作副本为准，并在交付中说明判断依据。

## 显式 Review

- {{projectProfile.reviewGuidance}}
- 仅在用户明确要求 Review 或显式调用 Review 工具时执行；Cognis 不自动创建审查角色或完成门禁。
