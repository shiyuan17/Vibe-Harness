# Review Rules

Review 优先关注 bug、回归、测试缺口、安全风险和规则违规。

## 输入

- 用户请求、Spec、Plan 或 Task。
- 当前 diff、目标分支和相关上下文。
- Workflow Packet、风险等级和红区确认状态。
- 验证证据：命令、退出码、关键输出、截图或人工核对。

## 输出

- Finding 列表，按 Severity 排序。
- 已核对验证和未覆盖风险。
- 待确认问题。
- Verdict：Approve / Request changes / Blocked by missing evidence。

## 问题优先

先列问题，再写摘要。代码审查时按严重程度排序，并尽量包含文件/行号引用。

## 独立判断

高风险工作需要独立于实现者的 checker。checker 核对 diff、范围、测试和工作流 Packet。checker 通过不替代红区人工确认。

## 无 Finding

如果没有发现问题，要明确说明，并补充剩余测试缺口或残余风险。

## 阻断条件

- Critical / High finding 未处理。
- 验证证据缺失，或不能覆盖验收标准。
- 红区人工确认缺失。
- 实现者自证高风险最终通过。
- diff 范围不清，存在可能覆盖用户无关改动的风险。
