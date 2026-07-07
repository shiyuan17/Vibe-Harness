---
name: forget
description: 当用户明确要求删除保存的 memory、删除 observation/session 或忘记先前上下文时，删除或遗忘指定 agentmemory 内容。
---

# Agentmemory 遗忘

遗忘是破坏性操作，只在用户明确要求时执行。

## 流程

1. 确认要删除的具体 memory、observation 或 session。
2. 如果描述含糊，先列出候选并让用户确认。
3. 删除后汇报删除对象和范围。
4. 不删除当前仓库文件；此 skill 只处理 agentmemory 数据。

不要基于推测删除记忆。不要把“不要使用这段上下文”理解为永久删除，除非用户明确要求 forget/delete。
