# Harness 系统审查整改记录

## 结论与范围

按原审查路线图 **P0 → P1 → P2** 推进，18 项已有源码、配置或规则变更；F12 暂缓新增缓存。**已实施整改的本地收口验证通过，批准前的 Eval 阻塞已解除**：本轮用户明确确认更新，既有 Windows 用户环境提供受保护批准，基线按正规入口备份并更新，`pnpm check` 与 Eval 复验通过。P0 的已知反例已有定向回归，但这些证据仍不能支持长期、多 Agent、真实宿主或发布边界整体可靠的主张。

原发现及严重度保留在 `audit-reports/2026-09-25-harness-system-review.md`；该报告引用的是审查时源码，下面引用整改后的实现。未提交、推送、发布或修改远端 required checks。

## 按建议顺序落实的变更

“实现”只表示引用的源码或配置存在；“规则简化”不等于 Agent 行为已被验证。

| 顺序 / 发现 | 整改及当前证据（路径:行号 + 原文片段） | 验收与边界 |
|---|---|---|
| P0-1 / F01 | `runtime/commands/run.mjs:1744`：`if (!existing)`；仅清理本次新建 Worktree，复用失败不删已有树、分支或登记项。 | 新建失败正常回滚；复用失败保留脏文件、分支及登记项。 |
| P0-1 / F02 | `scripts/lib/file-transaction.js:178`：`if (pending.length > 0)`；新事务先拒绝未恢复 journal。`scripts/lib/file-transaction.js:304`：`has no ownership lock; refusing to restore over potentially newer writes.`；无归属锁不能覆盖恢复。 | 中断后先恢复再写；已提交的新内容不被旧恢复覆盖；孤儿恢复明确拒绝。失去锁的事务仍需人工调查，不自动破坏现场。 |
| P0-2 / F03 | `runtime/commands/run.mjs:866`：`!canonicalRoot || !isInsidePath(target, root)`；最终文件路径还检查既存祖先的真实路径。 | 父目录与 junction 逃逸拒绝、无边界外写入；保留合法路径和已有 Worktree。未宣称消除全部跨进程路径竞争。 |
| P0-3 / F04 | `runtime/commands/run.mjs:3223`：`unit.verification.fingerprint !== fingerprint`；完成消费同时核对命令集合。`scripts/verification-queue.js:58`：`current.status === 'passed' ? ['stale']`。 | 真验证通过后改坏被测脚本，相同验证失败且完成拒绝；队列同状态不重跑、变更后 queued/passed 均转 stale。生产与消费端使用同一内容指纹。 |
| P0-4 / F05 | `.github/workflows/ci.yml:299` 的 `needs` 包含 `security`；`scripts/merge-gate.js:17`：`'SECURITY_RESULT'`。 | 每个已导出的 gate 分别注入 failure/cancelled，聚合均拒绝。远端 ruleset 是否启用及实际合并行为未验证。 |
| P1-1 / F06 | `runtime/commands/run.mjs:2816`：`else if (!isVerified(predecessor))`；派发还核对执行中单元的文件范围交叠，并输出 `readinessScope`。 | 未验证/过期前驱拒绝、当前有效前驱允许；重叠写入拒绝、独立节点允许。**这是范围收敛，不是全面 ready**：资源锁仍由现有 `task-dag check` 入口检查，没有给单 Agent 强加 DAG。 |
| P1-2 / F07 | `scripts/lib/hook-bootstrap.cjs:1`：`VIBE_HARNESS_PERMISSION_PRESET` 纳入环境白名单；已安装 Hook 配置同步。 | 直接与包装入口对同一只读 Write 请求均 deny，secret 仍不继承；不宣称真实宿主一定加载 Hook。 |
| P1-2 / F08 | `scripts/lib/review-audit.js:106`：`reviewers.some((item) => item?.identity === receipt?.implementer?.identity)`；并核对 context 及顶层 reviewer 与列表一致。 | 实施者混入、复用实施 context、顶层 reviewer 不在列表均拒绝；合法双 reviewer 通过。保持 shadow 策略。 |
| P1-2 / F09 | `harness-evals/verifiers/scenario.js:174`：`decoderDispatch > schemaComplete`；H16 缺专用轨迹不再通用回退通过。 | 好轨迹通过；无协作及依赖逆序均 unverified；按单元识别完成及父验证顺序。没有新增协作引擎。 |
| P1-3 / F10 | `runtime/commands/run.mjs:3585`：`const recoveryOnly`；`runtime/commands/run.mjs:3608`：`recoveryPlan = planCheck`。 | 计划漂移时 failure/blocker/nextAction 可保存且返回失败的 plan 状态；混合推进请求仍拒绝，无顺带授权。 |
| P1-3 / F11 | `runtime/commands/run.mjs:2943`：`![1, TASK_SCHEMA_VERSION].includes(anchor.schemaVersion)`；同时检查必需恢复字段。 | 完整 v1/v2 可只读恢复；残缺 v1/v2、完整但未知版本拒绝；不静默重建。 |
| P2-1 / F13 | `scripts/lib/micro-runner.js:84`：`captureSnapshotAfter ? await captureSnapshotAfter() : null`；后快照在共同 runner 中参与最终判定。 | 源公开入口与安装运行时对同一 probe 均 passed/match；Micro 仍不替代正式层证据。 |
| P2-1 / F16 | `scripts/verify-focused.js:189`：`project baseline command(s) selected`；运行时另报告实际执行的基线命令数。 | 空差异输出不再声称没有验证；保留合法基线，不用短路删除必要检查。 |
| P2-1 / F17 | `runtime/commands/run.mjs:3578`：`only supported by task init`。 | update 明确拒绝 title/goal/risk-level/acceptance；原目标不变，不再无操作假成功。 |
| P2-2 / F14 | `scripts/lib/role-projection.js:604`：`native-sandbox-coarse-role-permission-unverified`。 | 原生 sandbox 与精确角色限制分开表述；投影测试通过，不新增权限引擎。 |
| P2-2 / F15 | `docs/rules/ai-collab-rules.md:79`：`仅派发实际声明或使用端口/容器的 write 节点时`、`无关节点不创建空登记表`。 | **规则简化**；资产守护断言同步。未测量实际 Agent 是否减少无关检查。 |
| P2-2 / F18 | `scripts/lib/memory-audit.js:132`：`scope: 'root-md-json-files', referenceScope: 'file-level'`；列出实际跳过的子目录。 | Session/archive 未覆盖明确报 warning；多验证日期取最旧日期并告警，顺序不改变结论。没有扩张为整库或语义审计，测试只用合成 Memory。 |
| P2-2 / F19 | `docs/rules/api-rules.md:30`：``用户可见提示断言项目 `language` 或既有 i18n 契约的文案``。 | **规则简化**；删除无条件中文断言，保留项目语言合同。未执行在线多语言 Agent Eval。 |
| P2-3 / F12 | **延后**：未建立足以证明缓存净收益的真实长期重复成本数据。 | 先一次选对所需层；有代表性重复命令/耗时证据后再考虑单检查差集。没有新增缓存服务、常驻 Agent、状态文件或默认门禁。 |

## 批准前验证记录

以下日志位于本地忽略目录，不是永久签名收据；数字是对应运行的测试数，不把重跑计作新增覆盖。

| 检查 | 本轮结果 | 日志 / 说明 |
|---|---|---|
| `pnpm check:fast` | passed；单元 167/167 | `.vibe-harness/remediation-fast-final.log`；含静态扫描、typecheck、单元测试。 |
| 14 个受影响测试文件的定向运行 | passed；193/193 | `.vibe-harness/remediation-focused-final.log`；覆盖 P0 负控、权限、H16、恢复、角色、Micro、安装画像及空差异输出。 |
| 最后一次 Memory 修改后的重验 | passed；10/10 | `.vibe-harness/remediation-memory-final.log`；是前述集合的重跑，不另计 10 个覆盖。 |
| `pnpm test:integration` | 初轮 563 passed / 2 failed / 1 skipped；续跑 565 passed / 0 failed / 1 skipped | 初轮 `.vibe-harness/remediation-integration.log`；两个失败源于自安装误渲染通用规则模板。模板恢复后，本次续跑完整 566 项集合，无失败；仍跳过真实 Codex runner smoke，详见下方续跑记录。 |
| `pnpm check` | failed；单元 167/167，组件 322/327 | `.vibe-harness/remediation-check-gate.log`；剩余五个组件失败均绑定旧 Eval reference/行为产物。ESLint 0 errors / 197 warnings；不把 warning 说成零。 |
| `pnpm roles:audit` | passed；0 errors / 0 warnings | 本轮命令输出；没有派发额外审查 Agent。 |
| `pnpm tests:catalog check` | passed；1198 ledger / 1198 declared | 用例名改为中文，补齐新增用例及 transitive covers。最终受管检查也核对 clean。 |
| `git diff --check` | passed | 本轮命令输出；LF 归一化提示不是空白错误。 |

## 批准前收口检查

- 最后一次运行时及 Memory 修改后的 `pnpm smoke:lifecycle`：**passed，10/10 步**；`.vibe-harness/remediation-smoke-final.log`。覆盖 core/full 的安装、dry-run、validate、doctor 及已安装 Eval 入口，不替代宿主行为验证。
- `pnpm docs:audit`：**passed，134 份受管文档**；`.vibe-harness/remediation-docs-final.log`。新增审计记录位于受管产品文档树之外，报告行号另行机械核对。
- `pnpm eval:check`：**failed**；`.vibe-harness/remediation-eval-final.log`。仅报 aggregate/rules 的 reference 与 behavioral 指纹漂移，没有修改批准标记、reference、镜像或签入运行产物。
- 未运行整套 E2E/matrix、线上模型 Eval、远端 CI 或真实长期多 Agent 试验；这些层保持 unverified。

## 验证中修正的问题

- 恢复已有改动后发现 queue 的生产端使用“路径列表哈希”，消费端使用“内容哈希”；已统一到现有运行时内容指纹，并增加真实 CLI 入队→消费→失效的组合测试。
- 旧 land fixture 是只有 taskId/units 的残缺 v1；已改为完整锚点，不削弱恢复校验，同时保留合法 v1 兼容。
- 自安装把通用 `docs/rules/project-specific-rules.md` 的占位符渲染为本仓库信息，造成两项组件和两项画像测试失败；已恢复源模板，未改模板消费者断言换取通过。
- 新增恢复测试漏台账，队列组合测试新增 import 后 covers 漂移；已登记并重验，没有关闭台账门。

## 批准前剩余条件（历史）

1. **Eval 批准缺口**：实际指纹比较只有 `rules` 组变化，config/hooks/skills 不变。当前 rules hash 为 `4b3cad3dfc6b41323c162f5b08e3aaf5ac764564eb998a8b5b4ef98a33dbaad9`。`CONTRIBUTING.md:103` 要求“reference 更新必须单独审查并显式确认，不得为让变更通过而自动提升”；本轮没有伪造受保护批准。
2. 获得正规批准后，按贡献指南的 run → reference（备份、force、confirm）→ sync → replay → behavioral 流程更新，然后重跑 `pnpm eval:check`、`pnpm eval:replay` 和失败的组件门。不能只更新 fingerprint 或降低旧产物断言。
3. F06 的资源锁审计、F12 的代表性成本测量、真实宿主加载/压缩恢复/长期并发及远端 CI 仍是明确边界；本轮不以更多规则、角色或常驻调度器掩盖这些未验证项。

状态锚点：`.vibe-harness/tasks/harness-remediation-20260926.json`。它保存进度与批准阻塞，不授权后续写入或替代验证。

## 2026-09-26 续跑记录

本次只补齐此前未重跑的集成层并复核阻塞；未新增功能代码、规则、角色、缓存或门禁，未修改 Eval reference、镜像和签入运行产物。

- **集成层已执行且无失败**：`pnpm test:integration` 退出码 0；`.vibe-harness/remediation-integration-resume.log:573`：`ℹ pass 565`，`.vibe-harness/remediation-integration-resume.log:574`：`ℹ fail 0`，`.vibe-harness/remediation-integration-resume.log:576`：`ℹ skipped 1`，共 566 项，耗时约 592 秒。该结果补齐整层重验，不把跳过项算作通过。
- **真实宿主证据仍缺失**：`.vibe-harness/remediation-integration-resume.log:112`：`real Codex runner smoke is opt-in and returns the provider-neutral contract (0.2551ms) # SKIP`。未启动真实 runner，不能据此声称真实宿主或长期多 Agent 行为已验证。
- **Eval 门仍失败**：`pnpm eval:check` 退出码 1；`.vibe-harness/remediation-eval-resume.log:8`：`asset fingerprint drift for assets.groups.rules.hash`，`.vibe-harness/remediation-eval-resume.log:10`：`asset fingerprint drift for assets.groups.rules.hash (behavioral run)`。分组比较再次确认 config/hooks/skills 未漂移，rules hash 与上轮一致；aggregate 漂移是分组变化对应的汇总结果。
- **批准门未绕过**：当前进程未提供 `VIBE_HARNESS_PROTECTED_APPROVAL=1`。`docs/evals.md:33`：“写入必须同时满足 `--confirm-reference-update` 与宿主注入的 `VIBE_HARNESS_PROTECTED_APPROVAL=1`”。因此仍等待单独审查、显式确认和可信宿主批准，不能将“继续”代替宿主证明，也不由 Agent 自行注入标记。
- **成本与现场保护**：没有重跑已有通过证据且未改动的快速层、生命周期、E2E 或 matrix；续跑前后 Git 变更路径一致。codebase-memory 状态为 `unavailable` / `runtime-not-installed`，本次沿用 CodeGraph 和已保存报告，不重新全量探索。

当次续跑的结论是：**整改实现与本地集成层已有证据，但整体整改验收尚未通过**。当时仍待批准后沿现有 run → reference → sync → replay → behavioral 入口再生产物并复验 Eval 与受影响组件；本轮处理见下节，F12 与其他未验证边界不变。

## 2026-09-26 批准后收口

### 批准范围与实际写入

- 用户本轮明确要求继续；只读确认 Windows `User` 环境中的 `VIBE_HARNESS_PROTECTED_APPROVAL` 已为 `1`，当前 Codex `Process` 尚未继承。受保护的 reference 子进程仅转传该既有宿主值，没有自行生成批准值或改写用户/系统环境。
- 单独复核两处规则 diff：端口/容器登记表只约束实际使用这些资源的节点；用户提示断言遵循项目语言或已有 i18n 契约。资产漂移仍仅 rules 与对应 aggregate，config/hooks/skills 不变，没有修改 suite、oracle、评分或门槛。
- 完整执行 run → reference（`--write --confirm-reference-update --force`）→ sync → replay → behavioral。首次 run 的 wrapper 因旧 reference 指纹不匹配返回 degraded / exit 2，但其 40 个 case 全部 passed；仅在核对诊断无其他失败后提升，随后所有只读复验通过。
- 实际仅新增四个受管资产变更：`evals/references/vibe-harness-core.offline.json`、`.agents/evals/references/vibe-harness-core.offline.json`、`evals/results/vibe-harness-core.offline.json`、`evals/results/vibe-harness-behavioral.stub.json`。reference 只变批准时间与两个哈希；运行产物只变两个哈希。
- 三份旧资产已备份，机械核对均与 HEAD 旧版本一致：`.vibe-harness/remediation-approved-asset-diff.json:22`、`.vibe-harness/remediation-approved-asset-diff.json:26`、`.vibe-harness/remediation-approved-asset-diff.json:30` 均为 `"matchesHead": true`。备份目录分别为 `.vibe-harness/backups/2026-09-26T08-39-21-319Z/`、`.vibe-harness/backups/2026-09-26T08-39-49-213Z/`、`.vibe-harness/backups/2026-09-26T08-39-50-152Z/`。

### 最终验证

| 检查 | 结果与原文证据 |
|---|---|
| `pnpm check` | passed；`.vibe-harness/remediation-approved-check.log:614`：`ℹ pass 167`，`.vibe-harness/remediation-approved-check.log:953`：`ℹ pass 327`。此前五个组件失败已消除，单元与组件均无失败或跳过。 |
| ESLint / 测试台账 | `.vibe-harness/remediation-approved-check.log:380`：`196 problems (0 errors, 196 warnings)`；`.vibe-harness/remediation-approved-check.log:389`：`1198 ledger case(s), 1198 declared case(s), 0 observed case(s), clean`。不将 warning 报成零；这里台账为声明核对，不冒充 1198 项全量执行。 |
| `pnpm eval:check` | passed；`.vibe-harness/remediation-approved-eval-check.log:5`：`Vibe-Harness evaluation contracts passed.` |
| `pnpm eval:replay` | passed；`.vibe-harness/remediation-approved-replay-check.log:5`：`Vibe-Harness deterministic replay passed.`；40 cases 的内容与评分未改变，`.vibe-harness/remediation-approved-asset-diff.json:9`：`"casesUnchanged": true`。 |
| `pnpm eval:behavioral` | passed；`.vibe-harness/remediation-approved-behavioral-check.log:5`：`Vibe-Harness behavioral run artifact is current.`；6 个运行时场景已重新执行，内容与评分未改变，`.vibe-harness/remediation-approved-asset-diff.json:17`：`"casesUnchanged": true`。 |
| `pnpm eval:sync` | passed；`.vibe-harness/remediation-approved-sync-check.log:7`：`drift: 0`。 |
| Eval 消费者定向集成 | passed；运行 `tests/integration/eval-cli.test.js` 与 `tests/integration/project-evaluation.test.js`，`.vibe-harness/remediation-approved-eval-integration.log:21`：`ℹ pass 18`，无失败或跳过。 |

批准后的最后一次资产写入晚于上一节整层集成测试；因此本节用匹配四个资产变更的组件、Eval 和 18 项定向集成证据收口，不将批准前的 565 项结果改写成最终工作树的整层复验，也不重复十分钟的整套集成。

**收口边界**：已实施整改的本地验收已通过；F12 仍因缺少代表性重复成本数据而延后。真实宿主、在线多轮、长期并发、E2E/matrix、远端 CI 与发布仍未验证。未提交、推送、发布，也未调整远端 required checks；本地批准标记不构成上述未授权动作的许可。
