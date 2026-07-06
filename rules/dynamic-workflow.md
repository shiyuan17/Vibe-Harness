# 动态工作流

先选择一个主 workflow，再叠加必要修饰器。

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

- Fast Path：文档、只读、测试-only 或低风险文案。
- Lightweight：不触发 security、DB、Red Team 或外部契约的低风险实现。
- Full：红区、跨层、安全、DB、生产、发布或高风险改动。

## Packet 字段

Fast Path：摘要、工作流不适用原因、验证。

Lightweight：主工作流、触发信号、必要修饰器、验证、剩余风险。

Full：完整工作流 Packet、动态测试、模拟、安全、数据库、Red Team、跨仓/外部契约证据、剩余风险。
