# RTK 命令输出压缩规则

RTK 是项目内可选的命令输出压缩工具。它只减少无关输出，不改变命令的退出码、写入范围或验证标准。

## 三种启用面

- `--plugin -rtk` 只安装项目内 RTK 规则、wrapper 和固定版本工具，不启用命令 hook。
- `--plugin -rtk --rtk-hooks on` 额外安装 Codex 项目 hook；仅支持 Codex，写入 `.codex/hooks.json` 仍需 `--confirm-red-zone`。
- RTK 官方全局 hook 不属于 Cognis 安装面。不得运行 `rtk init -g`，也不得修改 PATH、用户级 Codex 配置或其他全局 Agent 配置。

## 使用顺序

1. 需要查看高噪声命令结果时，优先使用项目内入口：`node .agents/cognis/tools/rtk/run.mjs <command> [args...]`。
2. 优先压缩 `git`、测试、构建、包管理器和状态查询等可重复、输出量大的命令。
3. 涉及凭据、交互式输入、破坏性操作、原始日志或需要完整 stdout/stderr 的命令，直接使用原命令并保留必要的原始证据。
4. RTK 输出只能作为导航和摘要；退出码、关键错误、完整日志和验证结果仍以原命令或测试产物为准。
5. 需要完整原始输出时，使用显式 bypass：`node .agents/cognis/tools/rtk/run.mjs proxy <command> [args...]`。

## Codex 项目 hook

- `SessionStart` 与 `PostCompact` 注入 RTK 状态、项目入口和降级说明。
- `PreToolUse` 先执行安全策略；安全拒绝优先于 RTK 建议。
- `observe` 与 `guarded` 放行原命令并给出精确重试命令；`strict` 拒绝未包装命令并要求使用项目入口重试。
- 已包装命令、`rtk proxy`、敏感命令、原始日志命令以及 unsupported、degraded 或超时结果直接放行，避免循环和误阻断。
- 该集成只接受经验证的 RTK `v0.43.0` rewrite 契约；升级 RTK 前必须重新验证输出与退出码。

## 降级与证据

- 工具状态为 `pending`、`degraded` 或 `unsupported` 时，不修改 PATH，不安装全局版本，直接回退到原命令。
- 回退时记录 `tool: rtk`、状态、使用的原命令、原因和可能影响；不得把未压缩输出误报为 RTK 输出。
- RTK 下载必须通过固定版本和 SHA-256 校验；校验失败时停止使用该二进制并报告降级。
