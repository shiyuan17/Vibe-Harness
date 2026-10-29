---
name: frontend-design
description: Use for frontend direction, polish, responsive work, or redesign—not logic-only or isolated local UI.
---

# 设计并验证前端体验

本 Skill 写明前端执行、验证和停止条件。同步归属：`docs/rules/frontend-rules.md`；两者描述同一前端契约，修改须同步。

## 执行底线

- 只检查本次影响的领域与状态；按内容、局部展示、局部交互、组件状态、共享组件、路由和数据契约的最具体范围选择证据。已有设计系统、组件、品牌、性能预算和浏览器矩阵时沿用。纯文案或无交互/数据流变化的微小修复只核对文本与语法，不补写或运行 E2E。微型 UI 变更（既有页面中的帮助图标、tooltip、局部提示或标签，且不改变路由、网络、数据流和公共契约）默认走静态检查或受影响的组件检查；只有用户明确要求视觉验收，或存在定位、溢出、响应式和跨浏览器风险时才升级浏览器验证。
- 不禁止浏览器缩放；200% 缩放和 320 CSS px 视口下内容与功能完整，不强制二维滚动。正文对比度 ≥4.5:1，大字、控件、状态与焦点 ≥3:1；不只用颜色传意。
- 使用语义链接、按钮和持久字段标签；键盘可达，焦点可见且不被遮挡。模态限制内部焦点，关闭后归还触发点；切换视图更新焦点和标题。目标 ≥24×24 CSS px，移动端沿用设计系统、无体系时取 44×44；拖拽须有单击或键盘替代。
- 表单提供 name/autocomplete，不阻止粘贴、密码管理器或验证码填充，不重复索取已提供信息；错误关联字段、可被辅助技术感知，失败保留输入。破坏性操作须确认或可恢复 Undo。
- 不可信 HTML、属性、URL、CSS、SVG 不直接注入，富文本用白名单净化；postMessage 校验来源与负载、限定目标来源。鉴权由服务端执行，客户端包和可被脚本读取的持久存储不存密钥、令牌或敏感数据。
- 写操作防重复提交，旧响应不覆盖新状态，缓存按身份隔离；乐观更新失败回滚或 Undo，重试有界并退避。遵循已有 CSP、Trusted Types、SRI 和嵌入权限策略，不因视觉任务扩大业务或安全策略范围。
- 按实际影响覆盖语言方向、locale、字幕、播放控制、闪烁及 reduced-motion。服务端用户提示按数据展示，不擅自改写；机器码不作用户文案，已有 i18n 映射不建立第二真值。

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
7. 对关键布局和关键交互使用真实浏览器检查；微型 UI 变更默认不启动浏览器或 E2E，除非命中上一条升级条件；能力缺失时列出人工验收矩阵。

已有设计稿时忠实实现，不另造风格。不要为了视觉变化改写无关业务逻辑。

关键布局与交互使用项目支持的真实浏览器验证；无矩阵时覆盖主流 Chromium 和移动端 WebKit 窄屏。可访问性用可访问性树、键盘走查或人工矩阵核验，自动扫描仅作辅证；性能主张用现场 p75 或真实浏览器性能轨道数据，不以单次本地采样代替。能力缺失时列出未验证项并缩小主张，不称通过。高影响产品/设计决定或生产、权限、不可逆操作缺授权时只暂停相关部分；已有覆盖授权不重复询问，设计体系或设备矩阵缺失不阻塞无关局部修复。
