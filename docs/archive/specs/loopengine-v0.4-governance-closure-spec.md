# LoopEngine v0.4 治理闭环规格

状态：Superseded。本文的阶段模型与 JSON task 合同已由 [v0.5 中文精简治理规格](../../specs/cognis-v0.5-simplified-governance-spec.md) 取代；本文只记录 v0.4 实施历史。

## 目标

消除 LoopEngine 当前治理契约的多源歧义，并把任务验收、审查结论和项目验证从 Markdown 要求提升为可自动检查的门禁。

## 非目标

- 不删除或重命名现有 MVP、legacy/internal 命令。
- 不改变 `validate --project` 的只读安装一致性检查语义。
- 不自动执行未经用户显式请求的目标项目命令。
- 本规格当时只定义 Codex；当前 Claude/Gemini 项目级 adapter 以 `manifests/adapters.json` 和 `docs/architecture.md` 为准，仍不得写入全局 Agent 配置。

## 命令契约

| 生命周期 | 目标路径参数 | 预览 | 真实写入 |
| --- | --- | --- | --- |
| MVP | `--project <path> --target codex` | `--dry-run` | `--write` |
| legacy/internal | `--target <path>` | `--dry-run` | `--apply`；红区另需 `--confirm-red-zone` |
| legacy rollback | `--target <path>` | 默认或 `--dry-run` | `--apply`；红区另需 `--confirm-red-zone` |

新增 `loopengine verify --project <path>`。该命令读取 `loopengine.config.json`，先完成现有项目安装一致性校验，再按 `governance`、`lint`、`typecheck` 顺序执行已配置且可执行的验证命令。`not_configured` 项跳过；`missing` 和执行失败必须返回非零退出码；`manual` 命令只有显式传入 `--allow-manual` 才执行，否则阻断并报告。输出必须包含每个命令、状态、退出码和结果摘要。

## 工作流契约

标准生命周期使用九个阶段：`Clarify`、`Spec`、`Plan`、`Task`、`Execute`、`Verify`、`Review`、`Handoff`、`Retrospective`。`Intake` 是进入生命周期前的入口门禁，不计入九阶段。

每个阶段必须声明目标、输入、输出、责任角色、准入条件、完成标准、常见异常和回退阶段。快速档可合并产物，但不得跳过事实收集、验证、红区确认或交付证据。

## 任务与证据契约

任务新增 `acceptanceEvidence`，每项包含：

- `criterionId`：验收标准的稳定 ID。
- `evidenceType`：`command`、`artifact`、`manual` 或 `review`。
- `summary`：实际观察结果。
- `command` 和 `exitCode`：命令型证据必填。
- `artifact`：产物型证据必填，必须为项目内相对路径。
- `verifiedAt`：本轮验证时间。
- `verifier`：证据核验者。

`resolution=done` 时，每条验收标准必须使用对象形式 `{ id, statement }` 并恰好至少有一条同 ID 证据；任务还必须声明 `ownerRole`、`risk`、`parallelSafety`、`humanConfirmation` 和 `verifier`。高风险任务的 verifier 不得是 `implementation-agent`。旧的字符串验收标准继续允许用于未完成任务，保证已有开放任务兼容。

parent/child 任务必须声明 owner、依赖、并行安全和 merge-back 状态。固定“5 分钟”改为任务声明的 `timeboxMinutes`；超时不表示失败，但必须产生阻塞原因、证据和下一步动作。

## Review 契约

- `Critical`、`High` 未处理时阻断。
- `Medium` 必须修复，或记录 `deferredFindings`，其中包含 finding ID、理由、owner、关闭条件和批准者。
- `Low` 可不阻断，但必须保留在剩余风险中。
- Full 或高风险任务需要独立 reviewer；实现者不能批准自己的最终结果。

## 异常与持续改进

新增 Failure/Bug Report 和 Retrospective 模板。失败记录必须包含类型、复现、最近可用状态、退出码、重试预算、恢复 checkpoint、升级 owner 和下一步安全动作。复盘改进项必须有 ID、owner、完成标准和防复发验证，不能只写经验总结。

## 自动化与 CI

- Pack validation 除关键词存在外，必须检查命令契约、九阶段口径、Review Medium 延期规则和新增模板安装映射。
- Governance runtime 必须校验任务完成证据映射、责任角色、独立核验和 merge-back。
- CI 在 Node 20 和 pnpm 10 上运行 `pnpm check`、`git diff --check`，并在临时目录执行 MVP 与 legacy/internal 两套 smoke。

## 完成标准

- 根贡献指南不再混用 `--write` 与 `--apply`。
- README、架构、规格、规则和模板统一使用九阶段口径。
- 无 AC 证据映射、缺 owner/verifier、未批准 Medium 延期的完成包会被 validator 拒绝。
- `verify --project` 能执行真实目标项目检查并正确传播失败退出码。
- CI 和本地必跑命令覆盖两套安装生命周期。
- `pnpm test`、`pnpm check` 和 AGENTS.md 所列 smoke 全部通过。
