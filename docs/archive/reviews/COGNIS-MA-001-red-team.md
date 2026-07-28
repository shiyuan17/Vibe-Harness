状态：Completed

# COGNIS-MA-001 Red Team 审查包

- 任务编号：COGNIS-MA-001
- 审查者：独立核验者
- 审查对象：Cognis 父子任务多 Agent 治理闭环当前工作区 diff（基线 `c1b64d4`）
- 审查时间：2026-07-19T23:51:46.1501756+08:00
- 状态：批准

## 审查范围

| 审查轴 | 覆盖内容 | 状态 |
| --- | --- | --- |
| 契约与兼容 | v1/v2 schema、single/parent/child 变体、固定 child 输出 | 通过 |
| 任务图与完成门禁 | 父子关系、批次、依赖、冲突、写入范围、集成证据、独立审查 | 通过 |
| 安装与运行表面 | doctor warning、profile/install map、Codex SubagentStart/Stop | 已核对 |
| 文档与评测 | v0.6 规格、catalog、迁移、双语 README、capability、offline eval | 已核对 |
| 发布与回滚 | upgrade/rollback/uninstall 影响、用户既有 hook notes 清理保护 | 聚焦测试与静态核对 |

本审查首次执行时，reviewer 曾错误派生 `standards_axis` 和 `spec_axis`，形成被 v0.6 禁止的孙任务。主 Agent 随即要求中断，两个后代输出均未被采信；本报告结论来自 `/root` 直接 reviewer 随后从头进行的独立只读审查。

## 问题列表

| 问题编号 | 严重度 | 状态 | 位置 | 触发方式 | 影响 | 最小修复方向 |
| --- | --- | --- | --- | --- | --- | --- |
| RT-MA-001 | High | 已修复 | `schemas/full-task-control.schema.json`、`docs/schemas/full-task-control.schema.json` | 重放无 `控制版本` 且重复 child 输出字段的 v1 合同 | v1 兼容合同继续通过，v2 child 仍受固定输出约束 | v2-only `uniqueItems` 已移入 v2 child 分支，并由差分兼容测试覆盖 |
| RT-MA-002 | High | 已修复 | `runtime/governance/lib/task-validation.mjs`、`runtime/governance/lib/task-graph-validation.mjs` | 重放 `src//shared.js`、反斜杠和大小写等价范围 | 等价目标不能绕过同批写入冲突门禁 | 语义层拒绝空路径段，图校验统一 canonicalize 分隔符和大小写 |
| RT-MA-003 | High | 已修复 | `runtime/governance/lib/task-graph-validation.mjs` | parent 使用早于 completed child 证据的历史集成命令记录 | 旧证据不能替代 fan-in 后目标工作区复验 | 集成证据必须不早于最新 completed child 证据，并有正反例测试 |
| RT-MA-004 | Medium | 已修复 | `runtime/governance/lib/task-graph-validation.mjs` | v2 single 引用不存在依赖或冲突节点 | 所有 v2 节点均执行引用存在、依赖无环和冲突对称校验 | 图级检查已提升到全部 v2 节点，并增加 single 反例 |

## Finding 责任与关闭条件

| 问题编号 | Owner | 关闭条件 |
| --- | --- | --- |
| RT-MA-001 | 实现负责人 | 已关闭：v1 差分兼容和 v2 固定输出测试通过 |
| RT-MA-002 | 实现负责人 | 已关闭：重复分隔符和等价路径反例测试通过 |
| RT-MA-003 | 实现负责人 | 已关闭：历史证据被拒绝、fan-in 后证据被接受 |
| RT-MA-004 | 实现负责人 | 已关闭：所有 v2 节点的未知引用与冲突反例被拒绝 |

## Medium 延期

| 问题编号 | 理由 | 责任人 | 关闭条件 | 批准者 |
| --- | --- | --- | --- | --- |

## 已核验证据

- `pnpm check`：退出码 0；385 pass、0 fail、2 skip。
- `pnpm docs:audit`：退出码 0；28 documents checked。
- `pnpm eval:check`、`pnpm eval:offline`：退出码 0；offline critical pass rate 与 overall score 均为 1。
- `pnpm skills:audit`：退出码 0；18 个 Skill，图审计通过。
- `pnpm test:integration`：退出码 0；97 pass、0 fail、1 skip。
- `pnpm smoke:lifecycle`：退出码 0；core/full init、dry-run、write、validate 及 full doctor 全部通过。
- `git diff --check`：退出码 0，仅有 CRLF 提示。
- 反例 RT-MA-001 至 RT-MA-004 均已纳入 `tests/multi-agent-governance.test.js`，并随完整 `pnpm check` 通过。
- hook 静态与测试证据确认 `SubagentStart`/`SubagentStop` 仅返回上下文或消息，不包含阻断 `decision`；full 才安装 Skill 与 Codex hook，core 安装 schema/runtime，minimal/docs-only 分层与安装测试一致。
- `.codex/hooks.json`、`adapters/codex/hooks.template.json`、`tests/codex-adapter.test.js` 的既有 `notes` 清理未被本审查修改。

## 未覆盖审查轴与剩余风险

- 未执行真实在线 Agent/provider eval；checked-in offline replay 证明合同资产一致性，但不能证明模型在真实调度中遵守行为。
- 未在独立 Linux 主机复跑 POSIX lifecycle；本轮使用 Windows，完整仓库测试覆盖跨平台 adapter 的模拟/临时项目路径。
- `pnpm smoke:lifecycle` 已覆盖 core/full 临时项目生命周期；未另外保留两套手工命令的临时目录产物。
- 本审查过程早期曾发生一次违规再委派；后代输出已中断且未采信，最终结论来自当前独立核验者对修复后 diff 和新鲜命令证据的直接检查。

## 结论

批准
