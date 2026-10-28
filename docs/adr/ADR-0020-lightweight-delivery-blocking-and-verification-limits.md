---
id: ADR-0020
title: 轻量交付边界、三档阻塞与验证执行时限
status: superseded
date: 2026-10-24
review-date: 2027-04-24
owner: vibe-harness-maintainers
decision-makers: [vibe-harness-maintainers]
consulted: [vibe-harness-contributors]
informed: [linear-workflow-users]
supersedes: [ADR-0017, ADR-0019]
superseded-by: ADR-0021
---

# 轻量交付边界、三档阻塞与验证执行时限

## Context and Problem Statement

显式授权的普通单 Agent 任务被安装审计、重复验证、主检出无关改动、
清理残留、临时 Linear 故障和泛化的墙钟预算反复阻塞。现有规则还把
任务选择、验证执行和清理完成混成同一交付门禁，导致已经确认推送的
代码仍无法映射 Done，或简单任务为未使用的并行估算付出流程成本。

本决策取代 ADR-0017 中“宿主 worktree 优先”的活动冲突条款，以及
ADR-0019 中 Phase 2 锁覆盖清理、全局恢复默认可写和验证耗时参与任务
预算的活动冲突条款；旧 ADR 历史正文保留。

## Decision Drivers

- 安全边界不能因追求短路径而放宽。
- 已经取得代码集成证据时，资源清理不应否定该集成事实。
- 验证执行时限必须可观察、可重试且不能冒充产品失败。
- 普通单 Agent 任务不应承担 DAG、Claim、Receipt、独立审查或多 Agent
  调度成本。
- 规则、运行时、模板和安装投影必须表达同一状态机。

## Considered Options

- 继续用单一 `blocked/failed` 枚举承载安全、交付、环境和产品失败：
  拒绝，调用方无法判断应当停止、补证还是只重试环境动作。
- 用预计完成时间决定是否中止验证：拒绝，估算不是可观察的执行事实。
- 分离安全阻塞、交付阻塞与执行受阻，并把验证预算限定为显式墙钟上限：
  采纳。

## Decision Outcome

### 三档边界

- **安全阻塞**：缺少授权、凭据、生产或红区授权、不可逆操作依据或
  跨边界证据时，只停止相关动作。
- **交付阻塞**：缺少与完成主张匹配的证据，或主检出无法安全落地时，
  只阻止 land 和该节点 Done。
- **执行受阻**：超时、网络、缺工具、主检出脏、Linear 暂不可用或清理
  残留时记录现场；不阻止无依赖的后续工作。

主检出脏只阻止 land；`integrated_cleanup_pending` 不阻止 Done 或
依赖后继；超时不是产品失败；普通任务不要求 DAG、Receipt、Claim、
Start/Terminal 事件或独立审查；`--reviewed` 只是验证相关性元数据，
不是 land 门禁。

### 状态与职责

真实断言或命令失败为 `failed`；超时、环境、权限、网络和项目显式
验证硬上限为 `blocked`；运行中工作区变化为 `stale` 或
`unverified`；推送已确认但清理未完成为
`integrated_cleanup_pending`。

`governance-core` 只定义授权、风险、三档边界、状态与恢复原则；
`git-rules` 定义 Git 交付合同；`test-rules` 定义检查选择、超时、复用
和证据语义；`linear-workflow` 定义显式 Issue、Done 映射和同步降级；
`ai-collab-rules` 只在真实多 Agent 协作时加载。核心 Skill 只保留入口、
顺序、停止边界和规则链接。

### 验证执行

`vibe-harness verify` 只执行项目验证计划，不再隐式执行安装 diff 或
Vibe-Harness 整包审计。安装一致性由 `validate` 负责，本仓包审计由
`pnpm check` 负责。

每项检查默认使用 `verification.timeoutMs`，检查声明可用
`validationCommands.checks[].timeoutMs` 单独覆盖该项预算。项目显式配置
`verification.budgetMs` 时，预算从第一项命令开始计算整轮实际墙钟
上限；每项等待上限为 `min(检查 timeoutMs, 剩余 budgetMs)`。未配置时
没有隐式整轮截止。超时返回 `blocked`，记录已耗时、未执行检查与手工
重试入口，且不自动重跑。任务耗时估算只用于选择 single/parallel，不
用于中止任务或验证。

同一 workspace、计划与内容指纹且之后无写入时，普通验证默认复用通过
收据；`--no-reuse` 强制重跑。验证前 checkpoint 是 best-effort，
失败只告警；验证结束再尝试刷新一次，但不重跑验证。

### Git 最终化与恢复

local-land 固定使用 bootstrap 登记的 worktree，并先合并到主检出本地
`develop`，再推送 `origin/develop`。最终化器在目标锁内只做基线复核、
本地 ff-only、精确 refspec 推送和远端 SHA 回读；推送确认后立即释放
锁，再执行锁外、有限时限的清理。清理超时或失败返回
`integrated_cleanup_pending` 和成功退出码；重试只清理，不重放合并或
推送。残留资源继续占用。`--target-mode remote` 在任何写入前拒绝。

恢复默认限域：`recover --task <id>` 只处理目标任务；
无选择器的 `recover --write` 拒绝，全局写入必须显式 `recover --all
--write`。主检出 preflight 返回分支、HEAD、前 50 项改动、截断标志和
不自动删除或暂存用户改动的建议。

### 任务拆分

验收切片按可观察增量划分，单 Agent 顺序任务也可拆分。已有 Linear DAG
必须遵循；普通固定步骤不强制生成 DAG。多 Agent 并行只在至少两个
ready 单元、隔离成立、真实容量可用且净节省同时达到 45 分钟和 25% 时
启用。默认上限为两个写 Agent、四个读 Agent，并受宿主总槽位限制。
容量和收益公式只放在 task-decomposition 的按需 reference 中。

## Consequences

- 安装漂移不再阻止普通验证，但 `validate`、CI 和发布门禁仍需单独执行。
- 未配置整轮预算的任务不会因历史耗时或估算被中止；失控检查仍受每项
  `timeoutMs` 约束。
- 推送后清理失败可见但不否定集成，节点可以 Done，后继可以推进，残留
  资源仍不可复用。
- `--reviewed` 不能替代真实验证，也不再是 local-land 前置条件。
- 全局恢复需要显式扩大作用域，降低误清理其他任务现场的风险。

## Confirmation

- Git 集成测试断言单任务与 batch 在远端接收推送时本地 `develop` 已
  等于候选，并覆盖错误 push URL/refspec/mirror、脏主检出、基线前进、
  推送失败或不明、远端分叉、锁内最终化与锁外清理。
- 验证测试断言普通 verify 不触发安装或整包审计；真实失败为 `failed`，
  超时与环境受阻为 `blocked`，运行中变化为 stale；默认复用和
  `--no-reuse` 生效；只有显式 budget 存在整轮截止。
- 规则正反例覆盖显式触发、不抢单、不要求 Claim/Receipt、主检出脏只
  阻止 land、Linear 未同步不阻止本地工作、清理 pending 可 Done、普通
  任务不建 DAG、`--reviewed` 不阻塞。
- 恢复测试覆盖 `recover --task` 的限域行为、无选择器写操作拒绝与
  `recover --all --write` 显式全局授权。

## Review Trigger

- 再次出现因安装审计、重复验证、无关脏工作区、清理残留或临时 Linear
  故障阻塞普通任务。
- 验证执行时限与完成主张再次混用，或引入未显式配置的整轮预算。
- worktree 最终化顺序、清理锁范围或恢复作用域发生变化。

## More Information

运行时实现位于 `scripts/vibe-harness.js`、`scripts/lib/project-verification.js`、
`runtime/lib/verification-command.mjs`、`runtime/lib/worktree-command.mjs`
和 `runtime/lib/delivery.mjs`。规则入口见
[治理内核](../rules/governance-core.md)、[Git 规则](../rules/git-rules.md)、
[测试规则](../rules/test-rules.md)与 [Linear 工作流](../rules/linear-workflow.md)。
