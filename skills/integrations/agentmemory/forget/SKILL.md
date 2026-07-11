---
name: forget
description: Use when the user explicitly requests deletion of specific agentmemory observations or session memories for privacy or correction.
---

# Agentmemory 遗忘

这是破坏性操作。先用 `memory_smart_search`（query 为用户描述，limit 20）列出候选 memory/session IDs、标题和范围；获得针对明确候选的再次确认后，调用 `memory_governance_delete`，传入 `memoryIds` 和简短 `reason`。整 session 删除也必须展开为 memory IDs。报告实际删除数。

不得用裸 sessionId、不得删除仓库文件、不得在确认前执行。MCP 不可用时停止；HTTP 或本地回退只有在具备等价预览、精确 ID 和显式确认语义时才允许，否则报告阻塞。
