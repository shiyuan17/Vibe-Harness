---
name: browser-testing-with-devtools
description: Use when user-facing browser behavior must be verified through DevTools or an equivalent interactive browser.
---

# 浏览器验证兼容入口

使用 `browser-verification` 作为唯一实现真值。优先通过可用 DevTools/browser MCP 验证页面、交互、控制台和网络；不可用时回退为人工浏览器步骤并明确未自动验证内容。不得仅用静态检查宣称运行时 UI 正确。
