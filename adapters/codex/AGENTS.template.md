# AGENTS.md - 由 LoopEngine 安装

本项目使用 LoopEngine 的 Codex 优先协作规则。

## 最小启动步骤

1. 阅读 `docs/rules/quickstart.md` 和 `docs/rules/agent-collaboration.md`。
2. 编辑前运行 `git status --short`。
3. 将任务归类为 Fast Path、Lightweight 或 Full。
4. 红区改动前先获得人工确认。
5. 声称完成前必须用最新验证证据证明。

## 核心位置

- 规则位于 `docs/rules/`。
- 模板位于 `docs/templates/`。
- Skills 位于 `.agents/skills/`。
- Codex hook 配置位于 `.codex/hooks.json`。

LoopEngine 不覆盖本项目本地规则；如果本地规则更严格，遵循更严格的规则。
