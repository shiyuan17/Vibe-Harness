# Vibe-Harness 规范与工作流全面审查（P0/P1 落地 + P2 路线图）

> 审查日期：2026-09-01
> 内容基线：d8f5a68（feat(evals): cover plan split judgment at version 2.8.0）+ 本轮 P0/P1 工作区改动
> 范围：规范体系（rules/ + docs/rules/）、命令与执行流程（CLI 安装/校验/基线/回滚）、测试与评估体系（unit/eval/integration）、Hook 运行时
> 方法：多智能体并行审查（规范体系 / 命令与执行流程 / 测试与评估体系 / 网络最佳实践两路）+ 全部关键发现的源码人工核验 + 实测数据（测试提速、指令足迹）

## 执行结论

架构方向与官方最佳实践同向，无需结构性调整：宿主按 description 直选 Skill、不用 Router 链，与 Anthropic「coding 任务不适合重型多 agent 编排（约 15 倍 token 开销）」的结论一致；PreToolUse 红区 Hook 是 Anthropic 官方 hooks 文档的教科书用例；dry-run 默认 + 事务化安装 + 哈希守卫的幂等/回滚设计严谨；governance-core 44 行常驻内核 + 专项规则懒加载符合「每个指令文件目标 <200 行」的官方指引。

本轮落地 **P0 行为正确性修复 8 项**、**P1 提速 5 项**（含一次引入又修复的缓存回归，详见 3.6 节），P2 规范质量重构以路线图形式交付（第 5 节）。

P1 实测收益：

| 指标 | 改动前 | 改动后 | 说明 |
| --- | --- | --- | --- |
| test:integration 全量 | 4288s（改动前串行基线）；4270s（P1 代码串行复测） | 1691s（并发 2 首测）；1521s（并发 2 终验） | 26 文件、298 测试（串行复测与并发运行同测试集）；提速约 2.8×（以终验 1521s 计），收益来自文件级并发——P1-2/3/4 优化的是 CLI 命令延迟，两次串行数据（4288s/4270s）互证其对测试套件时长无感 |
| validate 双重规划 | 每次多 target 全量规划 ×2 | ×1 | `diffMultiTargetInstall` 接受外部已构建 plan |
| manifest 静态读取 | 多 target 串行 3N 次 | 每进程每路径 ×1 | `readPackJson` 进程级 memoize |
| Hook 每次 guarded 调用 | ≈2 次 node 启动 + 2 次 git 子进程 | ≈1 次节点 + 1 次 git | bootstrap 定位的 git root 经 env 传递给 hook |

## 一、行为正确性发现（P0，已全部修复）

### 1.1 Windows EINVAL：verify 执行 .cmd 失败

`scripts/lib/project-verification.js` 的 `executableFor` 在 Windows 返回 `pnpm.cmd`，随后以 `execFile`（无 `shell:true`）spawn。Node ≥18.20/20.12（CVE-2024-27980 缓解，本仓库 engines 要求 ^20.19/^22.18/^24）对此直接抛 EINVAL —— 意味着 `vibe-harness verify --project` 在 Windows 上执行任何 pnpm/npm/yarn 验证命令都会失败。同仓库 `runtime/hooks/git-hook.mjs` 早已正确处理（`cmd.exe /d /s /c` 垫片）。
**修复**：对齐 git-hook 模式，.cmd 垫片统一经 `cmd.exe /c` 启动；补 Windows 回归测试（tests/project-verification.test.js）。

### 1.2 install 缺未知选项白名单

`install()`（vibe-harness.js:322-497）是唯一没有 allowedOptions 检查的写命令（uninstall:1098、provision、baseline:695 均有）。拼错 `--writ` 会被静默解析为布尔标志、实际仍为 dry-run —— 用户以为写了其实没写。另 `--provision`（:423）存在于实现但未列入 usage（:1231）。
**修复**：补白名单集合（project/write/dry-run/target/profile/modules/plugin/rtk-hooks/force/upgrade/confirm-red-zone/allow-preview/provision/allow-degraded/output/verbose）；usage 补 `--provision`。

### 1.3 三处不可达的重复 target 检查

rollback（vibe-harness.js:1049-1054）、uninstall（:1085-1090）、provision（约 :1161-1166）各含两个连续相同的 target 检查，第二个永不可达且错误信息误导排障方向。
**修复**：删除三处不可达分支。

### 1.4 输出脱敏不一致

diff（:1041）/rollback（:1065-1071）/uninstall（:1116-1125）/baseline（:752）直接 `console.log(JSON.stringify(...))`，`action.target` 等字段携带绝对路径绕过 `sanitizePublicReport`；而 install/validate/verify/doctor 统一脱敏。同一 CLI 的输出契约不一致。
**修复**：新增 `printRawReport` helper，四类输出统一经 sanitizePublicReport（保持 JSON 结构不变）。

### 1.5 uninstall 部分失败状态不自洽

`scripts/lib/install-state.js` `applyUninstallPlan`：有 skip 时 remainingState 的 `targets` 仍包含已卸载 adapter、`configUpdate` 只在全成功分支写 —— 单 target 部分失败后状态与实际安装面脱节。
**修复**：skip 分支移除已成功卸载的 target 并同步写 configUpdate（与全成功分支同构）。

### 1.6 多 target install 只校验第一个 adapter 指令模板

`vibe-harness.js:344,399-404` 用 `selectedTargets[0]` 校验指令模板渲染；第二个起 adapter 的模板语法错误要到写入阶段才暴露。
**修复**：循环全部 selectedTargets 逐个校验。

### 1.7 措辞漂移与安装面不实

governance-core.md:9 仍是「失败不得通过降低断言绕过」，而 test-rules.md:15（用户本轮未提交改动）已升级为「降低断言、删除断言或无理由跳过相关测试」；AGENTS.md:69 安装面只声明 agentmemory，但 `.agents/skills/browser-verification/` 实际存在且被 git 跟踪。
**修复**：governance-core（双份同步）升级为同精度表述；AGENTS.md 补记 browser-verification。

## 二、流程速度发现（P1，已全部落地）

### 2.1 test:integration 串行是 CI 最大瓶颈（P1-1）

`--test-concurrency=1`、26 文件、约 292 处 mkdtemp、120s 超时，实测全量 4288s（71.5 分钟）。串行理由是「共享临时状态」，但逐文件审计后不成立：

- `tooling-modules.test.js` 使用 `server.listen(0)`（OS 分配端口，天然并行安全）
- `tool-provisioning.test.js:192` 的 `http://127.0.0.1:9222` 仅作为字符串参数传入（不监听）
- 无任何测试向固定路径写文件；npm cache 经 `tests/helpers/offline-tools.js` 以 pid 后缀目录隔离（每进程独立）
- node:test 每个测试文件本就运行在独立子进程

**落地**：`--test-concurrency=2` 全量对比串行基线（数据见执行结论表）。已知负载敏感测试（MCP browser probe 超时分类、tool-provisioning 120s 界限）在并发下个别波动，重跑即过；串行基线自身也有同类波动（见 3.7 分诊表）。

### 2.2 validate 重复构建安装计划（P1-2）

`validate()` 先调 `createMultiTargetInstallPlan`（vibe-harness.js:522），再把它传给 `diffMultiTargetInstall`，而后者内部又完整规划一次 —— 多 target 场景双倍规划。verify/doctor/baseline/diff 各路径同理附带二次规划。
**落地**：`diffMultiTargetInstall` 新增可选 `aggregatePlan` 参数，validate/install 流程传入已构建 plan；无 plan 的直接调用方保持内部构建回退。

### 2.3 manifest 静态文件重复读取（P1-3）

多 target 规划为每 adapter 重读 profiles.json + adapters.json×2 + install-map.json（3N 次静态 JSON 磁盘读取）。
**落地**：新增 `readPackJson`（manifest.js），按绝对路径进程级 memoize，仅用于 pack 静态文件（manifests/schemas/install-map/package.json）。可变目标项目状态（install-state、config、baseline、eval 结果）保持 `readJson` 直读 —— 这个边界在本轮踩过一次坑，见 3.6。

### 2.4 多 target 规划串行 for 循环（P1-4）

`createMultiTargetInstallPlan` 的 per-adapter 规划是只读操作，串行 await 无必要。
**落地**：改 `Promise.all` 并行；冲突合并在收集后按配置顺序进行，确定性不变。

### 2.5 Hook 每次 guarded 调用的固定开销（P1-5）

bootstrap `node -e`（template-renderer.js:3）spawnSync 一次 `git rev-parse` 定位仓库根，hook 内 `findProjectRoot`（context.mjs:52-72）再跑一次 git ≈ 每次 guarded 工具调用 2 次 node 启动 + 2 次 git 子进程。
**落地**：bootstrap 定位的 git root 经环境变量传递给 hook，`findProjectRoot` 优先读取该 env，仅在缺失时回退原逻辑。hook 测试 34/34 通过。

## 三、过程记录：一次真实的并行化回归（供后续参考）

### 3.6 P1-3 首版实现引入的缓存污染回归

首版把 memoize 直接加在共享 `readJson` 上。`readInstallState`（install-state.js:71）同样走 `readJson` 读目标项目的 `install-state.json` —— 而 baseline 写入路径是「读 → 注册 baseline.json → 写回 → 再次读 → 注册 report → 再写回」的读改写序列：第二次读命中第一次写之前的缓存快照，把 baseline.json 的注册抹掉。症状是 4 个 project-baseline 测试失败（generatedFiles 丢失 .vibe-harness/baseline.json、drift 停留 initial、v1 升级 TypeError、conflict 误判）。手动 CLI 复现（init → install → baseline）因跨进程每次冷启动而无法复现 —— 教训：**同一进程内读改写的文件绝不能进共享缓存**。修复为 `readPackJson`/`readJson` 双轨（2.3 节），project-baseline 9/9 恢复。

### 3.7 串行全量失败分诊（串行复测 4270s：298 测试 / 288 通过 / 6 失败 / 3 取消；改动前基线 4288s 同量级）

| 失败测试 | 分诊 | 依据 |
| --- | --- | --- |
| baseline previews then writes / protects conflicting artifacts / upgrades managed v1 snapshots / reports logging contract drift | 本轮引入（已修复） | HEAD worktree 对照通过；根因见 3.6 |
| GitHub workflows split develop and main gates | 既有 | 测试要求 `.github/workflows/hotfix-back-sync.yml`，该文件从未提交（git log 为空）；HEAD 同样失败 |
| full write installs governance assets / full write degrades unavailable tools | 负载相关 | 120s 超时类，单测隔离重跑通过 |
| gemini core install / Codex Linear install validates and uninstalls | 负载相关 | 改动前串行基线与隔离重跑均通过；串行复测中 gemini 以 120s 超时再现，属同一超时族 |
| MCP browser probe reports initialize... | 负载相关 | MCP_HANDSHAKE_TIMEOUT vs MCP_PROTOCOL_ERROR；隔离重跑通过 |

## 四、最佳实践对照（网络来源）

以下对照于 2026-09-01 在线核实（官方文档优先；OpenAI 产品行为仅采用 OpenAI 官方文档）：

| # | 维度 | Vibe-Harness 现状 | 最佳实践参照 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | 指令文件长度 | governance-core.md 8725 字节 / 44 行常驻；rules/ 20 文件共 83.3 KiB 懒加载 | Anthropic：AGENTS.md/CLAUDE.md 目标 <200 行，更长降低遵循度 | ✅ 同向 |
| 2 | 常驻段密度 | governance-core.md 第 8 行单段约 2284 字符（拆分判定+DAG+Envelope 挤在一段） | 同上（可读性影响遵循度） | ⚠ P2-4 |
| 3 | Skill description 规范 | 11 个 Skill 全部 <1024 字符（实测 64-168） | agentskills.io 开放标准：description ≤1024 字符 | ✅ 达标，但无机器校验（P2-5） |
| 4 | Skill description 语言 | git-deliver、browser-verification 中文；其余 9 个英文 | 宿主路由按 description 匹配，语言混合影响触发一致性 | ⚠ P2-5 |
| 5 | 红区 Hook | PreToolUse fail-closed 拦截写入 | Anthropic hooks 文档：红区写拦截是标准用例 | ✅ 教科书式 |
| 6 | Hook 超时语义 | hook 自身 fail-closed | Anthropic：宿主侧 hook 超时 = fail-open，超时后命令会继续执行 | ⚠ 建议补 Claude 端 permissions.deny 兜底（P2-10） |
| 7 | Codex 指令合并上限 | 935 行规则经根 AGENTS.md 受管块合并 | OpenAI：组合指令默认 32 KiB 上限 | ✅ 足迹纪律良好，留意增长 |
| 8 | 治理链复杂度 | 无 Router/流程 Skill 链，宿主直选 | Anthropic：coding 任务重型多 agent 编排约 15 倍 token 开销 | ✅ 同向 |
| 9 | 跨宿主指令发现 | 8 adapter 共享根 AGENTS.md 受管块 + 各自投影 | OpenAI：AGENTS.md 全局→项目根→当前目录逐层发现 | ✅ 兼容 |
| 10 | 测试措辞锁定 | 约 173 个断言行锁中文措辞（rules-depth 67、execution-simplification 36、linear-workflow 36、mvp-spec 15、project-profile 12、eval-governance-metrics 7） | 断言「句子存在」而非「语义有效」；业界趋势为行为断言 | ⚠ P2-3 |
| 11 | dry-run 默认 | 写操作默认预览，`--write` 显式提交 | 幂等/事务最佳实践 | ✅ 严谨 |
| 12 | 状态可观测 | doctor/validate/baseline 均输出结构化 JSON | 可观测性最佳实践 | ✅ |
| 13 | 回滚 | 事务 + 备份 + 哈希守卫 | 可逆性最佳实践 | ✅ |

未尽事项：Claude Code 官方文档对 hook 超时的表述为「超时的 hook 不阻塞后续命令」，即 fail-open —— Vibe-Harness 的红区依赖 hook fail-closed，在宿主超时场景存在理论窗口（P2-10 的 permissions.deny 兜底即为此）。

## 五、P2 路线图（规范合理性，本轮不实施）

按依赖顺序排列；每项标注动机与影响面。

> **2026-09-02 落地状态**（P2 执行计划五批次，详见 CHANGELOG Unreleased）：P2-1 ✅（批次 B3，4 组收敛）；P2-2 ✅（B5-a，`pnpm docs:sync` 镜像生成器）；P2-3 ✅（B2-b，低成本档：单一措辞权威层）；P2-4 ✅（B2-a，默认循环拆三个编号子项）；P2-5 ✅（B4-b，语言护栏 + description 统一）；P2-6 ✅（B5-b，契约测试 parity 断言 + docs/evals.md 派生注记）；P2-7 ✅（B5-c，治理记忆种子化 + 自安装 parity 按 TECH_DEBT 先例以渲染占位符解耦）；P2-8 ✅（B4-c，每片段独立变异共 10 个）；P2-9 ✅（B4-a，三清单修齐 + `validateRedZoneConsistency` 交叉校验）；P2-10 ❌ 未落地——已入改进队列 `docs/memory/IMPROVEMENTS.json`（IMP-71EF5DA1C036E409，eligible-for-owner-review，待 owner 评审后排期）。eval reference 指纹已随批次内容变更再生成（B5-d，需提交前审查 diff）。

### P2-1 跨文件重复规则收敛（已漂移）

- git credential helper 段两处近乎逐字且已分叉：git-rules.md:49「只可由其已配置的 Git transport 透明调用……不得读取、解析或转用 helper 输出进行网页或 API 登录」 vs linear-workflow.md:77「仅可由其配置的 Git transport 透明使用……不得读取、解析或转换 helper 输出用于网页/API 会话」——语义相同、措辞两套，测试断言两套。
- Envelope mode/effect 枚举三处、checkpoint 清单两处（措辞不同）、writeScope 规则两处。
- 方向：单一 canonical 段 + 引用（如 governance-core 引用 test-rules 的一句），或在 docs 层生成镜像。涉及约 5-6 个规则文件与对应测试断言。

### P2-2 rules/ ↔ docs/rules/ 手工双写

20 个文件双份维护，靠 docs:audit parity 兜底。方向：单一源 + 构建步骤生成镜像（进 check），或 docs 层改为符号引用。评估点：docs:audit 现有 parity 检查可转为生成器的正确性测试。

### P2-3 测试措辞锁定降耦

约 173 个断言行锁中文措辞：改一句规则文本需要联动最多 7 个测试文件。方向分两档：
1. 低成本：把「句子存在」断言收敛到 rules-depth 一个文件（单一措辞权威层），其余文件断言结构化语义（标题存在、条数、关键 token）。
2. 长期：rules 侧引入机器可读语义锚点（如章节 ID），断言锚点而非文本。

### P2-4 governance-core 第 8 行拆段

约 2284 字符单段（拆分判定 + DAG + Envelope 三主题）拆为 2-3 小节标题；同步 rules-depth 断言。动机：常驻内核的可读性直接决定遵循度（对照表 #2）。

### P2-5 Skill description 统一与校验

- 语言统一（11 个中 2 中文 9 英文 → 统一一种，建议英文 description + 中文正文，因宿主路由匹配语言敏感性）。
- 把 agentskills.io 的 description ≤1024 字符进 lint（当前全达标但无护栏）。
- eval-driven-development 补负向边界 description。

### P2-6 EVAL-SPLIT fixture 与规则源一致性

EVAL-SPLIT 用例内嵌英文版规则 fixture 与中文规则源非同一文本，无一致性检查。方向：fixture 生成自规则源，或加 parity 断言。

### P2-7 治理记忆空转

启动必读 docs/memory/（优先 PROJECT_STATE.md），但全部是未填占位模板（IMPROVEMENTS.json updatedAt=1970 哨兵、PROJECT_STATE.md 字段全空）。方向：要么真实启用（从本轮审查报告种子化 PROJECT_STATE），要么从启动序列降级为按需读取。

### P2-8 eval:behavioral 覆盖补齐

仅 4 控件×1 变异，与 test-rules.md 宣称的变异验证边界不匹配。方向：按 capability 目录补控件与变异深度。

### P2-9 红区双清单统一

安装面 manifest 的 redZone 标记与 hook 运行时 DEFAULT_RED_ZONE_PATHS 独立维护，靠注释同步（manifest.js:218-243 注释自认）。方向：运行时清单从 manifest 生成，或 lint 时交叉校验双清单。

### P2-10 Claude 端 permissions.deny 兜底

对照表 #6：Anthropic 官方 hook 超时语义为 fail-open，红区拦截在宿主超时场景存在理论窗口。方向：Claude adapter 安装时写入项目级 permissions.deny 作为 hook 之外的第二道静态防线（与 hook fail-closed 纵深）。

## 六、验证记录（本轮实际执行）

| 验证 | 结果 |
| --- | --- |
| project-baseline.test.js 全文件 | 9/9 通过（修复回归后） |
| linear-workflow + tool-provisioning | 61/64（2 失败均非本轮改动：hotfix-back-sync.yml 既有失败、MCP probe 负载 flaky 重跑通过） |
| install/validate 专项（vibe-harness-cli） | 30/30 |
| hook 相关（hook-bootstrap + hook-runtime） | 34/34 |
| pnpm check（lint 173 文件 + validate + test:unit 21 文件） | 通过（exit 0） |
| pnpm docs:audit | 通过（92 份文档） |
| pnpm test:eval | 148/152；3 失败分诊：2 个 replay 指纹失败 = 本轮 rules（governance-core 措辞）与 hooks（context.mjs）内容改动的**设计内指纹失效**（分组比对：config/skills 一致，hooks/rules 漂移），按 test-rules.md:78「reference 更新必须单独审查并显式确认」不自动再生成，留待维护者确认后更新（用户工作区已有的 reference 改动即同一流程）；1 个 canary 断言失败 = HEAD 既有（套件含 2 个 high 用例、7 个 workflowDemand，测试期望全 critical + 3 个 demand，套件与测试均未改动自 HEAD；test:eval 此前不在 CI 聚合内故潜伏） |
| pnpm smoke:lifecycle | 通过（exit 0，10 步无 failedStep） |
| 并行对比（--test-concurrency=2） | 1691s（提速约 2.5×）；298 测试 / 294 通过 / 2 失败 / 1 取消 / 1 跳过。失败集：GitHub workflows split（既有，hotfix-back-sync.yml 从未提交）、MCP browser probe（负载 flaky，串行基线同类）、full write degrades（120s 超时取消，串行基线同类）——无并发新增失败 |

## 七、遗留与建议

1. **hotfix-back-sync.yml**：测试断言存在但文件从未提交 —— 要么补文件要么删断言，属上游遗留（非本轮引入）。
2. **串行基线自身的负载 flaky**：4 个 120s 超时/握手超时类失败在串行全量下也出现，说明与并发无关，是环境负载敏感。建议 CI 中对这两类失败提供重试或标记。
3. 并行度提升到 4 的判定标准：并发 2 全量两连绿后可再试 4，并关注 CPU 核数与 mkdtemp 磁盘争用。
4. **离线 Eval reference 待维护者确认更新**：本轮 governance-core 措辞升级与 context.mjs hook 改动使 rules/hooks 两组资产哈希漂移（config/skills 一致），`eval:replay` 与 test:eval 中 2 个指纹断言按设计失败。按 test-rules.md:78，reference 更新须单独审查并显式确认，本轮未自动再生成。
5. **canary 套件与测试不同步（HEAD 既有）**：`evals/suites/vibe-harness-online-canary.json` 含 2 个 high 用例（OBS-RULE-002、EVAL-GIT-DELIVER-004）与 7 个 workflowDemand，而 tests/eval-ci.test.js:86 仍断言全 critical + 3 个 demand；test:eval 此前不在 CI 聚合内故未暴露。需二者择一对齐（升测试期望或复核用例 risk 定级）。
