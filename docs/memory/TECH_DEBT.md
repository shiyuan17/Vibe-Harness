# 技术债

记录未关闭技术债，包含 ID、证据、影响、owner 和关闭条件。

<!-- 渲染说明：此模板含 render 占位符，安装时由 template-renderer 输出，内容不与 docs/memory/TECH_DEBT.md 逐字对应；实时技术债记录见 docs/memory/TECH_DEBT.md。占位符：Vibe-Harness。 -->

最后更新：2026-09-19

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

## TD-2026-09-11-4 `stub-behavioral` proof 没有生产者（2026-09-18 已关闭）

2026-09-18 架构审查批次 P1-3 按「实现最小生产路径」选项关闭该条目：`stub-behavioral` 不再是无生产者的合同位。

- 关闭证据：新增套件 `evals/suites/vibe-harness-behavioral.json`（6 个确定性场景：红区默认底线拒绝、项目红区扩展拒绝、宿主权限预设优先于项目配置的优先级让渡、放行控制、聚焦验证 blocked/failed 语义×2）与 runner `scripts/lib/eval-behavioral.js`：在一次性 mkdtemp 沙箱中执行真实运行时组件（`runtime/hooks/codex-hook.mjs` 的 `evaluateHook` 与 `scripts/lib/project-verification.js` 的 `runFocusedProjectVerification`），复用既有 `scoreCase` 评分与 eval-run schema v2，不调用模型、不做变异。产物 `evals/results/vibe-harness-behavioral.stub.json` 由 `pnpm eval:behavioral --write` 显式再生成（默认只读、先备份旧文件、运行失败不写产物），内嵌 suite hash 与资产指纹；`scripts/eval-check.js` 校验 proof/mode 耦合、suite id/version/hash、case 一一对应、状态-得分一致，并按资产指纹做 hash-only 漂移复核（带 `(behavioral run)` 后缀与专属 nextAction）。负控见 `tests/component/eval-behavioral.test.js`（8 用例）：反转红区 oracle 必红（不能同义反复通过）、blocked/failed 命令码交换必红、漂移/备份机制锁定。该层只证明确定性运行时组件的行为合同（仓库侧证据，不进入安装投影）；模型提示遵从与多轮行为仍由 online canary 承担，资产敏感度另由 Harness Evals RED 阶段交叉覆盖。场景集取 2026-09-18 架构审查综合 P1-3 的核心集，未采用 2026-09-05 对比报告建议的 clarify-requirements/systematic-debugging/task split 拆分（已在 R-03 行标注差异）；`docs/evals.md`、`docs/rules/eval-driven-development.md` 与 `docs/inventory/harness-superpowers-comparison.md` 的 F-04/R-03 状态已同步。
- Owner：Vibe-Harness 维护者。

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

## TD-2026-09-15-1 负载敏感集成测试的 retry 标记缺少可核对的追踪条目

- 证据：`tests/tool-provisioning.test.js` 的 `MCP browser probe invokes list_pages after tool discovery` 与 `full write degrades unavailable tools and rollback removes only the managed MCP block` 带 `{ retry: 2 }`，原注释引用 TD-2026-09-01-2；该 ID 在 docs/memory/TECH_DEBT.md 中没有对应条目，此前只出现在 audit-reports/2026-09-02-focused-verification-workflow-review.md。docs/rules/test-rules.md 现要求隔离项绑定可核对的技术债 ID、owner 和关闭条件。
- 影响：负载敏感用例的重试标记可能长期存在而没有到期判据，与「flaky 测试须隔离并限期修复，不以重跑掩盖」的规则口径无法核对，重试也随之变成隐性豁免。
- Owner：Vibe-Harness 维护者。
- 关闭条件：连续 10 次全量 `pnpm test:integration` 不再出现该类负载敏感失败后移除两处 `{ retry: 2 }`；若仍复现，改为隔离该用例或修正超时与并发假设，并保留失败证据。

## F 系列三态台账（2026-09-05 审查，2026-09-15 复核）

`audit-reports/2026-09-05-agent-capability-design-review.md` 的 F01–F10 此前没有可核对的处置记录。下表按「已修复 / 部分修复 / 未修复 / 无法判定」逐项给结论与证据；未关闭项在下方各自成条目。本轮未执行宿主实测，凡结论依赖真实宿主绑定的项目一律不给「已修复」。2026-09-16 的角色投影批次按同一表格复核 F03、F07 与 F10，并在 Codex 上补了一次真机冒烟。

| ID | 结论 | 证据 |
| --- | --- | --- |
| F01 | 已修复 | `scripts/lib/role-projection.js:52` 新增 `NATIVE_TOOLS`，Gemini 用 `read_file`/`grep_search`/`run_shell_command`、Antigravity 用 `view_file`/`grep_search`/`run_command`；`tests/role-projection.test.js:366` 断言原生名称；`pnpm roles:audit` ok（7 roles、0 errors）。 |
| F02 | 已修复（Hook 层） | `EXECUTE_PRESETS` 含 `verification`/`release-readiness`，OpenCode 投影对 test-lead 与发布角色从 `bash: "*": deny` 变为 `ask`，Codex 从 `read-only` 变为 `workspace-write`；2026-09-18 起 Hook 运行时直接执行预设三层语义（只读拒写、可执行拒直接写文件、未知 fail-closed），真实子进程负控见 TD-2026-09-15-2 关闭记录，宿主会话内注入的真机证据归 TD-2026-09-15-7。 |
| F03 | 已修复（静态） | `resolveRoleInstallEntries()` 按本次安装实际解析到的能力注入：Claude 枚举 `mcp__<server>` 并预加载 `skills`（不把 `Skill` 写进 `tools`）、ZCode 声明 `skills`（宿主自动授予 Skill 工具）、Qoder 写 `skills`/`mcpServers`、Gemini 在有 server 时追加 `mcp_*`；Codex 按官方契约继承父会话。Antigravity 维持 `configured-unverified`，见 TD-2026-09-15-3。`pnpm roles:audit` 对上述键位逐条断言并退出 0。 |
| F04 | 部分修复 | `docs/rules/role-routing.md` 选择顺序第 1 条改为先判原子动作、第 4 条明确「已明确的实现不改派只读咨询角色」；本轮未做路由 Eval 观察，不能声明稳定。 |
| F05 | 未修复 | `evals/suites/vibe-harness-role-routing.json` 的 case 仍只有 `role-selected` 事件断言，`requiredArtifacts` 全空、无 execution fixture，只证明文本判分契约。见 TD-2026-09-15-4。 |
| F06 | 部分修复 | `scripts/lib/eval-assets.js` 的 `ASSET_GROUPS.rules` 已含 `roles`、`.agents/roles`、`.codex/agents` 等（本次 reference 的 rules 组 29→44 文件即由此产生）；`scripts/lib/project-evaluation.js` 的在线 `CONFIG_PATHS` 不含任何角色目录。见 TD-2026-09-15-5。 |
| F07 | 已修复 | `projectRoleDescription()` 把 `description`、`routing.when` 与 `routing.avoid` 组合进每个宿主原生角色的 description（Codex TOML 同源），`.agents/roles/index.md` 的 description 与适用/避免行与之同源同语言；`scripts/lib/roles-audit.js` 增加逐字一致、单行、ASCII 与 explicit 前缀断言。 |
| F08 | 已修复（静态） | `roles/base.md` 新增「固定职责的子 Agent 不自行切换角色、不重派任务、不扩大权限」「职责、工具、证据或停止条件不再匹配时回传父 Agent」与接单前确认目标/基线/写范围/验收的段落；`docs/rules/role-routing.md` 的切换与协作一节同口径。 |
| F09 | 已修复 | `scripts/lib/roles-audit.js:115` 改读 `docs/rules/role-routing.md`；本轮 `pnpm roles:audit` 退出 0（7 roles、0 errors、0 warnings），`tests/role-projection.test.js` 通过。 |
| F10 | 部分修复 | doctor 的 `roles.<host>` 拆成 `fileGenerated`（generated）/ `hostActivated`（automatic 或 manual-activation-required）/ `toolBinding`（native、prompt-guarded 或 configured-unverified）/ `currentTaskExecutable` 四级，合并字段 `status` 只描述第一级；本仓库 2026-09-16 的 Codex 真机冒烟把第二级补到「角色定义被宿主加载」。见 TD-2026-09-15-7。 |

## TD-2026-09-15-2 验证类角色的权限只到投影层，缺宿主实测与角色专属只读约束（2026-09-18 已关闭）

2026-09-18 架构审查批次 P1-1 关闭该条目的核心前提：角色权限预设不再是纯投影声明，Hook 运行时直接执行三层预设语义。

- 关闭证据：`runtime/hooks/lib/role-permissions.mjs` 定义 writable（含 `workspace-write`）/ executable（writable 或含 `validation-command`）/ read-only 三层，与 `scripts/lib/role-projection.js` 的 `WRITE_PRESETS`/`EXECUTE_PRESETS` 及 `manifests/roles.json` capabilities 三处等值，等值检查 `validateRolePresetDerivations` 已进 pack 校验（负控见 `tests/component/role-preset-consistency.test.js`：任一处漂移必红）。`runtime/hooks/lib/policy.mjs` 在写尝试路径按预设拒绝：只读预设拒绝一切写尝试，可执行预设拒绝直接写文件工具但把 shell 写路径留给 Execution Envelope（test-lead 仍可跑 `pnpm test`），未知预设 fail-closed 为只读。`runtime/hooks/lib/execution-envelope.mjs` 在解析任何 Envelope 之前执行同一预设上限，已签发 Envelope 不能把角色抬升到预设层级之上。预设经两条通道进入 Hook：宿主环境 `VIBE_HARNESS_PERMISSION_PRESET`（宿主权威，优先于项目配置且不受 hooks mode off 豁免）与项目配置 `hooks.permissionPreset`。真实子进程负控：`tests/integration/role-permission-enforcement.test.js` 以宿主注入环境变量的方式运行发行版 Hook CLI，verification 预设写业务源码 `src/app.js` 被 `ROLE_PERMISSION_PRESET` 拒绝，同一写入无预设时放行；analysis 预设的副作用命令被拒、verification 预设的 `pnpm test` 放行。
- 遗留：当前没有宿主投影把 `VIBE_HARNESS_PERMISSION_PRESET` 写进角色子 Agent 会话环境（仓库内仅 Hook 侧消费该变量），真实宿主会话内的端到端生效依赖宿主接线或项目配置通道；「宿主版本 + 预设注入与角色内权限实际行为」的真机证据要求并入 TD-2026-09-15-7 的逐宿主真机记录，不在本条重复跟踪。
- Owner：Vibe-Harness 维护者。

## TD-2026-09-15-3 Antigravity 角色文件发现路径与工具绑定未实证

本轮已关闭该条目的可静态修复部分：`resolveRoleInstallEntries()` 改为按本次安装实际解析到的能力注入，Claude 枚举 `mcp__<server>` 并预加载 `skills`、ZCode 声明 `skills`、Qoder 写 `skills` 与 `mcpServers`、Gemini 在有 server 时追加 `mcp_*`；Codex 侧按官方契约由父会话继承（未设置的字段沿用父会话配置，属预期而非缺口），`pnpm roles:audit` 对这四类键位逐条断言。仍开的是 Antigravity 一侧。

- 证据：`manifests/adapters.json` 把 Antigravity 的 `roleProjection.toolBinding` 固定为 `configured-unverified`，`scripts/lib/role-projection.js` 只写二进制核实过的工具名（`view_file`、`grep_search`、`list_dir`、`replace_file_content`、`write_to_file`、`run_command`）；`.agents/agents/` 是否是该宿主读取项目角色定义的路径、这六个名字是否真被接受，本仓库没有任何真机记录，doctor 也只把它报成 `configured-unverified`。
- 影响：Antigravity 用户拿到的角色文件可能既没被加载、也可能因工具名或路径不符而静默降级，而设备上看到的仍是「文件已生成」；其它七个宿主不受该条目影响。
- Owner：Vibe-Harness 维护者。
- 关闭条件：在装有 Antigravity 的机器上用真实子 Agent 确认 `.agents/agents/*.md` 被加载且六个工具名均被接受；若路径或名字不符，按实测修正 `roleProjection.targetRoot` 与 `NATIVE_TOOLS.antigravity`，并把 `toolBinding` 提升为 `native` 或 `prompt-guarded`；在此之前不得宣称 Antigravity 的工具绑定成功。

## TD-2026-09-15-4 角色 Eval 仍以文本重放为主，不能证明能力闭环

- 证据：`evals/suites/vibe-harness-role-routing.json` 的 10 个 case 全部只有 `requiredEvents`/`forbiddenEvents`，`requiredArtifacts` 与 `forbiddenArtifacts` 为空，也没有 execution fixture；离线 runner 只评估预置 `replay.output`。
- 影响：suite 能证明判分与路由措辞的合同，不能证明角色读取正确上下文、实际派发、运行验证、失败停止或形成有效交付；「跨两次消息保持角色」目前仍是一次回答里出现多个名称。
- Owner：Vibe-Harness 维护者。
- 关闭条件：为关键能力补真实工具事件、fixture 内容变化、隐藏验收与错误完成断言，并加一个「只输出正确短语的空执行器」负控；该批整改另行在线评测，未落地前不得把角色 suite 通过当作能力已闭环。

## TD-2026-09-15-5 在线配置指纹未覆盖角色正文目录

- 证据：`scripts/lib/eval-assets.js` 的 `ASSET_GROUPS.rules` 已覆盖 `roles`、`.agents/roles`、`.codex/agents`、`docs/agent-roles` 等（本次 reference 的 rules 组由 29 增至 44 文件），但 `scripts/lib/project-evaluation.js:56` 的 `CONFIG_PATHS` 仍只列 `docs/rules`、`manifests`、`schemas` 等，不含任何角色目录。最小复现：修改 `.agents/roles/*.md` 会改变 offline reference 指纹，但不会改变在线 config 指纹。
- 影响：在线证据可以绑定到与新角色正文不一致的旧指纹，角色行为变更的两条证据链口径不一致。
- Owner：Vibe-Harness 维护者。
- 关闭条件：把角色正文目录并入在线 `CONFIG_PATHS`（或说明在线路径为何不需要），并补一条「改角色正文必须导致对应指纹变化」的断言。

## TD-2026-09-15-7 角色四级状态已落地，仍缺宿主侧真机实证

- 证据：doctor 的 `roles.<host>` 现在输出 `fileGenerated: generated`、`hostActivated: automatic|manual-activation-required`、`toolBinding: native|prompt-guarded|configured-unverified`、`currentTaskExecutable`（无真机证据时恒为 false），合并字段 `status` 只描述第一级；`manifests/adapters.json` 新增 `roleProjection.toolBinding` 并成为 schema 必填，校验枚举只允许这三种取值。2026-09-16 的 Codex 0.147.0 真机冒烟补到第二级：派生的角色子 Agent 拿到了本仓库角色契约正文，因此 `hostActivated` 对 Codex 不再是推定；派发同时暴露两个新事实——角色描述未观察到直接参与委派，角色文件的 `sandbox_mode` 未独立生效（该缺口的 Hook 侧执行与负控已于 2026-09-18 落地并关闭 TD-2026-09-15-2；本条剩余的是宿主会话内注入 `VIBE_HARNESS_PERMISSION_PRESET` 并记录实际行为的真机证据）。
- 影响：`configured-unverified` 与「当前任务可执行」仍可能被读成同一个 ready 结论；权限收紧、插件缺失或工具名错误都不会改变 `currentTaskExecutable`，只有逐宿主的真机证据才能推进它。
- Owner：Vibe-Harness 维护者。
- 关闭条件：为每个启用角色的宿主积累至少一次真机记录（宿主版本、角色被加载的证据、角色内工具与权限的实际行为），并把证据路径写进 doctor 输出；在此之前文档与 doctor 文案维持四级状态，不给合并结论。

## TD-2026-09-15-8 project-verification 的超时收据用例绑定墙钟阈值，高负载下误判

- 证据：`tests/project-verification.test.js` 的 `verify --project terminates a hanging command and returns a structured timeout receipt` 在结尾断言 `Date.now() - startedAt < 5000`。2026-09-15 的批次 2 与批次 4 收尾中，全量 `pnpm test:integration` 各失败一次（实测耗时 7.5 秒级），同一文件单独运行 17/17 通过、重跑整表通过；两次失败都在与其它检查并行执行时出现。2026-09-16 角色投影批次复现同一现象并补了独立测量：本机同时运行其它项目的构建时，同一场景三次实测为 5329 ms、9983 ms、7937 ms，全部超过 5000 ms 上界；同批次另有一次 `tests/cross-platform-adapters.test.js` 的 `claude minimal supports an empty-project write, validate, and uninstall lifecycle` 触发 `--test-timeout=120000` 上限，该文件单独运行 42/42 通过但耗时 107.8 秒，放宽到 `--test-timeout=600000` 后同一份文件清单 321 通过 / 1 既有跳过 / 0 失败。2026-09-16 测试分层批次确认 `tests/verify-focused.test.js` 的 `verify-focused --run terminates a hanging command with project timeout recovery` 复制了同一断言：单独运行在本机实测 7.1 秒，同样超过 5000 ms 上界，该文件已在断言处绑定本技术债 ID。
- 2026-09-16 测试分层批次已按关闭条件替换判据：`tests/integration/project-verification.test.js` 与 `tests/integration/verify-focused.test.js` 的 `< 5000` 上界改为「不早于收据声明的 `timeoutMs` 结束，且在 30 秒进程树回收预算内结束」，两处仍绑定本技术债 ID；该批次全量 `pnpm test:integration` 仍复现过一次 9097 ms 的旧断言失败，说明替换前该红灯在高负载下必然出现。
- 影响：该用例要证明的是「超时后仍返回结构化收据」（已完成），但收据之外还绑定了机器无关性不足的墙钟上界，使 CI 与高负载本机出现与被测行为无关的红灯；失败信息指向 `timeoutMs` 断言之后的最后一行为真，容易误读为超时机制失效。
- Owner：Vibe-Harness 维护者。
- 关闭条件：把 `< 5000` 换成与被测语义一致的判据（例如比较收据内声明的 `timeoutMs` 与实际耗时区间、或把上界放宽到覆盖进程树回收的合理范围），或在文件头注明该断言的环境前提并绑定可核对的技术债 ID；连续 10 次全量 `pnpm test:integration` 不再出现该失败后关闭。

## TD-2026-09-18-1 strict enforcement 的阻断降级依赖 hostEvidence，尚无宿主真实注入

- 证据：`hooks.enforcement: "strict"`（2026-09-18 落地，scripts/lib/install-planner.js、scripts/lib/runtime-diagnostics.js、scripts/vibe-harness.js）把 HOOK_ENFORCEMENT_UNVERIFIED 升级为阻断警告并按 owner-union 拒绝无执行包络宿主的红区写入；`enforced` 与警告消失的判定依据是 `inspectRuntimeHooks` 的 `hostEvidence` 入参（激活、Envelope enforcement、sandbox、approval、process、network），目前只有测试（tests/integration/enforcement-gate.test.js、tests/integration/runtime-diagnostics.test.js）以入参形式注入，没有任何宿主或 CLI 通道从真机会话生产该证据。因此 strict 项目在真机上的常态是 install/validate/doctor degraded（exit 2）与 verify invalid（exit 1）：语义上正确（fail-closed），但离开 `--allow-degraded` 无法转绿。
- 影响：strict 只能作为「显式要求证据才放行」的策略使用，不能作为常规档位；长期依赖 `--allow-degraded` 会把降级状态训练成噪音。
- Owner：Vibe-Harness 维护者。
- 关闭条件：至少一个宿主提供可从项目侧读取的真机执行证据通道（宿主注入 v2 hostContext、宿主配置快照或等价机制），使 `inspectRuntimeHooks` 不依赖调用方入参也能证明 `enforced`，并同步更新 docs/hooks.md「跨宿主 fail-closed」节中「当前没有宿主真实注入 hostEvidence」的表述。

## TD-2026-09-19-1 run.mjs verify 的层表面固定为四槽，槽外层命令对 runtime 引擎不可见

- 证据：`runtime/commands/run.mjs:54` 的 `CHECK_ORDER = ['lint', 'typecheck', 'test', 'eval']` 是 runtime 引擎唯一的检查槽位；`configuredChecks()`（:362）只从 `config.validationCommands` 读取这四个基键，`resolveVerifyTierPlan()`（:393）把声明的 `tiers` 数组按命令字符串精确匹配到这四个槽位。CLI 引擎（`scripts/lib/validation-tiers.js` 的 `selectTierChecks`）按层命令全量选择，不依赖槽位。2026-09-19 P1-4 批次把本仓库 `tiers.quick` 收敛为 3 条、`tiers.standard` 改为 `["pnpm test:component","pnpm test:integration"]` 后的最小复现：`node .agents/runtime/commands/run.mjs verify --project . --tier standard --plan` 只计划 lint/typecheck/test 三个槽位（收据 deferredChecks 仅 eval、nextTier=deep），同一配置下 CLI 侧 `selectTierChecks({ tier: 'standard' })` 选择 6 项（含 test-component、test-integration）。
- 影响：`run.mjs verify --tier standard` 的收据标注 tier=standard，但该层的组件/集成命令被静默省略——依赖 runtime 收据声称「中等层证据已取得」的项目实际没有运行组件与集成测试；AGENTS.md「两个引擎命令同源于项目配置」的表述对四槽之外的命令不成立。非 P1-4 回归：component 此前配置在 quick 层时同样不在 runtime 槽位内（P1-4 反而使 runtime quick 槽位与配置的 quick 层逐命令一致）。
- Owner：Vibe-Harness 维护者。
- 关闭条件：runtime 引擎按 `validationCommands.tiers` 枚举任意命令（与 CLI 的 `selectTierChecks` 同一选择语义），或在收据与文档中显式声明 runtime 引擎的四槽层表面，并加等值测试锁定「四槽的层归属与配置一致 + 槽外命令在收据中显式列为不可执行」。

## TD-2026-09-19-2 focused 验证的长时限白名单不含 test:component/matrix/e2e，慢机把超时终止误读为命令失败

- 证据：`scripts/lib/project-verification.js:67-72` 的 `focusedCommandTimeoutMs` 仅当项目未显式配置超时（配置值等于 `:12` 的 `DEFAULT_PROJECT_VERIFICATION_TIMEOUT_MS = 120_000`）时，才对匹配 `/^(?:pnpm|npm|yarn)\s+(?:test:integration|smoke:lifecycle)(?:\s|$)/u` 的命令把预算放宽到 `:15` 的 `FOCUSED_LONG_RUNNING_TIMEOUT_MS = 300_000`；`test:component`、`test:matrix`、`test:e2e` 不在白名单，各自沿用 120s 默认。2026-09-19 P1 收尾实测：本仓库 `pnpm verify:focused --run` 的 5 命令计划在 `pnpm test:component` 处被超时终止——被杀前 114 用例全部通过、0 断言失败、无 node:test 总结块（进程被杀的签名，而非测试失败；该机组件层 290 用例全量耗时远超 120s，被杀时前 114 用例已累计约 128s），控制台只输出「Focused verification failed at: pnpm test:component」，未标注超时语义。修复为 dogfood 配置 `vibe-harness.config.json` 显式声明 `verification.timeoutMs: 600000`（schema 区间 [1000, 3600000]）并按既有流程再生成 eval reference/results 与镜像；该配置一旦显式设置即对所有 focused 命令统一生效，白名单整体旁路。
- 影响：未显式配置 `verification.timeoutMs` 且组件层耗时超过 120s 的机器上，聚焦验证把「超时被杀」与「测试失败」折叠为同一种 EXIT=1 失败，误导排障方向；白名单与测试分层现状（component 已是 quick/standard 层常规命令）漂移，慢机需要逐项目携带相同的配置变通。
- Owner：Vibe-Harness 维护者。
- 关闭条件：长时限判定从层/命令声明派生（或至少把 test:component/test:matrix/test:e2e 补入白名单），且超时终止在收据与控制台输出中显式标注、与测试失败可区分，加负控测试锁定。

## TD-2026-09-19-3 response-modes 18 模式目录收敛延期（门槛量化已先行落地）

- 证据：2026-09-18 审查综合 P2 计划项「response-modes 18 个收敛为少数核心、显式为主 + 模糊门槛量化」在本批次（2026-09-19 P2-D）只落地了门槛量化：`docs/rules/governance-core.md` 长任务触发改为量化两档（先验「开始时预计执行超过 60 分钟」/后验「会话中发生第一次上下文压缩」，压缩事件即上下文水位信号）并新增「锚点强制更新」档（已建锚点后累计第二次起压缩，继续实质写入前必须先更新锚点），同步 `scripts/lib/pack-validation.js` 锚点表、`scripts/lib/template-renderer.js` 双变体、`adapters/antigravity/RULES.template.md` 硬编码副本、`tests/matrix/cross-platform-adapters.test.js` 钉住正则并经 dogfood 重放刷新 AGENTS.md 投影。模式目录收敛延期的约束：`docs/rules/response-modes.md:83` 自身的合同要求「模式目录、保底条款或激活规则的变更视为表达行为变更，用真实任务或 `vibe-harness-response-modes` Eval 观察误触发与保底缺口后再收敛」——该观察数据在本批次不存在；且 `evals/suites/vibe-harness-response-modes.json`（6 case）引用了 `/brief`、`/explain-simple`、`/trace`、`/explain`、`/review` 五个模式名，目录收敛需同步改写 eval fixture 与 reference。另外，量化门槛目前是规则与投影层的散文合同：锚点 schema 未记录压缩事件计数，「锚点强制更新」档的执行依赖会话自律而非机器可核对的字段。
- 影响：18 个模式（主任务 14 + 修饰 4）的目录复杂度与「显式为主」的取向继续并存；量化门槛的第三档（锚点强制更新）没有机器侧核对，违反时只产生恢复缺口、不产生可检测信号。
- Owner：Vibe-Harness 维护者。
- 关闭条件：先用真实任务或 `vibe-harness-response-modes` Eval 采集各模式触发/误触发/保底命中的观察数据，按数据给出核心模式集合与命名收敛方案（含 eval fixture 同步），再实施目录收敛；锚点强制更新档若要机器可核对，需在 `.vibe-harness/tasks/` 锚点 schema 中记录累计压缩次数并在 `task update` 校验。

## TD-2026-09-19-4 run.mjs 拆分延期（P2-G 结构收敛批次决策）

- 证据：`runtime/commands/run.mjs` 约 2,984 行，其中 task 锚点块 `:2082-2629`（约 548 行）与 codebase-memory 块 `:2631-2859`（约 229 行）是两个可辨识的拆分候选。拆分不是机械代码搬运：task 块与父作用域双向耦合——向内消费 `SCHEMA_VERSION`（:41）、`CHECK_ORDER`（:54）、`PASS_STATUSES`（:62）、`normalizePath`（:68）、`displayCommand`、`boundedOutput` 六个父级标识符，向外导出 `findReusableVerification` 与 `verificationCommandSet`，被 `verify --reuse` 在 `run.mjs:526-528` 消费；抽出为 `runtime/lib/` 模块属于接口设计任务（需下沉共享常量或反转依赖注入）。若落地，登记面有四处：硬性两处——`adapters/install-map.json` 的 `runtime-project-scripts` 组新条目（contentStrategy `replace`）与 `.agents/runtime/lib/` 字节一致 dogfood 副本（`scripts/lib/pack-validation.js` 的 `validateSelfInstalledArtifacts` 校验）；软性两处——`manifests/capabilities.json` 的 project-deterministic-scripts targets 与 `tests/cases.json` 台账自动同步。2026-09-19 P2 批次决策延期：落在约 180 文件未提交变更集之上无行为收益，且需连带 dogfood 重装与全套自装/组件/矩阵再验证。同批次一并延期的还有 `scripts/vibe-harness.js` 与 `scripts/lib/install-planner.js` 的同类拆分。
- 影响：单文件体积继续支撑全部项目级确定性命令，评审与冲突合并成本随批次累积；四槽层表面的既有约束（TD-2026-09-19-1）使拆分延期的风险可控（无行为合同依赖文件布局）。
- Owner：Vibe-Harness 维护者。
- 关闭条件：当前批次合并后单独开批实施：先设计共享接口（共享常量下沉 `runtime/lib/` 模块或依赖注入反转），按上述四处登记面落地 install-map、dogfood 副本与 capabilities targets，并以 `pnpm test:integration`、`pnpm test:matrix`、`pnpm smoke:lifecycle` 与自安装一致性校验全套通过为关闭证据；在此之前不宣称 run.mjs 结构收敛。

## TD-2026-09-19-5 成本遥测接入 project-evaluation 延期（P2 批次评估）

- 证据：token 埋点与聚合报告两层均已存在——`scripts/lib/eval-trials.js:32-51` 的 trialSummaries 逐 trial 记录 `toolSummary.tokenUsage`（cachedInputTokens/inputTokens/outputTokens/reasoningOutputTokens/totalTokens，`observation.metrics?.tokenUsage` 带 totalTokens 回退）；`scripts/lib/eval-report.js:58-71` 的 `aggregateTokens()` 跨 trial 聚合并输出 collected/eligible/total 与 cachedInputRatio 等 measured 指标（:304-373），`harness-evals/metrics/metrics.js:90/:139` 也在 attempt 级聚合 tokenUsage。缺口仅在 `scripts/lib/project-evaluation.js`：零 token/成本字段（2026-09-19 grep 无命中），评估维度不含成本；离线 fixture run（`evals/results/vibe-harness-core.offline.json`）不含 tokenUsage（在线 run 才携带）。当前没有任何消费方或查询面（预算门禁、按 suite 的成本对比报表）需要该维度。
- 影响：成本数据已采集、已聚合，但项目评估结论与成本无关；无消费方时先建管线只增加评测表面，不产生决策价值。
- Owner：Vibe-Harness 维护者。
- 关闭条件：出现真实成本决策诉求（canary 预算调优、模型/供应商选择、按 suite 的成本回归对比）时，基于既有 `trialSummaries.tokenUsage` 与 eval-report 聚合结果把成本维度接入 `project-evaluation` 并定义阈值，无需新埋点。
