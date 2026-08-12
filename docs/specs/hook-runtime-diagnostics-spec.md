# Hook 运行时诊断规格

状态：Implemented

## 目标

在不放宽 fail-closed 策略、不记录原始 Hook 输入且不引入新日志框架的前提下，让 Agent 能区分 Hook CLI 的输入解析、大小限制、事件路由和项目上下文失败。

## 公开错误类别

- HOOK_INPUT_INVALID_JSON：stdin 不是有效 JSON。
- HOOK_INPUT_TOO_LARGE：stdin 超过 1 MiB 安全限制。
- HOOK_INPUT_INVALID：输入不满足宿主事件契约。
- HOOK_EVENT_MISMATCH：输入事件与配置的 lifecycle event 不一致。
- HOOK_PROJECT_CONTEXT_UNAVAILABLE：输入中的项目目录不存在、不可访问或不是目录。
- HOOK_RUNTIME_ERROR：其余无法安全归类的入口异常。

所有类别继续返回宿主对应的拒绝结果。公开消息只包含稳定类别和固定说明，不得拼接异常消息、原始输入、绝对路径、Session 标识、认证头、Cookie、密码、Secret 或 Token。

## Doctor 自检

doctor 仅在项目已配置 Hook 时运行有界自检。自检直接调用包内受审共享策略引擎，以合成结构化写请求确认 guarded 模式拒绝、observe 模式警告；它不得启动 shell、动态加载或执行目标项目代码、创建文件或读取凭据。

自检状态为 pass、degraded、disabled、not-installed 或 unsupported。只有 degraded 影响 doctor 健康状态；宿主激活与 trust 仍按既有机制单独报告。

## 验证

- Hook CLI fixture 覆盖 malformed JSON、超限输入、事件不匹配和项目上下文失败。
- 每个失败均保持 fail-closed，且输出不含 fixture 原文或 credential-shaped 值。
- doctor 自检返回固定状态与错误码，并确认合成目标没有落盘。
