---
name: api-contract-check
description: 检查 API、DTO、mapper、mock 与跨仓契约变更。用于实现或审查前确认 endpoint 字段、权限码、响应结构、mock 或联调证据。
---

# API 契约检查

在编辑代码前完成这五步：

1. 找到契约来源：后端代码、OpenAPI、已确认 mock 或文档化接口。
2. 列出字段、方法、权限、错误、分页和可空性。
3. 检查 DTO 与 UI model 之间的 mapper 边界。
4. 把缺失或含糊字段记录为阻塞项。
5. 定义验证方式：mapper 测试、service 测试、请求证据或人工契约核对。

不要臆造字段或权限码。契约不可用时，暂停并向用户索取来源证据。
