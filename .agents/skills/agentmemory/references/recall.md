# Agentmemory 检索

调用 `memory_smart_search`，参数为用户查询和 `limit: 10`。按 session 分组展示 observation 的 type、title、narrative 和来源，突出 importance >= 7；无结果时建议更具体的替代查询词。

MCP 不可用时回退到授权的 agentmemory HTTP 搜索；服务仍不可用时搜索 `.agents/memory/` 并说明范围。只呈现实际返回内容，历史结论必须用当前仓库复核。
