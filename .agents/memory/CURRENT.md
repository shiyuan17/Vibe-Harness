# 当前活跃上下文

本文件是跨 session 恢复的唯一入口，记录当前任务的最小恢复线索。每次结束会话前更新，恢复时从本文件开始，再按其引用读取治理记忆。

<!-- 渲染说明：此模板含 render 占位符，安装时由 template-renderer 输出，内容不与 .agents/memory/CURRENT.md 逐字对应；实时活跃上下文见 .agents/memory/CURRENT.md。占位符：Vibe-Harness。 -->

项目阶段、技术债与决策经本文件引用 `docs/memory/PROJECT_STATE.md` 读取，不在此复制其内容；本文件只记录任务级恢复线索。

- 目标: 按 `harness提示词优化.mak` 对 Harness 常驻指令面做 token 效率审查并落地整改（分支 codex/governance-audit-batch，远端 shiyuan17/Vibe-Harness）；顺序为 P1 受管指令段落单源化 → P2 常驻段瘦身 → P3 规则 Fast Path 卡片
- 当前状态: P1 完成（adapters 四份模板的共享段改由 scripts/lib/template-renderer.js 的 buildManagedInstructionSections 单一生成，校验改为「原始体 + 渲染面」，常驻行预算改测渲染面），P2/P3 未开始
- 已验证证据: 本轮提交前的 8 个 adapter 渲染快照对比逐字节一致；P1 门禁待本轮收尾执行（validate.js / check:fast / test:component / test:integration / docs:audit）
- 未完成事项: P2 常驻受管段瘦身（verify 段、硬边界、规则优先级、memory 段、启动段 2/5、去重复 memorySkillsLine）与 P3 test-rules/git-rules 的 Fast Path 卡片未开始
- 下一步最小动作: 完成 P1 门禁与提交推送后，按审查报告执行 P2，再执行 P3
- 锚点提交: 77f99beca677e802ce21cf210f1926aa37dc4a1d
- 最后更新: 2026-09-24
- 最后验证: 2026-09-24
