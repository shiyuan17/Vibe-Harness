---
name: stale-cleanup
description: Use when cleaning dead code, stale references, outdated docs, orphan resources, stale memory, or stale indexes; producing evidence-based removal lists; or executing explicitly confirmed deletions.
---

# 过期资产清理

清理死代码、过期引用、过期文档、过期资源、过期记忆和过期索引。默认只读：先产出证据化清单，只有用户显式要求清理且逐项确认后才删除。判定细则与命令映射见 [references/asset-classes.md](references/asset-classes.md)。

## 执行

1. 先运行确定性扫描：`vibe-harness audit --project <path> --kind cleanup`。报告区分已确认项与候选线索，`details.cleanup.inventory` 记录扫描面，`details.cleanup.skipped` 记录本次未覆盖的判定。
2. 按六类资产补齐扫描器覆盖不到的证据：符号级死代码核实调用方与外部消费者，过期资源核实引用与目录约定，过期记忆按本地记忆的陈旧、重复与矛盾口径复核，索引结合 `CLEANUP_INDEX_*` 证据并在工具可用时用 `list_projects`、`index_status` 确认项目归属与新鲜度。`CLEANUP_INDEX_UNAVAILABLE` 表示本次未覆盖，不是索引过期。
3. 每条结论都带上来源、命中方式、影响范围和删除后果；确定性与候选分开陈述，不用扫描结果替代人工判断，不把候选线索写成缺陷。

## 边界

- 默认不删除、不移动、不改写任何文件；扫描是只读的，`audit --kind cleanup` 拒绝 `--write`。
- 清理必须在用户显式要求后逐项确认；每次删除前说明目标、依据、影响和恢复方式，优先使用可恢复方式（Git 可恢复状态或 `.vibe-harness/backups/`）。
- 不动红区文件、凭据、外部系统和其他 owner 的文件；不确定归属时只报告并请求确认。
- 工具不可用时报告缺哪项能力并回退到仓库搜索；不得据此推断资产已过期。
- 过期记忆的删除走显式确认的遗忘流程，本 Skill 只负责判定与报告。

## 报告

按资产类别列出：路径或符号、证据、严重度（已确认 / 候选）、影响范围、建议动作、删除风险与恢复方式。结尾列出未覆盖范围和下次复核触发条件。
