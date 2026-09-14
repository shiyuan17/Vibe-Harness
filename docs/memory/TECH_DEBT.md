# 技术债

记录未关闭技术债，包含 ID、证据、影响、owner 和关闭条件。

<!-- 渲染说明：此模板含 render 占位符，安装时由 template-renderer 输出，内容不与 docs/memory/TECH_DEBT.md 逐字对应；实时技术债记录见 docs/memory/TECH_DEBT.md。占位符：Vibe-Harness。 -->

最后更新：2026-09-14

## TD-2026-09-02-1 `.githooks/` 不在运行时红区清单

- 证据：运行时红区清单包含 `.agents/runtime/hooks/**`、`vibe-harness.config.json`、`.vibe-harness/install-state.json`，但没有 `.githooks/`；`validateRedZoneConsistency` 的三向校验因此不覆盖该目录。
- 影响：安装器不写 `.githooks/`，但 Hook 引导脚本会执行其中内容；对它的写入既不受安装期 `--confirm-red-zone` 保护，也不会被一致性校验发现。
- Owner：Vibe-Harness 维护者。
- 关闭条件：确认 `.githooks/` 是否属于受管控制面；若是，加入运行时红区清单并纳入 `validateRedZoneConsistency`；若否，在规则文档记录不纳入的理由。

## TD-2026-09-11-2 Eval 资产指纹分组不覆盖 adapters

- 证据：`scripts/lib/eval-assets.js` 的 `ASSET_GROUPS` 只含 config、hooks、rules、skills；`adapters/claude/CLAUDE.template.md` 与 `adapters/gemini/GEMINI.template.md` 的启动序列漂移（审查项 4f）不会触发 reference 审查，只有 Harness Evals 的 harness 哈希覆盖 `adapters/`。
- 影响：把规则投递给非 Codex 宿主的模板可以静默漂移，而 offline reference 仍显示 matched。
- Owner：Vibe-Harness 维护者。
- 关闭条件：把 `adapters/` 或其中的指令模板纳入某个分组并同步再生成 reference，或给出显式不纳入的理由。

## TD-2026-09-11-3 CLI 文案中英混用

- 证据：`scripts/vibe-harness.js` 的 `optionalToolFallback()` 已中文化，但同一 `toolRecommendations()` 的 `unsupported` 分支仍是英文；`runtime/hooks/lib/rtk.mjs` 与 `scripts/lib/tool-provisioning/runtime-probe.js` 的诊断文案也未中文化。
- 影响：同一条命令的降级建议会随平台与状态在中英文之间跳变，外部消费者无法按语言解析，测试只能退化为结构化断言。
- Owner：Vibe-Harness 维护者。
- 关闭条件：确定 CLI 文案语言契约并统一（或明确保留双语并记录判定），同步 `tests/tooling-modules.test.js` 等断言口径。

## TD-2026-09-11-4 `stub-behavioral` proof 没有生产者

- 证据：`docs/evals.md` 已把 `stub-behavioral` 标为无生产者、保留的合同位、属未实现计划；仓库内只有 `buildOfflineRun()`（contract-replay）与 online、project evaluation（online-canary）两条生产者路径，schema `proof` 枚举保留该取值以读取历史资产。
- 影响：规则、Skill、Hook 的行为变更在 online canary 之外没有低成本回归层，资产敏感度只能由 Harness Evals 的 RED 阶段承担。
- Owner：Vibe-Harness 维护者。
- 关闭条件：实现最小 `stub-behavioral` 生产路径（复用现有 runner、fixture、observer、allowedWritePaths 与 scoring），或正式确认由 Harness Evals RED 阶段取代并同步 `docs/evals.md` 与 `docs/inventory/harness-superpowers-comparison.md` 的 R-03 状态。

## TD-2026-09-14-1 改进候选队列为空，且 CHANGELOG 的记忆种子化主张无对应资产

- 证据：HEAD 的 CHANGELOG「治理记忆种子化（P2-7）」称 docs/memory/PROJECT_STATE.md 与 docs/memory/IMPROVEMENTS.json 已填入真实状态，但两者在 HEAD 中仍是空模板（PROJECT_STATE 各字段为空、IMPROVEMENTS 的 updatedAt 为 1970-01-01 且 candidates 为空）；2026-09-14 已补齐 PROJECT_STATE.md 与 .agents/memory/CURRENT.md，IMPROVEMENTS.json 仍为空队列。
- 影响：AGENTS.md 启动第 2 步的记忆恢复此前只能读到空模板，等于没有可恢复状态；同时说明「已落地」类完成主张缺少资产可核对环节。
- Owner：Vibe-Harness 维护者。
- 关闭条件：由真实 review 或 verification receipt 经 mergeImprovementCandidates 生成候选并写入 docs/memory/IMPROVEMENTS.json（候选 ID 由 type:code:targetAsset 摘要派生，不得手工伪造）；并在 CONTRIBUTING 的完成清单加入「CHANGELOG 主张的资产必须在本仓库可核对」。

## TD-2026-09-14-2 真实压缩用例依赖首轮上下文规模，宿主压缩不可控时会空转

- 证据：宿主压缩阈值比对 Codex 客户端自己的 `token_count` 常驻量（本机约 9–10 K），不是 provider 回报的 `input_tokens`（同轮约 34–38 K）；压实后常驻量回落到约 6–7 K，而模型每轮读取会再增长约 2–3 K。因此当 fixture 首轮上下文偏小时，「低于续跑携带量」与「高于压实后常驻量」的区间会收窄到几百 token，压缩会在每一两轮重复触发。实测记录：`EVAL-EXEC-COMPACT-001` 在首轮只读一份短计划文件时，出现过 56 条真实压缩记录、>15 分钟仍无写入的活锁（`EVAL_RUNNER_TIMEOUT`）；把 plan of record 扩写为需要通读的完整 runbook（约 5 KB）后，同一宿主稳定得到 `records=1`、隐藏测试通过、HEAD 不变。
- 影响：该用例的正确性建立在「宿主能把压缩限制在恢复边界附近」这一前提上；模型若只读计划文件的一部分、或 provider 的 token 记账口径变化，用例可能退化为长时间空转，占用 case 预算并从 degraded 路径污染同批 suite（execution suite 并发为 1，degraded 会停止调度后续 case）。
- Owner：Vibe-Harness 维护者。
- 关闭条件：把压缩阶段改为受显式预算约束（例如给压缩续跑单独设置轮次或墙钟上限、超出即判定为 capability-gated 而不是等待 case 超时），或把该 case 迁出默认 execution suite 进入需显式选择运行的压缩专用 suite。
