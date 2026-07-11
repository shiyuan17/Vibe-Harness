# Coding Rules

Coding rules emphasize small, clear, reviewable, and verifiable changes. Reuse repository patterns and add abstractions only when they remove real complexity or match an established boundary.

## Rules

- 优先复用本仓库既有模式，避免为一次性需求引入抽象。
- 共享逻辑变更必须配套聚焦测试，并说明影响范围。
- 交付时写清影响范围、验证命令和未覆盖风险。

## Checklist

- 范围：只改当前任务需要的文件，不夹带无关重构。
- 模式：优先复用已有工具、目录结构、命名和错误处理方式。
- 抽象：只有在减少真实重复或匹配既有边界时新增抽象。
- 依赖：新增依赖前确认现有栈不能解决、维护状态、体积、许可证和漏洞。
- 测试：共享逻辑、bugfix 和行为变化必须有聚焦测试或明确人工核对。

## 验证证据

- lint、typecheck、聚焦测试和必要的全量测试命令。
- 影响范围和未覆盖路径。
- 新依赖的理由；没有新增依赖时写明复用方式。

## 停止条件

需求、边界、依赖许可或验证方式不清时停止；不得用“先实现再说”替代计划。
