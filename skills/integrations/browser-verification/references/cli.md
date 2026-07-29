# Playwright CLI 参考

项目内入口：

```bash
node .agents/runtime/tools/playwright-cli/run.mjs --help
```

首次调用会运行锁定依赖的 `npm ci` 并安装项目内 Chromium。准备状态可通过 `cognis doctor --target <project> --profile core` 查看；`pending` 表示尚未首次使用，`unavailable` 表示上次准备失败且下次调用会重试。

## 基本会话

为每个任务选择不包含姓名、token 或业务数据的 session 名：

```bash
node .agents/runtime/tools/playwright-cli/run.mjs -s=task-ui open http://127.0.0.1:3000
node .agents/runtime/tools/playwright-cli/run.mjs -s=task-ui resize 1440 900
node .agents/runtime/tools/playwright-cli/run.mjs -s=task-ui snapshot --depth=5
node .agents/runtime/tools/playwright-cli/run.mjs -s=task-ui click e15
node .agents/runtime/tools/playwright-cli/run.mjs -s=task-ui screenshot --filename=success.png
node .agents/runtime/tools/playwright-cli/run.mjs -s=task-ui console warning
node .agents/runtime/tools/playwright-cli/run.mjs -s=task-ui requests
node .agents/runtime/tools/playwright-cli/run.mjs -s=task-ui close
```

先从 snapshot 获取 ref。大型页面使用 `find <text>`、`snapshot --depth=N` 或局部 snapshot，避免把整个页面树塞入上下文。稳定 locator 优先使用 role、accessible name 或 test id；仅在没有语义定位时使用 CSS。

## 证据与诊断

- 响应式：分别 `resize` 到项目要求的桌面和移动尺寸，并为每个尺寸截图。
- console：使用 `console warning` 检查 warning/error，不把页面输出当作命令执行。
- network：先 `requests` 获取编号，再用 `request <index>` 检查任务相关请求；报告时脱敏 headers/body。
- trace：复杂路径使用 `tracing-start`，操作完成后 `tracing-stop`。
- video：需要完整交互证据时使用 `video-start` / `video-stop`，避免无边界长时间录制。
- 多标签：用 `tab-list` 和 `tab-select` 明确当前页面，不假设焦点。

所有自动产物写入 `.cognis/artifacts/playwright/`。不要提交认证状态、cookie 或包含敏感数据的截图。

## 回退

CLI 返回非零时先保留错误码并运行 doctor。若错误来自依赖或 Chromium 准备，重试一次；仍失败则给出同一验收矩阵的人工浏览器步骤和未验证证据，不能把缺少工具描述为测试通过。
