# 动态工作流

先选择一个主 workflow，再叠加必要修饰器。

## 概念边界

- Workflow Tier：单次任务的风险档位，取值为 Fast Path、Lightweight、Full。
- Install Profile：安装资产集合，取值为 minimal、core、full、codex-internal、codex-minimal、docs-only。
- `Full 工作流` 不等于 `full` Install Profile；不要用安装 profile 替代任务风险判断。

| 信号 | 主工作流 | 必要修饰器 |
| --- | --- | --- |
| UI、布局、组件、浏览器行为 | UI | 浏览器验证，纯文案例外 |
| API client、mapper、mock、集成 | API | 外部契约存在时 Backend Cross-check |
| 数据库、migration、seed、数据修复 | DB | DB、Backend Cross-check、Red Team |
| auth、权限、敏感数据、审计 | Security | Security、Red Team |
| 重构、共享包、构建工具 | Architecture | 跨层时 Red Team |
| 生产 bug、性能回退、日志问题 | Production Debug | Red Team；外部契约存在时 Backend Cross-check |
| hooks、CI、发布、治理脚本 | 工作流基础设施 | 红区时 Red Team |
| 纯文档 | Not applicable | 无 |

## 档位

- Fast Path：纯文档、只读分析、测试-only、低风险文案。
- Lightweight：低风险实现，且不触发安全、数据库、发布、生产、红区、跨层或外部契约。
- Full 工作流：任何红区、安全、DB、生产、发布、高风险、跨层或外部契约工作。

升级优先：如果同一任务同时满足多个档位，选择更高档位；不确定时先按更高档位处理。档位描述中的 Full 工作流指任务交付流程，不等同于 `full` profile。

## Packet 字段

Fast Path：摘要、工作流不适用原因、验证。

Lightweight：主工作流、触发信号、必要修饰器、验证、剩余风险。

Full 工作流：完整工作流 Packet、动态测试、模拟、安全、数据库、Red Team、跨仓/外部契约证据、剩余风险。
