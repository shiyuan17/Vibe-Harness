# 性能工艺

前端性能的具象技术与预算。强制门禁见 `docs/rules/frontend-rules.md`；组件状态变体见 `component-states.md`。

## 测量与设备矩阵

| 要求 | 做法 | 为什么 |
|---|---|---|
| 设备/浏览器矩阵 | 测试 iOS 低电量模式、macOS Safari | 低端与异构环境暴露隐藏瓶颈 |
| 可靠测量 | 禁用添加开销或改变运行时的扩展 | 扩展干扰基线，测量失真 |
| 节流 profiling | CPU 与网络节流下测试 | 模拟真实用户环境 |
| re-render 追踪 | 用 React DevTools 或 React Scan 追踪重渲染 | 非必要重渲染是性能主因 |

## 布局与渲染

| 要求 | 做法 | 为什么 |
|---|---|---|
| 最小化 layout work | 批量读写 DOM，避免交替 read/write | 交替触发 layout thrash（强制同步布局） |
| 击键成本 | 优先 uncontrolled 输入；controlled 输入保证每击键廉价 | controlled 输入每次击键触发重渲染 |
| 大列表虚拟化 | >50 项列表用虚拟化（如 virtua）或 `content-visibility: auto` | 全量渲染 DOM 阻塞交互 |
| 让浏览器布局 | 优先 flex/grid/intrinsic 布局，避免 JS 测量 | JS 测量触发 layout thrash |
| offload 昂贵任务 | 长任务移到 Web Worker | 避免阻塞主线程交互 |

## 网络与资源

| 要求 | 预算/做法 | 为什么 |
|---|---|---|
| 网络延迟 | POST/PATCH/DELETE 在 500ms 内完成 | 超过 500ms 用户感知等待 |
| 明智 preload | 只 preload 首屏关键图片；其余懒加载 | 预加载非关键资源浪费带宽 |
| 图片 CLS 防护 | 设置显式 `width`/`height`，预留空间 | 加载完成后布局不偏移 |
| preconnect | 对资源/CDN 域名用 `<link rel="preconnect">`（跨源加 `crossorigin`） | 提前完成 DNS/TCP/TLS 握手 |
| 字体 preload | 关键文本字体 `<link rel="preload" as="font">` + `font-display: swap` | 避免 FOUT/FOIT 与布局偏移 |
| 字体子集 | 只发布需要的码点/脚本，用 `unicode-range`；限制可变轴 | 减小字体文件体积 |

## 水合安全

| 要求 | 做法 | 为什么 |
|---|---|---|
| 输入不丢焦/丢值 | 水合后输入保持焦点与值 | 水合不匹配破坏交互连续性 |
| 日期/时间防护 | 水合时日期/时间渲染防御不匹配 | 服务端与客户端时区/时间不同导致水合错误 |
| uncontrolled 优先 | 尽可能用 uncontrolled 输入 | 减少水合期状态冲突 |

## 核心指标

| 指标 | 关注点 |
|---|---|
| LCP | 最大内容绘制；首屏主内容加载速度 |
| INP | 交互到下一帧；全页交互响应度 |
| CLS | 累积布局偏移；视觉稳定性 |

为 bundle 体积设预算；关注以上 Core Web Vitals 指标。
