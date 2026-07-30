# Agentmemory 审计

审计本地记忆库（默认 `.agents/memory/`，若安装了 `docs/memory/` 也一并扫描）的陈旧、重复和矛盾条目，输出为审计清单。审计只标记和建议，不自动删除；删除走 [forget.md](forget.md) 的显式确认流程。

## 扫描范围

- 运行态记忆：`.agents/memory/` 下的 `CURRENT.md`、`observations.md`、`decisions.md`、`sessions/`。
- 治理真相（若 full profile 安装）：`docs/memory/` 下的 `PROJECT_STATE.md`、`ARCHITECTURE.md`、`DECISIONS.md`、`KNOWN_BUGS.md`、`TECH_DEBT.md`、`FAILURE_LEARNINGS.md`。

## 标记规则

1. **关联文件变更**：若 `codebase-memory-mcp` 可用，用 `detect_changes` 取近期变更路径；若变更路径落在某记忆条目的关联文件/适用范围/影响范围字段（glob 或路径列表），标记该条目为"待复核"。
2. **陈旧**：条目的"最后验证"日期超过 30 天，或 `CURRENT.md` 的"最后更新"早于最近一次 Git 提交日期，标记为"可能陈旧"。
3. **重复**：多条 observation 或 decision 主题相近、结论一致，标记为"可合并"。
4. **矛盾**：同一主题存在结论冲突的条目，标记为"冲突"，并列出冲突双方供人工裁决。

## 输出

按文件分组列出标记条目，每条给出：位置、标记类型、依据（变更路径/日期/重复源）、建议动作（复核、更新、合并或删除）。审计完成后由用户决定后续操作，不自动执行写入或删除。
