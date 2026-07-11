# AGENTS.md - 由 LoopEngine 安装

项目：{{projectName}}

本项目使用 LoopEngine 的 Codex 优先协作规则。默认包管理器为 `{{packageManager}}`。

## 最小启动步骤

1. 阅读 `docs/rules/quickstart.md`、`docs/rules/agent-collaboration.md` 和 `docs/rules/session-protocol.md`。
2. 编辑前运行 `git status --short`。
3. 若仓库存在 `.codegraph/`，理解或定位代码前先用 CodeGraph 获取上下文。
4. 将任务归类为 Fast Path、Lightweight 或 Full。
5. 红区改动前先获得人工确认。
6. 目标、范围和验证方式明确后默认继续完成任务，只有不可逆操作、范围变化、红区确认、规则冲突或缺少用户信息时暂停。
7. 声称完成前必须用最新验证证据证明。

## 会话开始

每次会话按 `docs/rules/session-protocol.md` 执行 Session Start Protocol：确认任务目标、验收标准、非目标、工作区事实、CodeGraph 使用条件、风险档位、红区确认状态和验证计划。

## 会话结束

每次会话结束按 `docs/rules/session-protocol.md` 输出 Session End Protocol：摘要、影响范围、验证证据、未验证项、风险、Git 状态、worktree / 分支 / merge-back 状态和后续动作。暂停、转交、未完成、阻塞或需要恢复时，额外使用 handoff 规则和模板。

## 五条红线

1. 编辑前必须先运行 `git status --short`，不得覆盖用户未归属改动。
2. 红区改动必须先说明范围、原因、验证方式和回滚方式，并获得人工确认。
3. 不编造 API、字段、权限、数据库结构、测试结果或发布结果。
4. 实现者不能自证最终通过；高风险变更必须进入独立 Review。
5. 交付必须包含变更摘要、影响范围、验证证据、未验证项和工作流交付包。

## 默认验证命令

- Lint: `{{validationCommands.lint}}`
- Typecheck: `{{validationCommands.typecheck}}`
- Governance: `{{validationCommands.governance}}`

`loopengine validate --project` 只静态报告这些命令为 available、missing、manual 或 not_configured，不执行目标项目命令。Governance 命令在 basic/full 模式由 LoopEngine 安装；lint/typecheck 未检测到时必须补充人工证据或显式配置，不能假定 pnpm scripts 存在。

## 核心位置

{{installedSurface.profileLine}}
{{installedSurface.codegraphLine}}
{{installedSurface.rulesLine}}
{{installedSurface.engineeringRulesLine}}
{{installedSurface.operationalRulesLine}}
{{installedSurface.templatesLine}}
{{installedSurface.skillsLine}}
{{installedSurface.memorySkillsLine}}
{{installedSurface.workflowsLine}}
{{installedSurface.reviewLoopLine}}
{{installedSurface.hooksLine}}

## 专项规则索引

- 工程实现、任务治理、审查、loop、发布、设计和排障均以当前 profile 已安装的 `docs/rules/` 文件为准。
- 若已安装 `docs/rules/project-specific-rules.md`，编码规范、验证命令、VCS 状态和 review 证据优先读取该项目画像规则。
- 若任务命中未安装的专项规则面，先说明缺口，再回退到本地规则、人工确认或目标项目自有规范。

## Skills 路由

{{installedSurface.skillRoutingLine}}

LoopEngine 不覆盖本项目本地规则；如果本地规则更严格，遵循更严格的规则。
