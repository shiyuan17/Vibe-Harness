# 当前活跃上下文

本文件是跨 session 恢复的唯一入口，记录当前任务的最小恢复线索。每次结束会话前更新，恢复时从本文件开始，再按其引用读取治理记忆。

<!-- 渲染说明：此模板含 render 占位符，安装时由 template-renderer 输出，内容不与 .agents/memory/CURRENT.md 逐字对应；实时活跃上下文见 .agents/memory/CURRENT.md。占位符：Vibe-Harness。 -->

项目阶段、技术债与决策经本文件引用 `docs/memory/PROJECT_STATE.md` 读取，不在此复制其内容；本文件只记录任务级恢复线索。

- 目标: 按 `harness提示词优化.mak` 对 Harness 常驻指令面与按需规则面做 token 效率审查并落地整改（分支 codex/governance-audit-batch，远端 shiyuan17/Vibe-Harness）；顺序为 P1 受管指令段落单源化 → P2 常驻段瘦身 → P3 大规则按需加载卡片
- 当前状态: P1、P2、P3 均已落地并推送；本批次（常驻面单源化 + 常驻段瘦身 + 大规则分层加载）收尾完成
- 已验证证据: P1 提交前 8 个 adapter 渲染快照逐字节一致；P2 后 AGENTS.md 常驻面 2532→2329 tokens（o200k），分段实测 硬边界 96→72、规则优先级 137→95、verify 212→163、memory 106→79、启动段2 130→108、启动段5 70→58、重复 memorySkillsLine 27→0；P3 为 5 个超大规则补 Fast Path 卡片（governance-core 449、git-rules 239、test-rules 290、ai-collab-rules 300、linear-workflow 254 tokens），命中后停在卡片的单次节省 4239–5646 tokens，索引新增 ⚡ 标注与图例使常驻面 +26 tokens；P3 门禁全绿（validate 含新增 validateFastPathCards 与大规则卡片门禁、pnpm check 322/322、test:integration 531 pass/0 fail/1 skip、docs:audit 124 文档、docs:sync 0 漂移、eval:check/eval:replay 通过，reference 与 behavioral 产物仅 rules 组指纹漂移且按 CONTRIBUTING 清单显式再生成、skills:audit、eval:harness:fast）
- 未完成事项: nightly 模型背书回归（H01/H04/H06/H09）启动后未跑完即被中断，仍未取得该证据；常驻面与 host 工具定义相比仍只占会话成本的约 2.5%，更大杠杆在宿主侧
- 下一步最小动作: 本批无遗留项；下一批先安排 nightly H01–H20 模型背书回归
- 锚点提交: 6785f2f698b33a6ef7114a35334e7a7a9ad19968
- 最后更新: 2026-09-24
- 最后验证: 2026-09-24
