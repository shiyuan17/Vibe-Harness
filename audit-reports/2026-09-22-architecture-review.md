# Vibe-Harness 架构审查报告（第一性原理 × 8 视角）

审查日期：2026-09-22（Asia/Shanghai）

源码基线：codex/governance-audit-batch 分支（领先 main 5 个提交：dcdc090…1c811ff），审查时工作区仅 .zcodeignore 未跟踪。

执行判定：本轮只交付报告与整改计划（另见 audit-reports/2026-09-22-optimization-plan.md），未修改任何源文件。

审查方法：第一性原理逐项质询（解决什么问题 / 为什么需要 / 删除会怎样 / 更简方案 / Agent 能否理解 / 可否验证）× 8 个独立视角（架构、工作流、规则、效率、可靠性、验证、上下文、对抗），交叉质疑后只保留有物理证据的结论。取证以直接文件阅读与 rg 为主，佐以 3 个只读 Explore 子代理；其中 4 个审查子代理因用量配额失败（2026-09-22 17:21 前），由主代理亲自补齐对应视角——这本身构成一条多代理扇出可靠性的实证数据点。

格式约定：所有行号为审查时点快照，后续提交可能使行号漂移；结论均给出文件级定位以便复核。

## 1. 结论先行

核心问题：**Harness 能否以最小必要成本稳定支撑从简单变更到大型长周期多代理项目的持续开发？**

回答：**能，但当前约付 40% 的流程溢价，且溢价的绝大部分来自一处可修的结构问题（治理内核全文阅读税），而非分布式浪费。** 简单变更被按"默认重流程"对待：启动强制通读 governance-core.md 全文（110 行）、锚点与分层验证对 10 分钟级任务构成仪式成本。与之对照，大型长周期任务侧（任务锚点、分层验证、worktree 隔离、独立评审收据）是净收益设计。

三个结构性问题（详见第 11 节收敛清单）：

1. **哑铃型执行结构**——入口（110 行治理内核全文）与出口（2984 行 run.mjs 单体）都很重，中段（日常编码）却很轻；成本压在两端。
2. **解释器间接写缺口（P0）**——Hook write gate 只采集重定向与 cp/mv/rm/tee/truncate 操作数，node -e / python -c / sed -i 的写目标不进入候选路径，红区文件可被间接写入。
3. **元系统失衡**——给"元系统"（规则、流程、台账）加的约束比给产品代码加的还多；每条新规则都在向所有任务收税。

七项核心优势（交叉质疑后确认保留）：验证分类器单一真值源（vibe-harness.config.json validationCommands + change-impact/verification-plan 共用分类器）；fail-closed Hook 三层预算（5s/8s/10s）加只读快速路径；read-only-commands.mjs 单源（策略层与 Envelope 共用，消除 AC-01/02/04 类漂移）；测试台账（tests/cases.json 1112 用例，新增用例必须 catalog sync，防测试静默丢失）；任务锚点幂等签名（anchorSignature 排除 updatedAt/sessions）；worktree 生命周期自带未落地分支保护（cleanup 拒绝未合并分支）；独立评审收据 shadow 模式（从不阻塞，零风险引入）。

## 2. 成本模型（回答"最小必要成本"）

按任务档位拆解实际流程成本（证据：docs/rules/governance-core.md 全文；AGENTS.md 受管块；run.mjs task/verify 实现）：

| 档位 | 必要成本 | 当前额外成本 | 主要来源 |
| --- | --- | --- | --- |
| 快速（单文件/配置/日志，10 分钟级） | 读命中规则片段 + 聚焦验证 | 通读治理内核 110 行 + 启动行加载 | governance-core 无 Fast Path 分层 |
| 轻量（2-3 文件） | 同上 + 命中专项规则 | 中等 | 同上 |
| 完整（跨模块/架构/发布） | 全文 + 锚点 + 分层验证 | 接近零 | —— |

结论：溢价的 ~70% 集中在快速档（占比最高的任务类型），修复手段是单点的（Fast Path 卡片 + 启动行分层加载），不需要动整体架构。这与"不为完善而增加更多规则"的原则一致：删成本而非加机制。

## 3. 架构视角

**已确认事实**：

- 双 CLI 面分裂：scripts/vibe-harness.js（开发/安装/校验）与 runtime/commands/run.mjs（安装后，2984 行）并存，命令语义有重叠（verify 两套引擎以 engine 字段区分）。风险是中等而非紧急——两套各有明确职责边界（AGENTS.md「命令面边界」节），但 run.mjs 单体已到拆分阈值（task 实现独占 :2090-2580 约 500 行）。
- 投影链（模板渲染 → 受管块合并 → 安装态记录）是自洽的：template-renderer.js renderTemplate/buildStartupLines/mergeManagedInstructionBlock 职责清晰，VIBE_HARNESS:START/END 标记使重渲染幂等。
- 自举（dogfood）带来的特例：docs/rules/governance-core.md 源==目标（自引用），runtime/hooks/lib/policy.mjs 源≠安装副本——源码编辑后必须 install --write --confirm-red-zone 刷新，且该刷新本身是红区操作。这条链路没有文档化提醒（缺陷，入收敛清单 P2）。

**第一性质询**：治理内核为什么是 110 行全文而不是卡片？回答不出"为什么必须全文"——分层阅读不损失任何语义，只损失"假装读过"的仪式保证。判定：可压缩。

## 4. 工作流视角

**已确认事实**：

- 任务锚点（run.mjs task）：schemaVersion/taskId/stage(r枚举)/riskLevel/goal/acceptance/units/decisions/blockers/nextAction/sessions/updatedAt；锚点存 .vibe-harness/tasks/，而 .gitignore 忽略整个 .vibe-harness/ ——锚点不进版本库，CI 无法检查锚点新鲜度（设计权衡：锚点是本机工作状态，非交付物；但"压缩后必须先更新锚点"的纪律只剩本地自觉）。
- 记忆恢复：.agents/memory/CURRENT.md 唯一入口（8 字段契约 + 锚点提交 HEAD 祖先绑定），治理真值引用 docs/memory/PROJECT_STATE.md。validateMemoryEntry 校验格式与祖先关系，但**没有新鲜度检查**——实测：CURRENT.md 最后更新 2026-09-19，HEAD 提交已到 09-20，记忆滞后于仓库状态且无任何机制报警（缺陷，入清单 P1 #3）。
- worktree 子命令族（list/check/bootstrap/cleanup/recover）完整覆盖"新分支开发→合并→清理"生命周期，且 cleanup 拒绝删除未落地分支（run.mjs:694 注释明示）——这是本项目少有的"自动化>人工约束"典范实现。

## 5. 规则视角

**已确认事实**：

- docs/rules/ 41 个规则文件 + 角色索引 + 表达模式。governance-core.md 是强制入口（AGENTS.md 受管块启动行第 1 条）。
- 硬边界的授权规则、红区与证据标准设计良好（本地规则只能收紧不能放宽的优先级矩阵明确）。
- 问题不在规则内容而在**加载策略**：入口规则以"全文阅读"方式生效，没有"快速档只读卡片"的分层。对比：专项规则已经是按需加载（"只有出现 Skill 或专项领域信号时再读取"），证明分层加载在本项目已有先例且可行。

**第一性质询**：规则的可执行性（可验证断言）vs 描述性（期望陈述）比例——governance-core 大部分条款是可执行的（有对应 runtime 命令或检查器），少数纯描述性条款（如协作姿态）没有机械判定。判定：内容合格，入口方式待优化。

## 6. 效率视角

**已确认事实**：

- **skills:audit 在 CI 跑 3 次**：ci.yml:149-150（fast-gate 条件步骤）+ ci.yml:218（supply-chain 无条件步骤）+ scripts/lib/lint.js:11（内嵌于 check:fast/check:full）。第 1、2 次与第 3 次在不同 job 重复执行同一扫描，纯冗余（缺陷，入清单 P1 #7）。
- evals.yml：3 处 continue-on-error（:64/:74/:82）+ 21-run artifact 逐一下载（:96-106）；retention 已是 30 天（可接受，暂不动）。
- 快速层（lint/typecheck/unit）与 check:fast 同一定义（check-fast-tier-alignment.test.js 有契约测试锁定）——单一真值源在此处是真实成立的。

## 7. 可靠性视角

**已确认事实**：

- Hook 覆盖矩阵不完整：manifests/adapters.json 中 gemini(:47)/opencode(:138) 声明 hookActivation: unsupported；runtime-diagnostics.js 的 HOOK_ENFORCEMENT_UNVERIFIED 警告是通用的，不按宿主归因——用户安装 gemini 目标后不会被告知"该宿主 hook 机制不被支持，仅安装文件不激活"（缺陷，入清单 P1 #5）。
- codex-hook.mjs hostFromArgs 白名单(:59-65)含 codex/cursor/qoder/zcode/antigravity/claude，不含 gemini/opencode——与上一条同根。
- fail-closed 预算设计（3 层 5s/8s/10s）与只读快速路径(:125-127)实测有效（本审查期间未触发误拒）。
- 多代理扇出可靠性：4/8 子代理配额失败（实证数据点）——工作流设计不应假设扇出必然成功，需要主代理兜底路径。本项目当前不依赖多代理扇出（AGENTS.md 明示"不要自动派发 Review/Test 角色"），与该实证一致。

## 8. 验证视角

**已确认事实**：

- 独立评审收据（scripts/independent-review.js）shadow 模式永不阻塞（:22 默认、:41 判定），设计正确；但**零遥测**——shadow 收集了什么、degraded 率多少、离切换 required 还差什么，没有任何可观测输出（缺陷，入清单 P1 #2）。shadow 模式若永远不可观测，就永远无法毕业。
- verification-plan.js：unknown 路径强制 high → 全矩阵回退（:166）。安全但昂贵；且仓库根 dotfile（如 .zcodeignore）完全无规则覆盖 → 落 unknown → high → 全矩阵（缺陷，入清单 P1 #8；.zcodeignore 内容已核验为标准宿主忽略清单，入库即可消除）。
- 测试台账机制（1112 用例 + sync 强制）是本项目最强的防回归资产。

## 9. 上下文视角

**已确认事实**：

- 启动链：AGENTS.md 受管块 → governance-core.md 全文 → 按需专项规则。第一次上下文压缩前，治理文本占用的 token 是固定税。
- 表达模式（response-modes）按任务类型自动选择——这是已有的"输出粒度分层"先例，与 Fast Path 卡片的"输入粒度分层"同构，进一步证明分层可行。
- 上下文压力实测：本审查两轮压缩后仍能凭锚点+记忆+报告结构恢复工作——恢复机制本身有效（这是任务锚点设计的正证据）。

## 10. 对抗视角

**P0 缺陷（已确认，可复现路径）**：

- write gate（policy.mjs:378-379）判定 `!writeToolPattern.test(toolName) && shellTargets.length === 0 → return null`；shellWritePaths(:231-246) 只采集重定向目标 + cp/mv/rm/tee/truncate 操作数。
- 因此 `node -e "require('fs').writeFileSync('.env','x')"` 不产生任何 shellTargets → 整个写路径判定链（CONTROL_PLANE_WRITE :385 / PROJECT_BOUNDARY :394 / RED_ZONE :412）被跳过 → **红区文件可经解释器内联代码间接写入**。同理 python -c、perl -e、sed -i（sed 在 SIMPLE_READ_ONLY_COMMANDS 中，-i 时仅被参数守卫撤销"只读"结论，但其写目标仍不进候选）。
- 边界已核实：GLOBAL_AGENT_CONFIG 检查(:347-353)不受影响（node 永不为只读，命中全局配置段即拒）；UNSAFE_SHELL_CONSTRUCT 拒 $() 与反引号，但解释器字符串内的路径不构成命令替换。缺口精确定位于：红区非全局路径 + 项目外写入。
- 修复方案见计划批次 A：interpreterWriteTargets 提取解释器写目标并入候选路径；read-only 角色预设下解释器内联代码直接拒。

**其余对抗面**：DESTRUCTIVE_GIT 覆盖 git restore（:208）；凭据外传双检查（网络命令 × 秘密引用、私网出口 × 红区上传路径）；NETWORK 允许列表无目标即拒（fail-closed 方向正确）。

## 11. 交叉质疑与收敛清单

交叉质疑淘汰的候选结论（保留记录）：「codex-hook.mjs:141 存在配置灭活开关」——经查 context.mjs:157-177 为硬编码 guarded 模式，撤回；「skills:audit 三处等价」——第 3 处（lint.js 内嵌）与 CI 步骤语义不同层，仅前两处冗余，修正后保留。

收敛后的整改清单（编号沿用，P0×1 + P1×7 + P2×2）：

| # | 级 | 问题 | 修复要点 |
| --- | --- | --- | --- |
| 1 | P0 | 解释器间接写红区绕过 | policy.mjs 增 interpreterWriteTargets 并入 write gate；read-only 预设拒内联代码 |
| 2 | P1 | 独立评审零遥测 | GITHUB_STEP_SUMMARY 输出 + shadow→required 切换标准文档化 |
| 3 | P1 | 记忆新鲜度无检查 | memoryFreshnessViolations helper + 组件测试（1 天宽限） |
| 4 | P1 | 治理内核全文阅读税 | Fast Path 卡片 + 启动行分层加载 |
| 5 | P1 | Hook 覆盖矩阵未按宿主归因 | HOOK_ACTIVATION_UNSUPPORTED 警告码 + 矩阵断言 + 文档 |
| 6 | P1 | 锚点无失败登记 | failures[] 字段 + --failure 参数 + resumeHint 透出 |
| 7 | P1 | skills:audit CI 冗余 | 删 ci.yml 两处步骤，保留 lint.js 内嵌 |
| 8 | P1 | 根 dotfile 落 unknown→high 全矩阵 | GROUP_RULES/HIGH_PATHS 补齐 + 根文件静态测试 |
| 9 | P2 | eval 体系收敛、run.mjs 拆分、envelope v1 退役 | 大重构，独立规划 |
| 10 | P2 | 验证口径三处不一致、troubleshooting 缺错误码索引等 | 文档级小项，随 P2 批次 |

## 12. 优先级判定依据与最终原则复核

- P0 唯一标准：存在已确认的、可复现的安全绕过路径。本轮仅 #1 满足。
- P1 标准：防回归价值高且改动面可收敛在一个批次内（单文件或单主题），不需要架构变更。
- P2 标准：改动面跨模块或需要单独设计评审；强行并入本轮会违反"低成本>仪式化流程"。

最终原则复核：本方案净删除 2 个 CI 步骤、压缩强制阅读面、零新增规则文件——满足"简单>复杂、可执行>完整描述、证据>推测、自动化>人工约束、低成本>仪式化流程、按需升级>默认重流程，不为完善而增加更多规则"。
