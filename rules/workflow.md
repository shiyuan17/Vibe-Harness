# 工作流

工作流用来组织工作，但不替代工程判断。

## 阶段

1. Intake：确认来源、目标、验收标准、非目标、范围、风险和验证方式。
2. Clarify：解决会改变行为的歧义；无法澄清时不得执行。
3. Spec：定义用户行为、契约、边界和验收测试。
4. Plan：确定实现顺序、风险、依赖、验证和回滚。
5. Task：拆成 parent / child，写清 Write Scope、Forbidden Actions 和停止条件。
6. Execute：在明确范围内修改，并保护无关改动。
7. Verify：运行最新验证命令并阅读输出。
8. Review：中高风险任务使用独立审查。
9. Handoff：总结状态、证据、风险和下一步。
10. Retrospective：当出现返工、事故、重复失败或规则缺口时，沉淀规则或自动化改进。

## Failure Packet

验证失败、构建失败、冲突合并、契约不一致或恢复中断时，必须记录：

- Failure type：
- Last known good state：
- Failed command and exit code：
- Key output：
- Suspected cause：
- Next safe action：
- Requires human decision：

## 停止条件

当验收标准不清、需要红区操作、验证反复失败、范围扩大，或请求与现有规则冲突时，停止并澄清。
