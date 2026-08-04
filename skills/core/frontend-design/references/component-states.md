# 组件状态变体与契约

每个交互组件必须覆盖完整状态变体，并通过令牌引用定义样式。强制门禁见 `docs/rules/frontend-rules.md`；令牌骨架见 `design-tokens.md`。

## 必须状态清单

| 状态 | 用途 | 必备场景 |
|---|---|---|
| `default` | 静止默认态 | 所有组件 |
| `hover` | 指针悬停 | 可点击/可交互组件 |
| `pressed` | 按下/激活中 | 按钮类组件 |
| `focused` | 键盘或程序聚焦 | 所有可聚焦组件 |
| `disabled` | 不可交互 | 可被禁用的组件 |
| `inverse` | 反色背景上呈现 | 用于深色/浅色区块切换 |

每个状态单独成令牌条目，用 `{token}` 引用，禁止魔法值。状态变体之间视觉差异可辨但不破坏布局稳定。

## 组件契约约定

- **props 命名**：受控值用 `value`/`onChange`，非受控用 `defaultValue`；可见性用 `open`/`onOpenChange`；尺寸用语义名（`sm`/`md`/`lg`）而非像素。
- **受控/非受控**：同一组件支持两种模式；受控时父组件持有状态，非受控时组件内部持有并通过 ref 暴露命令式 API。
- **组合规则**：复合组件用 children 或具名 slot 组合，不硬编码子元素结构；子组件可独立替换。
- **可访问性**：交互组件用语义 HTML 或 ARIA 角色映射；键盘操作符合模式约定（如 Dialog 用 Esc 关闭、Tab 焦点陷阱）。
- **稳定性**：props 增量兼容，不破坏既有消费者；破坏性变更走版本号。

## 状态变体令牌引用要求

状态变体通过令牌引用定义，而非内联值：

```yaml
input-text:
  default:
    backgroundColor: "{colors.surface-2}"
    border: "{colors.hairline}"
    radius: "{radius.sm}"
    typography: "{typography.body}"
  focused:
    border: "{colors.accent}"
    outline: "{colors.accent}"
  error:
    border: "{colors.danger}"
    helperText: "{colors.danger}"
  disabled:
    opacity: 0.5
```

不合规示例（禁止）：`focused: { border: "#5e6ad2" }` — 硬编码魔法值，无法随主题切换。

## 设计护栏模板

目标项目用此双列 checklist 填充具体护栏。借鉴 awesome-design-md 的 Do/Don't 范式。

### Do

- _待填：例如"按钮主操作用 accent 色，次操作用 surface + hairline"_
- _待填：例如"聚焦环用 accent 色 2px 偏移"_
- _待填：例如"禁用态用 opacity 而非改色，保持可辨识"_
- _待填：例如"错误态用 danger 色边框 + helper 文案"_

### Don't

- _待填：例如"不要用纯黑边框代替 hairline 令牌"_
- _待填：例如"不要在 hover 态改变组件尺寸造成布局跳动"_
- _待填：例如"不要用第二强调色区分主次按钮，用填充 vs 描边区分"_
- _待填：例如"不要省略 focused 态，仅靠浏览器默认 outline"_

## 状态验证

发布前核对每个交互组件的状态矩阵：在 default/hover/pressed/focused/disabled/inverse 下检查视觉表现、令牌引用、键盘可达与布局稳定。
