---
name: frontend-design
description: Use for frontend visual direction, polish, responsiveness, or redesign-not logic-only work.
---

# 设计并验证前端体验

强制门禁（规则、检查清单、设计护栏、停止条件）见 `docs/rules/frontend-rules.md`；本 Skill 提供执行流程与决策步骤。深入令牌骨架见 `references/design-tokens.md`，设计模式与共同门槛见 `references/design-modes.md`，组件状态变体与契约见 `references/component-states.md`。

## 执行

1. 识别用户任务、内容密度、设备范围、品牌资产和现有设计系统；盘点目标项目已有的令牌系统与组件库，判断复用还是新建最小集。
2. 选择一个明确视觉方向，建立信息层级、布局节奏、字体、颜色和反馈；遵循单一强调色原则。
3. 建立或复用最小令牌集（colors、typography、spacing、radius、elevation），语义命名并支持暗色模式映射；组件通过 `{token}` 引用定义样式，禁止魔法值。
4. 覆盖组件状态变体（default、hover、pressed、focused、disabled、inverse）以及加载、空、错误、成功、长文本、键盘和响应式状态。
5. 使用真实浏览器检查布局、溢出、对比度和关键交互；能力缺失时列出人工验收矩阵。

已有设计稿时忠实实现，不另造风格。不要为了视觉变化改写无关业务逻辑。
