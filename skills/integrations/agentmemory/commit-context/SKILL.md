---
name: commit-context
description: 将文件、符号或行追溯到产生它的 commit 和 agent session。用于用户询问代码为何改变、谁或什么产生了某次提交，或想了解特定 diff 的上下文。
---

# 提交上下文

把当前代码或 diff 追溯到历史决策。

## 流程

1. 确认目标：文件、符号、行号、commit 或 diff。
2. 用 git 历史找到相关 commit。
3. 搜索 agentmemory 中与 commit、分支、文件或主题相关的 session。
4. 汇报：变更原因、当时目标、验证证据和可能的后续风险。
5. 无法建立可靠关联时明确说明，不要编造来源。

当前文件内容始终以工作区为准；历史只提供解释。
