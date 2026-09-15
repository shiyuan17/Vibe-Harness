# 架构决策记录（ADR）

本目录是长期架构决策的唯一事实来源。每个决策使用一个独立的 Markdown 文件，文件名遵循 ADR-0000-short-title.md，并基于 ADR 模板创建。

## 何时需要 ADR

判据是影响持续时间、消费方范围、迁移成本和回滚难度：只有长期有效、高影响且难以逆转的决策才建 ADR，覆盖项目或系统结构、公共契约、安全或可靠性要求、关键依赖、迁移或回滚策略。小型 Bug 修复、局部重命名、可逆实现选择和短期实验不要求创建 ADR，跨模块边界本身也不构成触发条件；跨边界变更的 owner、接口与回滚要求见 docs/rules/project-directory.md。触发清单以本节为唯一来源，规则文件不重复维护阈值。

## 生命周期

状态使用 proposed、accepted、rejected、deprecated 或 superseded。已接受和已拒绝的记录属于历史决策，不得改写其核心内容。决策发生变化时必须创建新 ADR，并通过旧记录的 superseded-by 指向替代记录。

每条记录必须注明责任人、决策者、被咨询者和被告知者，并包含决策驱动因素、备选方案、决策结果、后果、确认方式以及非空的复核触发条件。日期统一使用 YYYY-MM-DD。

机器可读索引为 catalog.json。治理记忆文件 ../memory/DECISIONS.md 只保存摘要索引。本地恢复记忆 decisions.md（默认 .agents/memory/decisions.md，路径由 vibe-harness.config.json 的 memory.path 配置）不属于正式 ADR 来源。
