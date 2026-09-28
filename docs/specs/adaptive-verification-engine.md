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

收据核心写 v3、兼容读取旧收据，外层引擎标识保留。`--reuse` 从被 Git 忽略的 `.vibe-harness/verification/receipts/` 查找，不要求任务锚点；只复用显式 `deterministic: true`、快照一致且全部选中检查实际通过的结果。代码、配置、锁文件、工具链、环境、工作区或验证实现变化均使缓存失效；旧收据和未证明的 warm 环境不进入此复用路径。缓存只保存摘要，不保存 stdout、stderr 或环境值。

项目检查可在 stdout 或 stderr 输出一行 `[VIBE_HARNESS_CHECK] {"status":"not_applicable","reason":"..."}` 表示未执行适用验证，也可声明 `blocked` 或 `failed`；该协议不能把失败退出码提升为通过，后续跳过标记不能覆盖失败。所有检查均不适用时返回 unverified；部分检查跳过时记录覆盖缺口，不缓存整组通过。affected 范围确实没有变化时可无操作结束，但不产生通过收据。

### 兼容与迁移

- 未配置档位沿用旧插槽和项目根脚本推导，显式 `[]` 不补回该层命令。子目录有 `pom.xml` 不代表根目录可执行 Maven；项目应为 Wrapper 命令配置 `checks[].cwd`。
- `cwd` 只能指向项目内实际存在的目录；父目录、绝对路径和指向项目外的符号链接均拒绝。Windows 项目可声明 `mvnw.cmd test`；其他平台使用 `./mvnw test`，工作目录均由同一元数据绑定。
- `checks` 仅带 ID 时必须能关联命令，关联失败视为配置错误；`--only` 保留旧插槽兼容，但不会靠显示名称去重。计划仍区分成本、影响范围和行为证据，命令通过不表示所有层已验收。
- 新安装与升级必须同时安装运行入口、`verification-plan.mjs`、`verification-receipt.mjs` 及其依赖。先在临时项目验证 dry-run、新安装、升级和用户文件拒写，再迁移业务项目；不使用全目录覆盖或 `--force` 绕过漂移。
- 收据仓库必须已被 Git 忽略，否则本轮执行仍可产出报告但不会落盘缓存。命令目录中的锁文件、项目配置、工具版本和环境身份只以摘要绑定；版本探测不可用时拒绝复用。
- 同一状态后续执行失败会清除对应旧通过缓存。旧 v2 收据可用于历史展示，不能进入 v3 跨引擎复用；回滚时成套还原配置、运行入口和共享模块，停用新缓存并重新验证，不将 v3 降格为旧版通过证据。

## 环境与回滚

CI 与发布默认 cold，warm 必须由项目在 `verification.environment` 显式声明（mode、provider、start、health、stop、reuseKey、ttlMs、fallback），并按 worktree 隔离；失败按声明回退 cold 或 blocked。

本地任务与会话内默认复用已就绪的环境、服务进程、缓存、索引与容器，不重复冷启动。复用契约：隔离键由 worktree、配置与 fixture、reuseKey 组成，同一键只保留一个实例，并发写入者不共享实例；健康检查通过且未超过 TTL 才可复用，配置、依赖、fixture、镜像、工具链或工作树身份变化、健康检查失败或 TTL 到期即失效并按声明回退。容器按会话或任务级托管回收，用例级临时资源仍在用例结束时清理。

运行器当前只消费上述声明并记录 `environment` 状态，不代为执行 start/health/stop；生命周期执行由项目或宿主提供的 provider 承担，未接线时不得宣称运行器已具备自动起停。

灰度期间保持旧 `layer` 默认语义，Micro、warm、async 和 affected 均显式 opt-in，可回滚但不得回滚安全边界、unknown 扩大和快照稳定性检查。
