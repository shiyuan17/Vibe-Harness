# 安全策略

Vibe-Harness 只写入目标项目，不修改全局 Agent、MCP 或 Git 配置。Hook、Execution Envelope、红区写入和凭据边界是纵深防御，不构成完整的机器安全边界；文件系统、进程与网络隔离仍需由宿主沙箱与网络代理独立提供，详见 `docs/hooks.md`。

## 报告漏洞

请不要在公开 Issue、讨论区或 PR 中披露未修复的安全问题。

- 使用 GitHub 仓库的 Security 页面中的 “Report a vulnerability” 私密报告入口提交。
- 报告请包含：受影响组件与版本、复现步骤或最小 PoC、影响评估，以及已知的缓解方式。
- 请在复现材料中对 token、凭据、Cookie、会话标识和个人数据做脱敏，不要附带真实凭据。

## 覆盖范围

- 安装器、事务提交、回滚与目标路径逃逸。
- Hook 策略判定与 Execution Envelope 授权边界。
- 生成的宿主配置（MCP、Hook、AGENTS/CLAUDE/GEMINI/opencode 入口）。
- 项目内 runtime 工具的供应链与锁定版本。

## 处理流程

维护者在收到报告后确认影响范围，评估严重度并制定修复与发布计划；修复发布后可与报告者协商披露时间。

## 既有缓解

- 真实写入统一要求 `--write`，红区写入额外要求 `--confirm-red-zone`。
- 安装器不持久化外部认证凭据，也不写入全局 Agent 或 Git 配置。
- 无法安全判定的高风险操作按 fail-closed 处理，并如实报告覆盖边界。
