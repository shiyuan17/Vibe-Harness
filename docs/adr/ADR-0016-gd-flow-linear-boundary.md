---
id: ADR-0016
title: gd-flow 移除 Linear 访问禁令
status: accepted
date: 2026-10-13
review-date: 2026-11-10
owner: vibe-harness-maintainers
decision-makers: [vibe-harness-maintainers]
consulted: []
informed: []
supersedes: []
superseded-by: null
---

# gd-flow 移除 Linear 访问禁令

## Context and Problem Statement

ADR-0015 把 `gd-flow` 固化为显式本地交付入口，并把「不访问 Linear、不扫描任务队列」和 `Git-only` 标签一同写成该入口的边界。这条禁令超出交付语义：它约束的不是交付动作（不创建 PR/MR、不改项目默认 delivery），而是本轮任务能不能使用调用方已授权的 Linear 上下文。Linear 写入本来已经由 `governance-core.md` 的授权与 Execution Envelope 以及 `linear-workflow.md` 的状态与凭据边界约束，重复的入口级禁令只带来两处副作用：显式调用 `gd-flow` 的会话即使持有合法 Linear 上下文也无法使用；description 与规则节里的否定表述同时进入宿主路由面，扩大会被误读为「本入口不得触碰 Linear」的范围。

## Decision Drivers

- 边界只约束交付动作：`gd-flow` 的合同是 worktree → `develop` 本地 land → 推送清理，不创建 PR/MR、不改默认 delivery。
- 不复制既有约束：Linear 读写已有 `governance-core.md` 的授权根与 `linear-workflow.md` 的状态、凭据、Claim 边界，入口不再叠加一层禁令。
- 路由面最小化：description 只保留触发条件与交付动作边界，减少宿主对显式入口范围的误判。

## Considered Options

- 保留禁令并加密措辞：维持 `gd-flow` 完全不碰 Linear。否决，与调用方已授权的 Linear 上下文冲突，且与 `lwflow` 的差别本就是「是否按会话计划同步 Parent/DAG」，不是「能否访问 Linear」。
- 删除禁令并把 Linear 归属写进 `gd-flow`：在 `gd-flow` 内新增 Linear 范围条款。否决，会让同一件事出现两个规范来源，破坏「`linear-workflow.md` 是 Linear 边界唯一来源」的分工。
- 只删除禁令表述、不新增 Linear 条款：移除入口级禁令，Linear 访问回到授权与 `linear-workflow.md` 的既有边界。采纳。

## Decision Outcome

选定方案：**只删除禁令表述、不新增 Linear 条款**。具体改动为四处同步：`skills/core/gd-flow/SKILL.md` 的 description 去掉 `never access Linear`、正文去掉「不访问 Linear、不扫描任务队列」与 `Git-only` 标签（`.agents/skills/gd-flow/SKILL.md` 镜像同步）；`docs/rules/git-rules.md` 的「显式 develop flow」节把「`gd-flow` 不访问 Linear、不扫描任务队列、不创建 PR/MR」收紧为「`gd-flow` 不创建 PR/MR」；`docs/rules/agent-skill-routing.md` 的路由句把 `Git-only` 改为「显式本地交付」。显式触发、不创建 PR/MR、不改默认 delivery、fail-closed 停止、`--delivery local-land` 只用本轮等边界全部保留；`lwflow` 与 `linear-workflow.md` 不改。本条目修订 ADR-0015 的一处入口边界，不替代其决策主体（两个显式 develop flow 及其 parity 契约继续有效），ADR-0015 按历史决策保持原文。

## Consequences

- 正面：显式调用 `gd-flow` 的会话可以使用调用方已授权的 Linear 上下文；Linear 写入仍受授权、Envelope 与 `linear-workflow.md` 约束，安全边界不降低。
- 正面：路由面减少一处否定表述，`gd-flow` 与 `lwflow` 的分工回到「是否按会话计划同步 Parent/DAG」，更容易被宿主正确判别。
- 取舍：`gd-flow` 的 Linear 行为不再由入口自身声明，可读性依赖调用方理解「Linear 边界在 `linear-workflow.md`」；rule–skill parity 的共享措辞（`` `gd-flow` ``、`local-land`、`origin/develop`）不变，因此本次改动不需要调整 parity 映射表。
- 取舍：`docs/rules/git-rules.md`、`skills/core/gd-flow/**` 与 `.agents/skills/gd-flow/**` 内容变化会使 eval reference 的 rules 与 skills 分组指纹按设计漂移，需按 CONTRIBUTING 的 reference 清单单独审查后再生。

## Confirmation

锁定位置：`skills/core/gd-flow/SKILL.md`（与 `.agents/skills/gd-flow/SKILL.md` 字节一致，由 `tests/component/self-install-check.test.js` 复核）、`docs/rules/git-rules.md` 的「显式 develop flow」（`scripts/lib/pack-validation.js` 的 parity 共享措辞 `` `gd-flow` ``、`local-land`、`origin/develop`，`tests/component/rule-skill-parity.test.js` 锁定双向引用与 `修改须同步`）、`docs/rules/agent-skill-routing.md` 的路由句。Eval：`evals/suites/linear-workflow-online.json` 的 `EVAL-LINEAR-040` 仍断言未请求 Linear 工作时不产生 Linear 写入与变更请求，`EVAL-LINEAR-041` 仍断言普通提交不触发该 flow。

## Review Trigger

- 出现隐式触发：未被显式点名也进入 `gd-flow`，或普通提交、普通 Linear 请求被误导向该模式。
- `gd-flow` 在未取得 Linear 授权时写入 Linear（此时应改为恢复入口级禁令或补 Claim 边界）。
- `gd-flow` 与 `lwflow` 的交付边界再次调整（PR/MR 语义、`--delivery local-land` 覆盖范围、默认 delivery 或 profile 计数）。

## More Information

实现位于 `skills/core/gd-flow/`、`docs/rules/git-rules.md`、`docs/rules/agent-skill-routing.md`；镜像与契约见 `.agents/skills/gd-flow/`、`scripts/lib/pack-validation.js`。相关决策：ADR-0015 新增两个显式 develop flow（本条目只删除其中 `gd-flow` 的 Linear 禁令），ADR-0013 定义 develop 无服务端门禁的本地直落，ADR-0011 定义交付生命周期与受管服务归属。
