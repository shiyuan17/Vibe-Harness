# 工作流 Packet 示例

填写规则：标记“必填”的字段不得留空；禁止空泛词（待定、视情况、合适测试、后续补充）。会话结束输出优先满足 `session-protocol`，Workflow Packet 是其中的工作流证据部分。Workflow Tier 表示单次任务风险档位；Install Profile 表示安装资产集合，二者不得混用。

## 概念区分

- Workflow Tier（必填）：Fast Path / Lightweight / Full。
- Install Profile：minimal / core / full / codex-internal / codex-minimal / docs-only。
- 选择更高风险档位优先；不确定时按更高档位处理。

## Fast Path

- 摘要（必填）：
- 主工作流：不适用（文档 / 只读 / 测试-only）
- Fast Path 适用原因（必填）：
- 验证（必填）：
- 未验证项与风险：

## Lightweight

- 主工作流（必填）：
- 触发信号（必填）：
- 必要修饰器：
- 动态测试 / 验证（必填）：
- Write Scope：
- 未验证事项与风险（必填）：

## Full

- 主工作流（必填）：
- 触发信号（必填）：
- 必要修饰器：
- 专家 Agent：
- 动态测试（按触发器必填）：
- 动态模拟（按触发器必填）：
- 动态安全（按触发器必填；安全、auth、权限、敏感数据或审计触发）：
- 动态数据库（按触发器必填；DB、migration、seed 或数据修复触发）：
- Red Team（按触发器必填；红区、安全、DB、生产、发布、高风险或跨层触发）：
- 跨仓 / 外部契约证据（按触发器必填；外部契约或跨仓触发）：
- Review 证据（必填）：
- 回滚方案（必填）：
- 未验证事项与风险（必填）：
