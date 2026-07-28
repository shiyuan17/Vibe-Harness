---
name: security-and-hardening
description: Use for trust boundaries, untrusted input, auth, secrets, sensitive data, or external writes.
---

# 加固安全边界

## 执行

1. 识别资产、信任边界、攻击者能力和失败影响。
2. 在入口执行结构与语义校验，在服务端强制认证和授权。
3. 使用参数化查询、最小权限、受限路径和安全默认值。
4. 禁止 secret 进入代码、日志、错误响应、测试快照或持久化上下文。
5. 为拒绝路径、越权、注入、路径逃逸和敏感信息泄漏增加测试。
6. 对生产、凭据、外部写入或不可逆动作要求人工确认，不自行放宽控制。

## 交付

报告威胁、控制措施、验证证据、审批状态和残余风险。
