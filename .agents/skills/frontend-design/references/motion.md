# 动效工艺
动效的具象实现技术与约束。强制门禁见 `docs/rules/frontend-rules.md`；组件状态变体见 `component-states.md`。

## 优先级与实现

| 优先级 | 技术 | 为什么 |
|---|---|---|
| 1 | CSS transitions/animations | 声明式、主线程外合成、性能最优 |
| 2 | Web Animations API（`element.animate()`） | 命令式但仍在合成线程运行 |
| 3 | JS 动画库（framer-motion 等） | 最后选择；主线程驱动，性能开销大 |

避免主线程 JS 驱动的动画；主线程动画在低端设备或高负载下丢帧。

## 合成器友好属性

| 用 | 不用 | 为什么 |
|---|---|---|
| `transform`（translate/scale/rotate） | `top`/`left`/`right`/`bottom` | `transform` 在合成线程处理，不触发 layout |
| `opacity` | `width`/`height`/`margin`/`padding` | `opacity` 合成友好；尺寸属性触发 reflow |

合成器属性在 GPU 上运行，跳过 layout 与 paint 阶段。

## 禁止项

| 禁止 | 替代 | 为什么 |
|---|---|---|
| `transition: all` | 显式列出目标属性（通常 `opacity`、`transform`） | `all` 可能动画非预期属性（如 `color`、`background`），触发意外 reflow |
| 动画 layout 属性 | 动画 `transform: translateX()` 代替 `left` | layout 属性触发重排，全页重绘 |
| 自动播放循环 | 响应用户输入触发 | 自动播放干扰用户、消耗电量 |

## reduced-motion

| 要求 | 做法 | 为什么 |
|---|---|---|
| 尊重偏好 | 响应 `prefers-reduced-motion: reduce` | 前庭障碍用户对动效敏感 |
| 降级变体 | 提供减弱版本（即时切换代替滑动）或完全禁用 | 非二选一；部分动效可保留功能性反馈 |
| 功能性动效保留 | 指示状态变化的动效即使减弱也应可感知 | 完全禁用可能丢失因果反馈 |

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

## 必要性与缓动

| 原则 | 说明 |
|---|---|
| 必要性判定 | 只在阐明因果关系或刻意增趣时动画；装饰性动效应删 |
| 缓动选择 | 依变化内容选：尺寸变化用 `ease-out`，位移用标准缓动，触发反馈用弹簧 |
| 可中断 | 动画可被用户输入取消；不阻塞交互 |
| 输入驱动 | 响应动作触发，而非自动播放 |
| transform-origin | 锚定到动效物理起点（如展开从触发点开始） |

## SVG 变换

| 要求 | 做法 | 为什么 |
|---|---|---|
| 包裹变换 | 对 `<g>` wrapper 应用变换，而非直接变换图形元素 | 跨浏览器对 SVG 元素 transform 支持不一致 |
| 填充盒锚定 | `transform-box: fill-box; transform-origin: center;` | 默认 transform-box 在 SVG 中行为不一致 |
| 文本抗锯齿 | 优先动画 wrapper 而非文本节点；artifacts 持续时用 `translateZ(0)` 或 `will-change: transform` | 直接变换文本触发抗锯齿退化
