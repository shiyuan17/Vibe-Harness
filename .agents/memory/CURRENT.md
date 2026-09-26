# 当前活跃上下文

本文件是跨 session 恢复的唯一入口，记录当前任务的最小恢复线索。每次结束会话前更新，恢复时从本文件开始，再按其引用读取治理记忆。

<!-- 渲染说明：此模板含 render 占位符，安装时由 template-renderer 输出，内容不与 .agents/memory/CURRENT.md 逐字对应；实时活跃上下文见 .agents/memory/CURRENT.md。占位符：Vibe-Harness。 -->

项目阶段、技术债与决策经本文件引用 `docs/memory/PROJECT_STATE.md` 读取，不在此复制其内容；本文件只记录任务级恢复线索。

- 目标: 在 codex/governance-audit-batch 上按 git 规范分批提交并推送本轮规则与验证改进（codegraph 证据复用与降级边界、warm 环境复用契约、L0-L6 层级表述、十二层责任地图、GC 覆盖 docs/rules、离线 reference 指纹刷新）
- 当前状态: 6 个提交已落地（a8b5747 codegraph 规则与路由用例、381dd1a warm 复用契约、84016c8 L0-L6 表述、d0c2169 十二层责任地图、6e0dff8 GC 覆盖 docs/rules、6e25608 reference 指纹刷新）；本记忆提交只做锚点收尾，随后推送
- 已验证证据: 提交前 `pnpm verify:focused --run` passed、`pnpm check:fast` passed、`pnpm test:integration` 556 pass/0 fail/1 skip、`pnpm docs:audit` 134 文档、`pnpm skills:audit` clean、`pnpm eval:check`/`eval:replay`/`eval:sync`（drift 0）passed；reference 仅 rules 组与 aggregateHash 漂移（rules 5a28ee4c→466701d2、aggregate 5f884e82→e5171e4c），按 CONTRIBUTING 清单经 eval run → eval reference --confirm-reference-update --force（旧文件备份在 .vibe-harness/backups/）→ eval:sync --write → eval:replay --write → eval:behavioral --write 再生成
- 未完成事项: nightly 模型背书回归（H01/H04/H06/H09）仍未取得证据；本轮规则改动的中间提交不各自通过 eval:check（整树资产指纹只在末次 rules 变更与 reference 同批落地后一致），仅批次末端可比
- 下一步最小动作: 推送后核对 origin/codex/governance-audit-batch 与本地一致；随后安排 nightly H01–H20 模型背书回归
- 锚点提交: 6e256089f1240b9b318615bdb50fc0e71cbf1db1
- 最后更新: 2026-09-26
- 最后验证: 2026-09-26
