# 项目状态

<!-- 渲染说明：此模板含 render 占位符，安装时由 template-renderer 输出，内容不与 docs/memory/PROJECT_STATE.md 逐字对应；实时项目状态见 docs/memory/PROJECT_STATE.md。占位符：Vibe-Harness。 -->

- 最后更新: 2026-10-14
- 当前阶段: 本地工具安装面完成收敛——rtk、ast-grep、codegraph、serena、probe 与 codebase-memory 六个工具插件退役，受管 runtime 插件只剩 chrome-devtools-mcp、playwright-cli 与 open-code-review；codebase-memory-mcp 改为随 rules-core 分发的外部工具使用规范（只声明使用与证据核对，不安装工具、不写 MCP 配置、不管理索引），旧插件、旧模块与 hooks.rtk 经 install --upgrade 迁移且保留用户修改与索引数据；develop 可本地 no-ff 直落与直推（ADR-0013，main／master／release* 发布门禁不变）、高风险单复审者契约（ADR-0012）、gd-flow／lwflow 显式 develop flow（ADR-0015）与 vb-* 显式交付 Skill 命名继续生效，native Skill 计数 core 11／full 14、integration 4，native description 预算 2200 字符，rule–skill parity 七对；GitHub 默认分支为 develop，develop ruleset 24096092 保持 disabled、main ruleset 20501924 保持 active
- 当前重点: 工具退役批次已分四组提交到 codex/delivery-batch 并随本批推送，随后进入 PR #34 收尾（复审、单复审者收据与合并）；下游 BL-CNAS 的回灌仍被受管文件漂移阻塞（.cbmignore、.githooks/pre-commit、.githooks/pre-push、.codex/hooks.json 与 install-state 记录不一致），需要人工决策后再推
- 下一步动作: 复核 PR #34 的检查与单复审者收据后合并；在 BL-CNAS 侧对齐漂移的受管文件，再重跑 install --upgrade --write 与 validate 并补 hook 干跑；再安排 develop → main 提升、backup/governance-audit-batch 等历史引用清理与 nightly H01–H20 模型背书回归
- 恢复提示: 恢复唯一入口是 .agents/memory/CURRENT.md；本文件是被它引用的治理状态源；工具退役批次的状态锚点为 .vibe-harness/tasks/tool-retirement.json（stage=verify，风险档 full）。上一轮 P0–P2 架构审查批次的处置状态见 docs/inventory/harness-superpowers-comparison.md 的「处置状态（2026-09-14）」，未关闭项见 docs/memory/TECH_DEBT.md 的技术债清单；2026-09-22 优化范围见 audit-reports/2026-09-22-optimization-plan.md
