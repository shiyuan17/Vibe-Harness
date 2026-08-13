# 架构决策记录（ADR）

本目录是长期架构决策的唯一事实来源。每个决策使用一个独立的 Markdown 文件，文件名遵循 ADR-0000-short-title.md，并基于 ADR 模板创建。

## 何时需要 ADR

以下变化必须创建 ADR：项目或系统结构、公共契约、安全或可靠性要求、关键依赖、迁移或回滚策略，以及跨模块边界。小型 Bug 修复、局部重命名和短期实验不要求创建 ADR。

## 生命周期

状态使用 proposed、accepted、rejected、deprecated 或 superseded。已接受和已拒绝的记录属于历史决策，不得改写其核心内容。决策发生变化时必须创建新 ADR，并通过旧记录的 superseded-by 指向替代记录。

每条记录必须注明责任人、决策者、被咨询者和被告知者，并包含决策驱动因素、备选方案、决策结果、后果、确认方式以及非空的复核触发条件。日期统一使用 YYYY-MM-DD。

机器可读索引为 catalog.json。治理记忆文件 ../memory/DECISIONS.md 只保存摘要索引。运行态恢复记忆 ../../memory/decisions.md 不属于正式 ADR 来源。
