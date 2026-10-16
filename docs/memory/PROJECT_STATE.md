# 项目状态

<!-- 渲染说明：此模板含 render 占位符，安装时由 template-renderer 输出，内容不与 docs/memory/PROJECT_STATE.md 逐字对应；实时项目状态见 docs/memory/PROJECT_STATE.md。占位符：Vibe-Harness。 -->

- 最后更新: 2026-10-16
- 当前阶段: 本地工具安装面完成收敛——rtk、ast-grep、codegraph、serena、probe 与 codebase-memory 六个工具插件退役，受管 runtime 插件只剩 chrome-devtools-mcp、playwright-cli 与 open-code-review；codebase-memory-mcp 改为随 rules-core 分发的外部工具使用规范（只声明使用与证据核对，不安装工具、不写 MCP 配置、不管理索引），旧插件、旧模块与 hooks.rtk 经 install --upgrade 迁移且保留用户修改与索引数据；develop 可本地 no-ff 直落与直推（ADR-0013，main／master／release* 发布门禁不变）、高风险单复审者契约（ADR-0012）、gd-flow／lwflow 显式 develop flow（ADR-0015）与 vb-* 显式交付 Skill 命名继续生效，native Skill 计数 core 12／full 15、integration 4，native description 预算 2350 字符，rule–skill parity 七对；find-question 深度跨层审查 Skill 与只读审查包准备命令（vibe-harness find question 与 vb 别名）随本批交付，offline reference 于 2026-10-16 经显式授权按资产指纹提升（config 43／rules 45／skills 154 文件，capability 计数与阈值未变）；GitHub 默认分支为 develop，develop ruleset 24096092 保持 disabled、main ruleset 20501924 保持 active
- 当前重点: find-question 批次已分三组提交（3f7928a、1c520c7、f516a47）并推送到 codex/delivery-batch，记忆条目随第四组 docs(memory) 提交刷新；随后仍是 PR #34 收尾（复审、单复审者收据与合并）与下游 BL-CNAS 回灌的受管文件漂移对齐（两项沿用上一轮登记，本轮未复核）
- 下一步动作: 记忆刷新后复跑标准层并推送第四组提交；复核 PR #34 的检查与单复审者收据后合并；在 BL-CNAS 侧对齐漂移的受管文件，再重跑 install --upgrade --write 与 validate 并补 hook 干跑；如需 find-question 能力主张，先补同条件新旧对比；再安排 develop → main 提升、backup/governance-audit-batch 等历史引用清理与 nightly H01–H20 模型背书回归
- 恢复提示: 恢复唯一入口是 .agents/memory/CURRENT.md；本文件是被它引用的治理状态源；工具退役批次的状态锚点为 .vibe-harness/tasks/tool-retirement.json（stage=verify，风险档 full），find-question 批次未建立项目级状态锚点，其证据为提交历史与 docs/audits.md 的来源与效果验证节。上一轮 P0–P2 架构审查批次的处置状态见 docs/inventory/harness-superpowers-comparison.md 的「处置状态（2026-09-14）」，未关闭项见 docs/memory/TECH_DEBT.md 的技术债清单；2026-09-22 优化范围见 audit-reports/2026-09-22-optimization-plan.md
