---
name: frontend-design
description: Use for frontend visual direction, polish, responsiveness, or redesign-not logic-only work.
---

# 设计并验证前端体验

强制门禁（规则、检查清单、设计护栏、停止条件）见 `docs/rules/frontend-rules.md`；本 Skill 提供执行流程与决策步骤。

## 参考路由

按需读取，不默认全载：

| 参考文件 | 何时读取 |
|---|---|
| `references/design-tokens.md` | 建立或复用令牌系统（colors/typography/spacing/radius/elevation）时 |
| `references/design-modes.md` | 确定视觉方向（营销/品牌 vs 产品/后台）与共同门槛时 |
| `references/component-states.md` | 定义组件状态变体、契约与设计护栏时 |
| `references/interactions.md` | 实现键盘、焦点、触控、滚动、反馈与状态导航工艺时 |
| `references/forms.md` | 实现表单提交、校验、字段类型与密码管理器兼容时 |
| `references/motion.md` | 实现动效、reduced-motion 偏好与合成器友好属性时 |
| `references/content-a11y.md` | 处理内容排版、语义、本地化与可访问性命名时 |
| `references/performance.md` | 优化渲染、网络资源、水合安全与核心指标时 |
| `references/visual-craft.md` | 打磨投影、圆角、对比度、暗色模式与文本渲染时 |

## 执行

1. 识别用户任务、内容密度、设备范围、品牌资产和现有设计系统；盘点目标项目已有的令牌系统与组件库，判断复用还是新建最小集。
2. 选择一个明确视觉方向，建立信息层级、布局节奏、字体、颜色和反馈；遵循单一强调色原则。视觉方向与共同门槛见 `references/design-modes.md`，视觉工艺见 `references/visual-craft.md`。
3. 建立或复用最小令牌集（colors、typography、spacing、radius、elevation），语义命名并支持暗色模式映射；组件通过 `{token}` 引用定义样式，禁止魔法值。令牌骨架见 `references/design-tokens.md`。
4. 覆盖组件状态变体（default、hover、pressed、focused、disabled、inverse）以及加载、空、错误、成功、长文本、键盘和响应式状态。状态契约见 `references/component-states.md`，交互与表单工艺见 `references/interactions.md` 与 `references/forms.md`。
5. 实现动效时只动合成器属性并尊重 reduced-motion 偏好；见 `references/motion.md`。处理内容与可访问性时语义优先、locale 格式化；见 `references/content-a11y.md`。
6. 关注核心指标（LCP/INP/CLS）、资源加载与水合安全；见 `references/performance.md`。
7. 使用真实浏览器检查布局、溢出、对比度和关键交互；能力缺失时列出人工验收矩阵。

已有设计稿时忠实实现，不另造风格。不要为了视觉变化改写无关业务逻辑。
