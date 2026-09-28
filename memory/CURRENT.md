# 当前活跃上下文

本文件是跨 session 恢复的唯一入口，记录当前任务的最小恢复线索。每次结束会话前更新，恢复时从本文件开始，再按其引用读取治理记忆。

<!-- 渲染说明：此模板含 render 占位符，安装时由 template-renderer 输出，内容不与 .agents/memory/CURRENT.md 逐字对应；实时活跃上下文见 .agents/memory/CURRENT.md。占位符：{{projectName}}。 -->

若项目安装了治理记忆（`docs/memory/`），项目阶段、技术债与决策经本文件引用 `docs/memory/PROJECT_STATE.md` 读取，不在此复制其内容；本文件只记录任务级恢复线索。

- 目标:
- 当前状态: (任务级状态；不复制 PROJECT_STATE.md 的当前阶段或当前重点)
- 已验证证据:
- 未完成事项:
- 下一步最小动作:
- 锚点提交: (更新本文件时的 HEAD 完整 SHA，40 位十六进制；恢复时核验它仍是当前历史的祖先)
- 最后更新: (YYYY-MM-DD，使用绝对日期，不得用相对表达)
- 最后验证: (YYYY-MM-DD，恢复时若超过 1 天须重新核验)
