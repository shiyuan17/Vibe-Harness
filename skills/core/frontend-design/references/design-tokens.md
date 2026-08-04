# 设计令牌骨架

本参考提供令牌系统的结构与命名约定，供目标项目填充具体值。借鉴 DESIGN.md 双文件隐喻：`AGENTS.md` 管"如何构建项目"，`DESIGN.md` 管"项目应如何呈现与感觉"。本骨架即目标项目 DESIGN.md 的令牌层基础。

## 双文件隐喻

| 文件 | 受众 | 目的 |
|---|---|---|
| `AGENTS.md` | coding agents | 如何构建项目（命令、结构、测试） |
| `DESIGN.md` | design agents | 项目应如何呈现（令牌、组件、模式） |

目标项目可在根目录维护 `DESIGN.md`，用 YAML frontmatter 承载原子令牌、Markdown 正文承载语义叙述。AI coding agent 直接读取，无需解析工具。

## 令牌原则

- **语义命名**：按角色命名（`surface-1`、`ink-muted`）而非色值（`#f5f5f5`）。
- **令牌引用**：组件定义用 `{colors.primary}`、`{typography.button}` 引用原子令牌，保证单一数据源与可追溯。
- **阶梯而非自由值**：每个维度给完整命名阶梯，禁止魔法值。
- **单一强调色**：强调色只用于品牌标记、主 CTA、聚焦环、链接。
- **暗色模式映射**：令牌按角色定义，暗色模式只改映射值不改组件结构。

## 颜色令牌骨架

按角色分组，值留空待目标项目填。

| 角色 | 令牌名 | 用途 | 亮色值 | 暗色值 |
|---|---|---|---|---|
| Brand | `colors.brand` | 品牌主色 | _待填_ | _待填_ |
| Accent | `colors.accent` | 强调色（主 CTA/聚焦环/链接） | _待填_ | _待填_ |
| Surface | `colors.surface-1` | 基础画布 | _待填_ | _待填_ |
| Surface | `colors.surface-2` | 提升层（卡片） | _待填_ | _待填_ |
| Surface | `colors.surface-3` | 再提升层（悬浮面板） | _待填_ | _待填_ |
| Surface | `colors.surface-4` | 最高层（弹层） | _待填_ | _待填_ |
| Text | `colors.ink` | 正文 | _待填_ | _待填_ |
| Text | `colors.ink-muted` | 次要文本 | _待填_ | _待填_ |
| Text | `colors.ink-subtle` | 占位/辅助 | _待填_ | _待填_ |
| Line | `colors.hairline` | 分隔线/边框 | _待填_ | _待填_ |
| Semantic | `colors.success` | 成功 | _待填_ | _待填_ |
| Semantic | `colors.warning` | 警告 | _待填_ | _待填_ |
| Semantic | `colors.danger` | 危险/错误 | _待填_ | _待填_ |
| Semantic | `colors.info` | 信息 | _待填_ | _待填_ |

不要用纯黑（`#000000`）或纯白（`#ffffff`）作为画布；用语义 surface 令牌承载体积与层级。

## 字体令牌骨架

字阶令牌从展示到说明，每级含完整字段。

| 令牌名 | fontFamily | fontSize | fontWeight | lineHeight | letterSpacing | 用途 |
|---|---|---|---|---|---|---|
| `typography.display-xl` | _待填_ | _待填_ | _待填_ | _待填_ | _待填_ | 首屏展示 |
| `typography.display-lg` | _待填_ | _待填_ | _待填_ | _待填_ | _待填_ | 章节标题 |
| `typography.display-md` | _待填_ | _待填_ | _待填_ | _待填_ | _待填_ | 页面标题 |
| `typography.heading` | _待填_ | _待填_ | _待填_ | _待填_ | _待填_ | 区块标题 |
| `typography.subheading` | _待填_ | _待填_ | _待填_ | _待填_ | _待填_ | 子标题 |
| `typography.body` | _待填_ | _待填_ | _待填_ | _待填_ | _待填_ | 正文 |
| `typography.body-small` | _待填_ | _待填_ | _待填_ | _待填_ | _待填_ | 辅助正文 |
| `typography.caption` | _待填_ | _待填_ | _待填_ | _待填_ | _待填_ | 说明/标注 |
| `typography.button` | _待填_ | _待填_ | _待填_ | _待填_ | _待填_ | 按钮文本 |
| `typography.label` | _待填_ | _待填_ | _待填_ | _待填_ | _待填_ | 表单标签 |
| `typography.mono` | _待填_ | _待填_ | _待填_ | _待填_ | _待填_ | 代码/数据 |

专有字体必须给出开源替代建议（如 Inter、Geist Sans、JetBrains Mono）。

## 间距令牌骨架

以 4px 或 8px 为基准的命名阶梯。

| 令牌名 | 值 | 用途 |
|---|---|---|
| `spacing.xxs` | _待填_ | 紧凑间隔（图标内） |
| `spacing.xs` | _待填_ | 控件内边距 |
| `spacing.sm` | _待填_ | 控件间 |
| `spacing.md` | _待填_ | 区块内 |
| `spacing.lg` | _待填_ | 区块间 |
| `spacing.xl` | _待填_ | 章节间 |
| `spacing.xxl` | _待填_ | 大章节间 |
| `spacing.section` | _待填_ | 页面级留白 |

## 圆角令牌骨架

| 令牌名 | 值 | 用途 |
|---|---|---|
| `radius.xs` | _待填_ | 小控件（徽章） |
| `radius.sm` | _待填_ | 输入框 |
| `radius.md` | _待填_ | 按钮 |
| `radius.lg` | _待填_ | 卡片 |
| `radius.xl` | _待填_ | 大容器 |
| `radius.xxl` | _待填_ | 产品截图 tile |
| `radius.pill` | _待填_ | 胶囊按钮 |
| `radius.full` | _待填_ | 圆形头像 |

## 高度令牌骨架

| 令牌名 | 处理 | 用途 |
|---|---|---|
| `elevation.0` | flat | 平面 |
| `elevation.1` | hairline + 轻微提升 | 卡片 |
| `elevation.2` | 明显提升 | 悬浮面板 |
| `elevation.3` | 渐变背景层 | 装饰深度 |
| `elevation.4` | 聚焦环 | 聚焦反馈 |

深度优先用 surface 阶梯 + hairline 边框承载，投影仅用于真正悬浮的元素。

## 组件令牌引用示例

组件用令牌引用定义，状态变体单独成条（详见 `component-states.md`）：

```yaml
button-primary:
  backgroundColor: "{colors.accent}"
  color: "{colors.surface-1}"
  radius: "{radius.md}"
  padding: "{spacing.xs} {spacing.sm}"
  typography: "{typography.button}"
  states:
    hover: { backgroundColor: "{colors.accent}" }  # 略深，由目标项目定
    pressed: { backgroundColor: "{colors.accent}" }  # 略深
    focused: { outline: "{colors.accent}" }
    disabled: { opacity: 0.5 }
```
