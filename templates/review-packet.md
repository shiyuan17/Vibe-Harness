# Review 审查包

填写规则：字段名使用中文；validator 同时兼容旧英文字段。标记“必填”的字段不得留空；禁止 TODO、TBD、待定和无证据结论。问题按严重度排序，先列问题，再写摘要。

## 输入

必填。列出 reviewer 实际读取的规格、任务 brief、实现报告、diff 和验证证据。

## 审查结论

- 规格符合度:
- 代码质量:

必填值：规格符合度使用 `Pass` / `Fail` / `Cannot verify`；代码质量使用 `Approved` / `Request changes` / `Blocked by missing evidence`。

## 问题列表

必填。每项包含严重度、位置或证据、问题、影响和建议处理；无问题时明确写 `No blocking findings`。

| 严重度 | 位置 / 证据 | 问题 | 影响 | 建议处理 |
| --- | --- | --- | --- | --- |
| `Critical` / `High` / `Medium` / `Low` |  |  |  |  |

## 阻断条件

以下阻断条件任一命中时不得批准：

- `Critical` 或 `High` 未处理。
- 验证证据无法覆盖验收标准。
- 红区人工确认缺失。
- 实现者自证高风险最终通过。

## 待确认问题

列出需要用户、owner、外部系统或 reviewer 决策的问题。

## 已核验证

必填。列出命令、退出码、关键输出、截图或人工核对来源。

## 剩余风险

必填。说明未覆盖场景、可接受原因和后续 owner。

## 摘要

简述审查结论：`Approve` / `Request changes` / `Blocked by missing evidence`。
