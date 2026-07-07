# 审查 Packet 模板

填写规则：标记“必填”的字段不得留空；禁止空泛词（待定、视情况、合适测试、后续补充）。Finding 必须按 Severity 排序，先列问题，再写摘要。

## 问题

必填。每项包含 Severity、位置或证据、问题、影响、建议处理。

| Severity | 位置 / 证据 | 问题 | 影响 | 建议处理 |
| --- | --- | --- | --- | --- |
| Critical / High / Medium / Low |  |  |  |  |

## 阻断条件

- Critical 或 High 未处理。
- 验证证据缺失或无法覆盖验收标准。
- 红区人工确认缺失。
- 实现者自证高风险最终通过。

## 待确认问题

列出需要用户、owner、外部系统或 reviewer 决策的问题。

## 已核对验证

必填。列出命令、退出码、关键输出、截图或人工核对来源。

## 剩余风险

必填。说明未覆盖场景、可接受原因和后续建议。

## 摘要

简述审查结论：Approve / Request changes / Blocked by missing evidence。
