# AGENTS.md - 由 LoopEngine 安装

项目：{{projectName}}

本项目使用 LoopEngine 的 Codex 优先协作规则。默认包管理器为 `{{packageManager}}`。

## 最小启动步骤

1. 阅读 `docs/rules/quickstart.md` 和 `docs/rules/agent-collaboration.md`。
2. 编辑前运行 `git status --short`。
3. 将任务归类为 Fast Path、Lightweight 或 Full。
4. 红区改动前先获得人工确认。
5. 声称完成前必须用最新验证证据证明。

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

## 核心位置

- 规则位于 `docs/rules/`。
- 模板位于 `docs/templates/`。
- Skills 位于 `.agents/skills/`。
- Codex hook 配置位于 `.codex/hooks.json`。

LoopEngine 不覆盖本项目本地规则；如果本地规则更严格，遵循更严格的规则。
