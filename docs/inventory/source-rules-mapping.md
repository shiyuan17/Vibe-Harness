# Source Rules Mapping

本文件记录从源治理体系到 Vibe-Harness 通用资产的抽取方式。源项目只作为只读参考；Vibe-Harness core 不保存业务状态、具体任务号、端口、仓库名或领域契约。

| 源规则 | Vibe-Harness 目标 | 处理方式 |
| --- | --- | --- |
| `AGENTS.md` | `adapters/codex/AGENTS.template.md`、`rules/ai-collab-rules.md` | summarize |
| `QUICKSTART.md` | `rules/governance-core.md` | consolidate |
| `WORKFLOW.md` | `rules/governance-core.md` | consolidate |
| `DYNAMIC_WORKFLOW_RULES.md` | `rules/governance-core.md` | consolidate |
| `TASK_RULES.md` | `templates/task.md` | optional template |
| `TASK_LIFECYCLE_RULES.md` | `rules/governance-core.md` | consolidate |
| `TASK_MANAGEMENT_RULES.md` | historical reference only | archive |
| `TASK_INTAKE.md` | `templates/task.md` | consolidate |
| `GIT_RULES.md` | `rules/git-rules.md` | copy-generalize |
| `CODING_RULES.md` | `rules/coding-rules.md` | copy-generalize |
| `FRONTEND_RULES.md` | `rules/frontend-rules.md` | copy-generalize |
| generic application logging guidance | `rules/log-management.md` | new-general |
| `API_RULES.md` | `rules/api-rules.md` | copy-generalize |
| `DB_RULES.md` | `rules/db-rules.md` | copy-generalize |
| `AI_COLLAB_RULES.md` | `rules/ai-collab-rules.md` | copy-generalize |
| `RELEASE.md` | `rules/release-rules.md` | copy-generalize |
| `REVIEW_RULES.md` | `rules/governance-core.md`、完整任务 Runtime | consolidate + validator |
| `LOOP_ENGINEERING_RULES.md` | `rules/governance-core.md` | consolidate |
| `AGENT_SKILL_ROUTING.md` | `rules/agent-skill-routing.md`、Skill descriptions | copy-generalize + native routing |
| `TROUBLESHOOTING.md` | `rules/troubleshooting.md` | copy-generalize |
| project memory/current tasks/contracts | examples or target project only | exclude-business |
| durable memory categories | `templates/memory/*` | template |
| governance / PR packet validation | historical reference only | archive |

处理方式说明：

- `copy-generalize`：保留行为规则、字段模型、门禁和验证要求，删除项目绑定值。
- `new-general`：新增通用治理规则，不从源项目复制业务日志样例。
- `summarize`：保留入口结构和红线，不复制目标项目本地状态。
- `exclude-business`：不进入 Vibe-Harness core，只能留在目标项目或脱敏示例。
- `example-only`：仅用于说明迁移方式，不作为可安装治理规则。
