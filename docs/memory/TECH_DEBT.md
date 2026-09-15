# 技术债

记录未关闭技术债，包含 ID、证据、影响、owner 和关闭条件。

<!-- 渲染说明：此模板含 render 占位符，安装时由 template-renderer 输出，内容不与 docs/memory/TECH_DEBT.md 逐字对应；实时技术债记录见 docs/memory/TECH_DEBT.md。占位符：Vibe-Harness。 -->

最后更新：2026-09-15

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

## TD-2026-09-15-1 负载敏感集成测试的 retry 标记缺少可核对的追踪条目

- 证据：`tests/tool-provisioning.test.js` 的 `MCP browser probe invokes list_pages after tool discovery` 与 `full write degrades unavailable tools and rollback removes only the managed MCP block` 带 `{ retry: 2 }`，原注释引用 TD-2026-09-01-2；该 ID 在 docs/memory/TECH_DEBT.md 中没有对应条目，此前只出现在 audit-reports/2026-09-02-focused-verification-workflow-review.md。docs/rules/test-rules.md 现要求隔离项绑定可核对的技术债 ID、owner 和关闭条件。
- 影响：负载敏感用例的重试标记可能长期存在而没有到期判据，与「flaky 测试须隔离并限期修复，不以重跑掩盖」的规则口径无法核对，重试也随之变成隐性豁免。
- Owner：Vibe-Harness 维护者。
- 关闭条件：连续 10 次全量 `pnpm test:integration` 不再出现该类负载敏感失败后移除两处 `{ retry: 2 }`；若仍复现，改为隔离该用例或修正超时与并发假设，并保留失败证据。

## F 系列三态台账（2026-09-05 审查，2026-09-15 复核）

`audit-reports/2026-09-05-agent-capability-design-review.md` 的 F01–F10 此前没有可核对的处置记录。下表按「已修复 / 部分修复 / 未修复 / 无法判定」逐项给结论与证据；未关闭项在下方各自成条目。本轮未执行宿主实测，凡结论依赖真实宿主绑定的项目一律不给「已修复」。

| ID | 结论 | 证据 |
| --- | --- | --- |
| F01 | 已修复 | `scripts/lib/role-projection.js:52` 新增 `NATIVE_TOOLS`，Gemini 用 `read_file`/`grep_search`/`run_shell_command`、Antigravity 用 `view_file`/`grep_search`/`run_command`；`tests/role-projection.test.js:366` 断言原生名称；`pnpm roles:audit` ok（7 roles、0 errors）。 |
| F02 | 部分修复 | `EXECUTE_PRESETS` 含 `verification`/`release-readiness`，OpenCode 投影对 test-lead 与发布角色从 `bash: "*": deny` 变为 `ask`，Codex 从 `read-only` 变为 `workspace-write`；但角色预设仍只是声明，Hook 不消费它，缺宿主实测。见 TD-2026-09-15-2。 |
| F03 | 未修复 | `projectedToolNames()` 仍只产出 read/search/glob/edit/write/run，Claude 投影无 Skill 工具、无 MCP 工具名。见 TD-2026-09-15-3。 |
| F04 | 部分修复 | `docs/rules/role-routing.md` 选择顺序第 1 条改为先判原子动作、第 4 条明确「已明确的实现不改派只读咨询角色」；本轮未做路由 Eval 观察，不能声明稳定。 |
| F05 | 未修复 | `evals/suites/vibe-harness-role-routing.json` 的 case 仍只有 `role-selected` 事件断言，`requiredArtifacts` 全空、无 execution fixture，只证明文本判分契约。见 TD-2026-09-15-4。 |
| F06 | 部分修复 | `scripts/lib/eval-assets.js` 的 `ASSET_GROUPS.rules` 已含 `roles`、`.agents/roles`、`.codex/agents` 等（本次 reference 的 rules 组 29→44 文件即由此产生）；`scripts/lib/project-evaluation.js` 的在线 `CONFIG_PATHS` 仍未含角色目录。见 TD-2026-09-15-5。 |
| F07 | 部分修复 | 索引仍写出 custom 的 `when`/`avoid`，原生角色文件只组合 base、正文与权限；路由规则第 2 条已要求 custom 与内置同过滤、以 `.agents/roles/index.md` 为准，但未落进原生文件。见 TD-2026-09-15-6。 |
| F08 | 已修复（静态） | `roles/base.md` 新增「固定职责的子 Agent 不自行切换角色、不重派任务、不扩大权限」「职责、工具、证据或停止条件不再匹配时回传父 Agent」与接单前确认目标/基线/写范围/验收的段落；`docs/rules/role-routing.md` 的切换与协作一节同口径。 |
| F09 | 已修复 | `scripts/lib/roles-audit.js:115` 改读 `docs/rules/role-routing.md`；本轮 `pnpm roles:audit` 退出 0（7 roles、0 errors、0 warnings），`tests/role-projection.test.js` 通过。 |
| F10 | 部分修复 | doctor 现在输出 `roles.codex = {permissionMapping, roleCount:7, activationPath, missingCapabilities}`，本仓库首次能自证角色投影非空；仍无「宿主已激活」「工具绑定已验证」状态。见 TD-2026-09-15-7。 |

## TD-2026-09-15-2 验证类角色的权限只到投影层，缺宿主实测与角色专属只读约束

- 证据：`scripts/lib/role-projection.js` 的 `EXECUTE_PRESETS` 让 `verification`/`release-readiness` 角色获得执行能力（OpenCode `bash "*": ask`、Codex `sandbox_mode: workspace-write`），但 `runtime/hooks/lib/policy.mjs` 与 `execution-envelope.mjs` 的判定输入不含角色的 permissionPreset；临时项目把 `agent_type` 标记为 test-lead 后评估普通 Bash 重定向仍返回放行（静态结论，未执行该命令）。
- 影响：宿主是否真正按投影授予验证命令、验证产物写隔离目录、拒绝业务源码写入，目前没有证据；「验证角色可以跑测试」既是能力声明也可能成为越权写入的旁路。
- Owner：Vibe-Harness 维护者。
- 关闭条件：在至少一个宿主上用真实子 Agent 覆盖「命令成功、截图落盘到隔离目录、业务源码修改被拒」三种情况并记录宿主版本；或确认由宿主 sandbox 承担并把角色预设降级为纯声明，同步 `docs/roles.md` 与 doctor 的能力字段。

## TD-2026-09-15-3 原生子 Agent 工具表不含 Skill 与 MCP 工具

- 证据：`projectedToolNames()`（`scripts/lib/role-projection.js:192`）只按 read/search/glob/edit/write/run 六类产出宿主原生名称；Claude 投影无 Skill 工具与预加载 skills，Qoder/ZCode 的穷举 `tools` 表不含已安装 MCP 工具，analysis 类角色无 WebSearch/WebFetch。
- 影响：父会话装了插件，架构、测试、发布等子 Agent 仍无法原生调用图谱、浏览器或 Linear 能力，只能读本地 Skill 正文或消费父 Agent 提供的证据；派发前的能力检查因此无法按「已安装插件」推导。
- Owner：Vibe-Harness 维护者。
- 关闭条件：按已安装能力为角色投影最小具体工具集合（或显式记录不投影的理由），并用图谱、浏览器、用户提供上下文三条路径实测子 Agent 可达性；证据不足时保持 configured-unverified。

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

## TD-2026-09-15-6 自定义与禁用角色的 when/avoid 只进索引，不进原生角色文件

- 证据：`roleIndex()`（`scripts/lib/role-projection.js:176`）写出每个角色的适用与避免，原生投影只组合 base、角色正文与权限；禁用角色在索引中被过滤，原生文件仍按定义生成。`docs/rules/role-routing.md` 第 2 条要求有效集合以 `.agents/roles/index.md` 为准。
- 影响：不先读有效索引的宿主可能继续选择已禁用角色，或让 custom 与内置角色按 description 临场竞争；明确指定已注册 custom 仍有入口，因此不是完全不可调用。
- Owner：Vibe-Harness 维护者。
- 关闭条件：让原生角色文件可见其 when/avoid 与启用状态，或明确要求宿主先读有效索引并把该要求写进投影产物；覆盖禁用安全/发布角色、仅 custom 匹配、显式指定禁用角色、多个 custom 同时匹配四种场景。

## TD-2026-09-15-7 doctor 的 ready/native 未区分文件生成、宿主激活与工具绑定

- 证据：`roleRuntimeReport()`（`scripts/lib/role-projection.js:405`）只输出 activation、permissionMapping、roleCount、activationPath 与 missingCapabilities；本仓库自安装纳入 roles 后 `doctor` 的 roles 非空、missingCapabilities 列出 test-lead 缺 browser-verification 等，但没有任何字段说明宿主是否已加载角色文件、工具名是否真的绑定成功。
- 影响：`configured-unverified` 与「当前任务可执行」仍可能被读成同一个 ready 结论；权限收紧、插件缺失或工具名错误都不会改变该结论。
- Owner：Vibe-Harness 维护者。
- 关闭条件：把状态拆成「文件已生成 / 宿主已激活 / 工具绑定已验证 / 当前任务可执行」并逐级给证据，或明确声明只覆盖第一级并同步 `docs/roles.md` 与 doctor 文案。

## TD-2026-09-15-8 project-verification 的超时收据用例绑定墙钟阈值，高负载下误判

- 证据：`tests/project-verification.test.js` 的 `verify --project terminates a hanging command and returns a structured timeout receipt` 在结尾断言 `Date.now() - startedAt < 5000`。2026-09-15 的批次 2 与批次 4 收尾中，全量 `pnpm test:integration` 各失败一次（实测耗时 7.5 秒级），同一文件单独运行 17/17 通过、重跑整表通过；两次失败都在与其它检查并行执行时出现。
- 影响：该用例要证明的是「超时后仍返回结构化收据」（已完成），但收据之外还绑定了机器无关性不足的墙钟上界，使 CI 与高负载本机出现与被测行为无关的红灯；失败信息指向 `timeoutMs` 断言之后的最后一行为真，容易误读为超时机制失效。
- Owner：Vibe-Harness 维护者。
- 关闭条件：把 `< 5000` 换成与被测语义一致的判据（例如比较收据内声明的 `timeoutMs` 与实际耗时区间、或把上界放宽到覆盖进程树回收的合理范围），或在文件头注明该断言的环境前提并绑定可核对的技术债 ID；连续 10 次全量 `pnpm test:integration` 不再出现该失败后关闭。
