# 当前活跃上下文

本文件是跨 session 恢复的唯一入口，记录当前任务的最小恢复线索。每次结束会话前更新，恢复时从本文件开始，再按其引用读取治理记忆。

<!-- 渲染说明：此模板含 render 占位符，安装时由 template-renderer 输出，内容不与 .agents/memory/CURRENT.md 逐字对应；实时活跃上下文见 .agents/memory/CURRENT.md。占位符：Vibe-Harness。 -->

项目阶段、技术债与决策经本文件引用 `docs/memory/PROJECT_STATE.md` 读取，不在此复制其内容；本文件只记录任务级恢复线索。

- 目标: 按 `harness提示词优化.mak` 对 Harness 常驻指令面做 token 效率审查并落地整改（分支 codex/governance-audit-batch，远端 shiyuan17/Vibe-Harness）；顺序为 P1 受管指令段落单源化 → P2 常驻段瘦身 → P3 规则 Fast Path 卡片
- 当前状态: P1（受管指令共享段单源化）与 P2（常驻受管段瘦身）均已落地；P3（test-rules/git-rules 的 Fast Path 卡片 + rules-index 标注）未开始
- 已验证证据: P1 提交前 8 个 adapter 渲染快照逐字节一致；P2 后 AGENTS.md 常驻面 2532→2329 tokens（o200k），分段实测 硬边界 96→72、规则优先级 137→95、verify 212→163、memory 106→79、启动段2 130→108、启动段5 70→58、重复 memorySkillsLine 27→0；两轮门禁全绿（validate 含自装一致性、pnpm check 319/319、test:integration 531 pass/0 fail/1 skip、docs:audit、eval:check、skills:audit、eval:harness:fast）
- 未完成事项: P3 未开始；nightly 模型背书回归（H01/H04/H06/H09）启动后未跑完即被中断，尚未取得该证据
- 下一步最小动作: 执行 P3（两张规则卡片 + rules-index 标注 + 按 CONTRIBUTING 清单重生成 eval reference）
- 锚点提交: ae1e0da9c5c484ca1464be7bd6546b811d9e3d21
- 最后更新: 2026-09-24
- 最后验证: 2026-09-24
