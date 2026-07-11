# Review Packet

填写规则：字段名保持英文以供 validator 解析，内容使用项目语言。标记“必填”的字段不得留空；禁止 TODO、TBD、待定和无证据结论。问题按严重度排序，先列问题，再写摘要。

## Inputs

必填。列出 reviewer 实际读取的规格、任务 brief、实现报告、diff 和验证证据。

## Review Verdict

- Specification:
- Code Quality:

必填值：Specification 使用 `Pass` / `Fail` / `Cannot verify`；Code Quality 使用 `Approved` / `Request changes` / `Blocked by missing evidence`。

## Findings

必填。每项包含严重度、位置或证据、问题、影响和建议处理；无问题时明确写 `No blocking findings`。

| 严重度 | 位置 / 证据 | 问题 | 影响 | 建议处理 |
| --- | --- | --- | --- | --- |
| `Critical` / `High` / `Medium` / `Low` |  |  |  |  |

## Blocking Conditions

以下阻断条件任一命中时不得批准：

- `Critical` 或 `High` 未处理。
- 验证证据无法覆盖验收标准。
- 红区人工确认缺失。
- 实现者自证高风险最终通过。

## Open Questions

列出需要用户、owner、外部系统或 reviewer 决策的问题。

## Verification Checked

必填。列出命令、退出码、关键输出、截图或人工核对来源。

## Residual Risk

必填。说明未覆盖场景、可接受原因和后续 owner。

## Summary

简述审查结论：`Approve` / `Request changes` / `Blocked by missing evidence`。
