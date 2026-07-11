---
name: security-and-hardening
description: Use when changes handle untrusted input, authentication, authorization, sensitive data, storage, or external integrations.
---

# 安全加固

## 前置

识别资产、信任边界、攻击者能力和失败影响；认证、权限、密钥、生产配置等红区先获得确认。

## 执行

1. 在输入边界做结构和语义校验，输出按上下文编码。
2. 服务端强制认证与授权，不信任客户端声明。
3. 使用参数化查询、最小权限、受限文件路径和安全默认值。
4. secret 不进入代码、日志、错误响应或测试快照。
5. 为拒绝路径、越权、注入和敏感信息泄漏增加测试。

## 输出

列出威胁、控制措施、验证证据、残余风险和人工确认状态。缺少契约或安全边界时停止并请求证据，不自行放宽控制。
