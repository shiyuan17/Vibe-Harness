# 日志管理规则

日志管理规则让应用运行日志可被快速检索、关联和用于排障。新增或调整日志时优先使用结构化日志，推荐 JSON Lines；已有 logger 可以映射等价字段。日志证据必须能支持或推翻排障假设，不能泄露 secret、token、凭据或原始敏感数据。

## 规则

- 新增应用日志优先结构化，推荐 JSON Lines；已有日志格式必须明确字段映射。
- 每条关键日志应包含时间、级别、服务或组件、操作或事件、关联 ID、环境或版本、错误信息、耗时和安全上下文。
- 本地开发、调试和临时运行日志写入 `.cognis/log/`，例如 `vite-dev.out/err`；`.cognis/artifacts/` 只用于截图、trace、导出文件等交付证据产物。
- 排障前先定位日志来源和检索方式，再按时间范围、级别、组件、关联 ID 或错误码收敛。
- 日志只保留定位问题所需上下文，不输出 secret、凭据、token、原始 PII 或业务专有标识。
- 修复交付必须说明使用了哪些日志证据、如何检索、支持了哪个假设，以及修复后的验证证据。

## 检查清单

- 位置：记录应用日志所在文件、容器、平台、dashboard 或命令入口。
- 字段：确认 timestamp、level、service/component、operation/event、correlationId/requestId/traceId、environment/version、error.code、error.message、durationMs 和 safe context。
- 关联 ID：请求入口、后台任务、外部调用和异步队列要能透传同一个关联 ID 或说明断点。
- 检索：提供按时间范围、level、component、关联 ID、error code 和关键事件过滤的命令或查询。
- 分级：debug、info、warn、error 含义一致；error 记录可定位原因的错误码和安全消息。
- 脱敏：日志输出前过滤 secret、token、cookie、authorization header、凭据、原始 PII 和不必要业务数据。
- 留存：说明本地、测试、CI 和生产环境的日志保留范围，以及权限不足时的升级路径。

## 推荐结构

```json
{"timestamp":"2026-01-02T03:04:05.678Z","level":"error","service":"api","component":"orders","operation":"create","correlationId":"req-123","environment":"staging","version":"1.2.3","error":{"code":"ORDER_CREATE_FAILED","message":"Create operation failed"},"durationMs":842,"context":{"retryable":false}}
```

字段名可以按目标项目 logger 约定调整，但语义必须能映射到 Checklist 中的核心字段。

## AI 排障流程

1. 记录症状、时间窗口、环境、用户可见错误、最近变更和复现步骤。
2. 查找日志入口：README、运行脚本、部署平台、容器、CI artifact、observability dashboard 或目标项目规则。
3. 先用时间窗口和环境缩小范围，再用 component、operation、关联 ID、error code 或关键事件继续过滤。
4. 摘要只引用相关日志：时间、级别、组件、关联 ID、错误码、关键上下文和相邻事件，不粘贴大段无关输出。
5. 将日志证据连接到一个可验证假设；如果日志证据推翻假设，更新假设而不是强行修复。
6. 修复后运行对应验证，并记录新的日志、测试或人工核对作为验证证据。

## 检索示例

```bash
rg '"correlationId":"req-123"' .cognis/log/
rg '"level":"error"' .cognis/log/ | rg '"component":"orders"'
rg 'ORDER_CREATE_FAILED|req-123' .cognis/log/
```

不同日志平台可以使用等价查询；交付时写清实际命令、查询条件、时间窗口和关键输出。

## 验证证据

- 排障使用的日志位置、查询命令或 dashboard 条件。
- 关键日志的时间、级别、组件、关联 ID、错误码和摘要。
- 修复后验证命令、退出码、关键输出，以及相关日志是否消失、降级或变为预期状态。

## 停止条件

缺少关键日志、没有检索权限、需要生产权限、日志包含敏感数据不能安全分享、日志证据与当前假设冲突或修复会扩大范围时停止并升级。
