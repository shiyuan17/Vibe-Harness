# Adaptive Verification Engine

状态：Implemented

## 目标

引擎把规则、项目配置、影响分析、验证计划、受控执行器、receipt、Task/CI 工作流和完成门禁串成唯一证据链：

```text
规则 → Schema → Planner → Runner → Receipt → Task/CI → Completion Gate
```

CLI 与 runtime 必须消费同一计划字段；配置只能扩大内置风险范围，不能降低 red/high 最低验证层。

## L0-L6 验证阶梯

| 层级 | 内容 | 默认时机 | 完成主张 |
| --- | --- | --- | --- |
| L0 | lint、typecheck、changed compile | 每次修改 | 不能证明行为 |
| L1 | Micro、Probe、单函数 | 实现过程中 | 仅局部不变量 |
| L2 | affected unit/component | 小步骤完成 | 轻量局部行为 |
| L3 | module/slice/contract | 子任务完成 | 模块行为 |
| L4 | affected integration | 任务完成 | 集成边界 |
| L5 | critical E2E | PR/高风险任务 | 关键用户链路 |
| L6 | full regression/matrix/eval | nightly/release | 完整回归 |

默认采用最小充分层级。禁止用低层通过掩盖高层失败，也禁止因“更保险”默认运行 L6。

## 计划与收据

Planner 至少输出 `minimumTier`、`scope`、`scopeConfidence`、`selectedMicroChecks`、`selectedChecks`、`deferredChecks`、`nextTier`、`escalation` 和成本字段。影响映射为 `complete`、`lower-bound` 或 `unknown`；后两者必须扩大验证范围。

Receipt 必须绑定工作树、计划、命令集合和环境指纹。异步深度验证使用 `queued → running → passed|failed|blocked|stale`，queued/running 不构成通过。

CLI 与安装运行时共用档位选择器，以命令和项目相对 `cwd` 去重。`validationCommands.tiers` 声明实际执行集合，`checks` 为稳定 ID、目录和确定性等元数据；`--only` 可选择稳定检查 ID，`--paths <项目相对路径...>` 冻结显式范围，`--base` 固定比较提交。`--plan` 不执行检查、不创建队列和收据。

聚焦入口先按变更选择相关检查，再按同一成本层解析结果筛选；显式命令归属优先于缺失层推导，显式空层保持禁用，未声明时沿用保守推导。文件级收窄继承原检查的成本层，不因命令重写而降到 quick。预览与执行收据记录同一实际执行集合、延迟检查、选择理由及升级方向；unknown 仍保留 high 风险回退。

收据核心写 schema v7（依赖指纹升级为 snapshot-local Merkle v2），外层引擎标识保留。完整运行收据仍写入被 Git 忽略的 `.vibe-harness/verification/receipts/`；`--reuse` 的检查级缓存写入 Git common dir 下 `vibe-harness/verification-cache/v7`。旧版收据仅作历史数据，不能作为当前自动命中。所有记录都以本机用户密钥认证，缓存只保存摘要，不保存 stdout、stderr 或环境明文。

默认 `verification.reuse.mode` 为 `workspace`，保持工作区指纹内的保守复用。显式 opt-in `tree-content` 后，检查键包含提交树、未提交/未跟踪内容、锁文件、真实依赖内容、验证命令、`cwd`、平台/架构、工具链版本、验证实现版本和完整继承环境摘要；旧 `envAllowlist` 不缩窄输入。候选 ID、绝对路径、namespace、端口与依赖模式仍绑定资源身份，不承诺不同候选环境命中。warm 与 shared-immutable 当前不进入 tree-content 自动复用。TTL 到期、记录不可读、认证失败、符号链接、worktree 歧义或工具链不可探测时一律 cache miss。

逐检查缓存与 `cacheScope` 决定复用粒度：

- `tree`：全仓 lint、typecheck、全量单测和后端全量检查；同一代码树内容可在不同 worktree/HEAD 间命中。
- `selection`：`*:changed`、`*:affected` 等依赖 base 或 `changedPaths` 的检查，默认值；额外绑定 base tree 与变更上下文，禁止跨基线复用。
- 每个检查独立 lookup/store；一个非确定性检查 miss 不影响其他已命中的确定性检查。只有全部选中检查都有有效证据才能形成整体通过。
- 执行过程中改动跟踪或未跟踪文件时，后续预计算命中失效并重新取快照；最终快照或写指纹不一致仍判为 `FINAL_SNAPSHOT_MISMATCH`。
- 未显式 `deterministic: true` 的检查不能自动复用。`backend-unit` 与 `backend-verify` 保持非确定性声明，直到同一代码内容上连续两次 clean、无缓存运行通过且树内容前后一致。

### 检查覆盖与选择报告

`validationCommands.checks[].subsumes` 表达同一 `cwd` 下高层检查覆盖低层检查。覆盖关系只能引用同一 `checks` 列表中的 ID，拒绝未知 ID、自引用、循环、跨 `cwd` 和低层覆盖高层。覆盖只裁剪默认 tier；`--only`、`--full` 与风险派生矩阵不裁剪。CLI 与 runtime 共用同一覆盖图实现。

计划和收据必须输出 `subsumedChecks`（含 ID 与 `subsumedBy`）、`subsumedBy` 以及逐检查 `selectionReasons`（被覆盖项为 `subsumed-by:<id>`），使选择结果可审计而不是静默消失。

### 重任务锁

重型验证不再用仓库级互斥锁串行化。候选验证在交付 FIFO 外运行，持有 Git common dir 下的候选活动租约（nonce、PID、心跳与 TTL），心跳持续续约，持有者退出或心跳过期后才可回收，不因等待时间长而强删活跃租约；被后续发布取代的候选收到协作 CANCEL sidecar，下一次轮询在检查之间中止，进程树终止后租约被强制释放。并发验证的资源争用以明确的失败原因报告，不以测试失败掩盖。

项目检查可在 stdout 或 stderr 输出一行 `[VIBE_HARNESS_CHECK] {"status":"not_applicable","reason":"..."}` 表示未执行适用验证，也可声明 `blocked` 或 `failed`；该协议不能把失败退出码提升为通过，后续跳过标记不能覆盖失败。所有检查均不适用时返回 unverified；部分检查跳过时记录覆盖缺口，不缓存整组通过。affected 范围确实没有变化时可无操作结束，但不产生通过收据。

`checks[].resources` 复用 Git common dir 具名锁；活持有者不按 TTL 抢占。相同完整输入且显式确定性的检查使用内容键预约，等待到最终快照校验与认证收据写入，再重新核验输入、查缓存；没有通过证据仍执行。非确定性或外部检查只排资源队列，`--no-reuse` 始终执行。默认 `verification.maxConcurrency = 1`，最大 8；只有连续声明 `parallel: true` 且有非空 `resources` 的检查可以有界并行，其余为顺序屏障。超时或输出越界保留资源占用，不把运行中检查当成通过。

### 范围与观测合同

验收行为、证据 L0-L6、执行 paths/base/scope、交付状态分别记录。外层入口 → planner → 原子检查单向调用，禁止原子检查回调包含自身的聚合器。下游范围优先级为显式参数 → `VIBE_HARNESS_VERIFY_PATHS/BASE/SCOPE` → 独立调用计算；无效或不完整上下文报错，未知/部分映射扩大；空选集不构成通过。

`timingsMs` 分别记录 preparation、scopeResolution、snapshotBefore/After、inputFingerprint、dependencyScan、coalescingWait、resourceWait、execution、cacheLookup 和 total；inputFingerprint 包含 dependencyScan，资源等待与执行为逐检查累计，不能相加冒充并发墙钟。`dependencyScan.before/after` 记录 entries、files、bytes、memoHits 与 durationMs：单次快照以真实路径去重并流式读取，前后快照各自重新读取。缓存报告分别指出禁用、非确定性、warm、共享依赖、依赖/配置/工具链不可用与无匹配收据。

候选准备与推送证明沿用 `proofTimingsMs` 分别记录 setup、verification、create/inspect。stage 只处理本地候选；publish 已在终锁前精确读取远端基线和重建隔离候选，终锁内再次对账，不新增全局调度器、不同步脏主检出。任务恢复使用现有 `task status --output summary`；状态回写与清理重试不重放合并/推送。

### 兼容与迁移

- 未配置档位沿用旧插槽和项目根脚本推导，显式 `[]` 不补回该层命令。子目录有 `pom.xml` 不代表根目录可执行 Maven；项目应为 Wrapper 命令配置 `checks[].cwd`。
- `cwd` 只能指向项目内实际存在的目录；父目录、绝对路径和指向项目外的符号链接均拒绝。Windows 项目可声明 `mvnw.cmd test`；其他平台使用 `./mvnw test`，工作目录均由同一元数据绑定。
- `checks` 仅带 ID 时必须能关联命令，关联失败视为配置错误；`--only` 保留旧插槽兼容，但不会靠显示名称去重。计划仍区分成本、影响范围和行为证据，命令通过不表示所有层已验收。
- 新安装与升级必须同时安装运行入口、`verification-plan.mjs`、`verification-receipt.mjs` 及其依赖。先在临时项目验证 dry-run、新安装、升级和用户文件拒写，再迁移业务项目；不使用全目录覆盖或 `--force` 绕过漂移。
- 收据仓库必须已被 Git 忽略，否则本轮执行仍可产出报告但不会落盘缓存。命令目录中的锁文件、项目配置、工具版本和环境身份只以摘要绑定；版本探测不可用时拒绝复用。
- 同一状态后续执行失败会清除对应旧通过缓存。旧回执可用于历史展示，不能进入 v7 跨引擎复用；回滚时成套还原配置、运行入口和共享模块，移除 `tree-content`/`subsumes` 后回到声明的必需矩阵，重新验证，不将旧版收据升格为当前通过证据。

## 环境与回滚

CI 与发布默认 cold，warm 必须由项目在 `verification.environment` 显式声明（mode、provider、start、health、stop、reuseKey、ttlMs、fallback），并按 worktree 隔离；失败按声明回退 cold 或 blocked。

本地任务与会话内默认复用已就绪的环境、服务进程、缓存、索引与容器，不重复冷启动。复用契约：隔离键由 worktree、配置与 fixture、reuseKey 组成，同一键只保留一个实例，并发写入者不共享实例；健康检查通过且未超过 TTL 才可复用，配置、依赖、fixture、镜像、工具链或工作树身份变化、健康检查失败或 TTL 到期即失效并按声明回退。容器按会话或任务级托管回收，用例级临时资源仍在用例结束时清理。

运行器当前只消费上述声明并记录 `environment` 状态，不代为执行 start/health/stop；生命周期执行由项目或宿主提供的 provider 承担，未接线时不得宣称运行器已具备自动起停。

灰度期间保持旧 `layer` 默认语义，Micro、warm、async 和 affected 均显式 opt-in，可回滚但不得回滚安全边界、unknown 扩大和快照稳定性检查。
