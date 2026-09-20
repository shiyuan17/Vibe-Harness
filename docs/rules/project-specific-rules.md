# 项目专属规则

本文件由 Vibe-Harness 根据目标项目文件和 `vibe-harness.config.json` 渲染。当前事实优先于历史记忆；目标项目明确的本地规则优先于 Vibe-Harness 默认规则，但不得让渡 `governance-core.md` 硬边界中的授权规则、红区与证据标准（本地规则只能收紧，不能放宽或取代）；目录级规则只作用于其子树，先按优先级、适用范围和当前明确指令解析冲突；仅对仍影响结果且无法解决的实质冲突请求澄清。

## 项目画像

- 技术栈：{{projectProfile.stackSummary}}
- 包管理器：`{{projectProfile.packageManager}}`
- 版本控制：Git
- 状态命令：`git status --short`
- 关键目录 / 模块：未发现显式模块清单；按现有目录职责就近修改。

## 编码规范

- {{projectProfile.codingStandards}}
- TypeScript 改动必须通过项目 typecheck。
- 遵循 .editorconfig 中的缩进、换行和字符集约定。
- 优先沿用目标项目已有分层、命名、错误处理和测试写法。
- 新增依赖前先确认现有栈不能满足，并说明维护状态、许可证、体积和安全风险。
- 不手改构建产物、依赖缓存、生成目录或 VCS 元数据。

## 日志与可观测性

- 画像完整度：{{projectProfile.logging.status}}。
- 候选证据（仅表示仓库中实际发现，不能直接当作运行事实）：{{projectProfile.logging.evidenceSummary}}。
- 项目契约（来自 projectRules.overrides.logging）：{{projectProfile.logging.contractSummary}}。
- 使用顺序：先读项目契约，再核对候选证据并定位实际 logger、输出与查询入口；未确认项保持未知，不生成平台或文件查询命令。
- 配置中的查询和验证只用于指导与基线，不自动执行；没有明确需求时不引入新 logger、追踪系统或存储后端。

## 验证规范

- 默认验证：{{projectProfile.verificationSummary}}
- 快速层（开发中同步，失败阻塞当前实施单元）：{{validationCommands.tiers.quick}}
- 中等层（实施单元边界、提交前或合并前，失败阻塞合并或完成声明）：{{validationCommands.tiers.standard}}
- 深度层（异步、夜间、关键 PR 或发布边界，失败阻塞集成与发布）：{{validationCommands.tiers.deep}}
- `vibe-harness verify` 默认只执行快速层；中等层与深度层显式传 `--tier standard|deep` 升级，`--full` 运行完整矩阵。快速层通过时收据标注部分范围并列出被延迟的检查。
- 项目配置的四项命令（完整范围，含深度层）：Lint {{validationCommands.lint}}；Typecheck {{validationCommands.typecheck}}；Test {{validationCommands.test}}；Eval {{validationCommands.eval}}
- 深度层的调度状态（queued/running/passed/failed/blocked/stale）只表示排期进度；最终验收仍按 passed/failed/blocked/unverified，实质写入后旧深度收据作废需重跑。
- E2E 只保留真实入口完整旅程，参数校验、配置解析、提示文案和可注入组件行为下沉到单元、组件或集成层。
- 无法运行某项验证时，交付必须说明原因、替代证据和剩余风险。

## Git / VCS 规范

- 编辑前运行 `git status --short`，识别用户未归属改动。
- Git 项目按 `docs/rules/git-rules.md` 管理分支、提交、worktree 和 merge-back。
- SVN 项目不得套用 Git commit / branch 假设；交付时报告 `svn status` 结果和本地修改范围。
- 混合 Git/SVN 痕迹时，以当前任务实际改动所在工作副本为准，并在交付中说明判断依据。

## 显式 Review

- 按 package.json scripts、pom.xml 或 solution 配置选择与改动匹配的验证。
- 仅在用户明确要求 Review 或显式调用 Review 工具时执行；Vibe-Harness 不自动创建审查角色或完成门禁。
