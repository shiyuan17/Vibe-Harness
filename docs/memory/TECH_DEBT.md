# 技术债

记录未关闭技术债，包含 ID、证据、影响、owner 和关闭条件。

<!-- 渲染说明：此模板含 render 占位符，安装时由 template-renderer 输出，内容不与 docs/memory/TECH_DEBT.md 逐字对应；实时技术债记录见 docs/memory/TECH_DEBT.md。占位符：Vibe-Harness。 -->

最后更新：2026-09-14

## TD-2026-09-02-1 `.githooks/` 不在运行时红区清单

- 证据：运行时红区清单包含 `.agents/runtime/hooks/**`、`vibe-harness.config.json`、`.vibe-harness/install-state.json`，但没有 `.githooks/`；`validateRedZoneConsistency` 的三向校验因此不覆盖该目录。
- 影响：安装器不写 `.githooks/`，但 Hook 引导脚本会执行其中内容；对它的写入既不受安装期 `--confirm-red-zone` 保护，也不会被一致性校验发现。
- Owner：Vibe-Harness 维护者。
- 关闭条件：确认 `.githooks/` 是否属于受管控制面；若是，加入运行时红区清单并纳入 `validateRedZoneConsistency`；若否，在规则文档记录不纳入的理由。

## TD-2026-09-11-1 三份测试以措辞断言锁定规范文本

- 证据：`tests/rules-depth.test.js`、`tests/linear-workflow.test.js`、`tests/execution-simplification.test.js` 合计约 231 处 `assert.match` 直接匹配中文规则句子（分配 81/80/70）。
- 影响：改一句规则措辞要同步改多处断言，改漏即红；断言的是措辞而非行为，容易把文案调整误判为规则回归。
- Owner：Vibe-Harness 维护者。
- 关闭条件：抽出共享措辞常量表（改一处常量加一处断言），其余转为结构性断言；保留一条权威存在性断言，不整体删除锁定。

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
