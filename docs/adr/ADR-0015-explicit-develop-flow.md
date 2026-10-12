---
id: ADR-0015
title: 显式 develop flow（gd-flow 与 lwflow）
status: accepted
date: 2026-10-12
review-date: 2026-11-09
owner: vibe-harness-maintainers
decision-makers: [vibe-harness-maintainers]
consulted: []
informed: []
supersedes: []
superseded-by: null
---

# 显式 develop flow（gd-flow 与 lwflow）

## Context and Problem Statement

ADR-0013 允许 develop 接受本地直落（不经服务端门禁），ADR-0011 定义了证据绑定的交付生命周期与受管服务归属模型；两者的默认入口仍是通用交付，即优先走 PR/MR 的 `$git-deliver`。但存在一类反复出现的任务：只做 Git（worktree → develop 本地 land → 推送清理），或先按当前会话已确定的计划在 Linear 建立 Parent/DAG 再逐节点本地 land。此前这类任务只能靠临时组合既有命令与规则，缺少一个「只由显式调用触发」的固化入口：既没有稳定的路由信号，也没有可被 parity、预算与 Eval 锁定的契约，实施细节随会话漂移。本决策新增两个显式 Skill 作为该入口，并把边界写进规则与 Eval，使其可验证、可复核。

## Decision Drivers

- 默认交付不变：不得隐式改变既有交付语义、project 默认 delivery 配置或普通 PR/MR 路径。
- 显式触发：只在用户显式点名 `gd-flow` / `$gd-flow` 或 `lwflow` / `$lwflow` 时进入，不依赖自动识别或任务外观推断。
- fail-closed 停止：`lwflow` 缺可写 Linear connector、宿主必需的 v2 执行证明或持久原子 Claim 时停止，不伪造同步、不伪造领取。
- 与 `$git-deliver` 不重叠：两个 Skill 都不创建 PR/MR、不切换项目默认交付模式；`--delivery local-land` 只覆盖本轮。
- 可逆：入口由规则节与 Skill 文件承载，可整体移除而不触及 runtime 命令面。

## Considered Options

- 扩展 `$git-deliver`：在既有交付 Skill 内增加 develop 本地直落分支。否决，普通交付会被误导向 land，默认路径的语义随调用方意图漂移。
- 新增终端命令：把两种 flow 固化成 runtime 子命令。否决，扩大 runtime 与安装面，且与既有 worktree/delivery 命令职责重叠。
- 新增两个显式 Skill：`gd-flow`（Git-only 本地落地）与 `lwflow`（Linear 计划 + 本地落地）。采纳。

## Decision Outcome

选定方案：**新增两个显式 Skill**。理由是它们把「本轮只走 Git」与「本轮按会话计划走 Linear 并本地落地」表达为可被规则、parity 与 Eval 直接引用的命名入口，触发条件写在 description 与路由规则里，因而是显式且可审计的；同时它们不引入新的 runtime 命令，默认交付与 `$git-deliver` 保持原样。两个 Skill 与规则侧 `docs/rules/git-rules.md` 的「显式 develop flow」、`docs/rules/linear-workflow.md` 的「显式 lwflow」一一对应，纳入既有 rule–skill parity 契约。

## Consequences

- 正面：`core` 原生 Skill 计数 10→11（新增 `gd-flow`），`full` 13→14，integration Skill 3→4（新增 `lwflow`）；native Skill name/description 预算 2000→2200 字符；rule–skill parity 映射表新增两对（共七对）。
- 正面：land 只在显式调用内临时使用 `--delivery local-land`，项目默认 delivery 配置与普通 PR/MR Done 判据不变。
- 取舍：skill routing 面扩大，显式调用的可发现性依赖 native description 预算与 `docs/rules/agent-skill-routing.md` 的措辞。
- 取舍：parity 契约新增两对，规则节或对应 SKILL.md 单侧改动即触发校验失败，必须同步。

## Confirmation

规则侧：`docs/rules/git-rules.md` 的「显式 develop flow」与 `docs/rules/linear-workflow.md` 的「显式 lwflow」。Skill 侧：`skills/core/gd-flow/SKILL.md`、`skills/integrations/lwflow/SKILL.md`。契约：`tests/component/rule-skill-parity.test.js` 锁定七对常驻配对的映射表，并断言双向引用、`修改须同步` 声明与共享措辞。路由与计数：`docs/rules/agent-skill-routing.md`、`manifests/skills.json`、`manifests/profiles.json`，以及 `scripts/lib/pack-validation.js` 的 native 计数与 2200 字符 description 预算断言。Eval：`evals/suites/linear-workflow-online.json` 的 `EVAL-LINEAR-039`（lwflow 路由）、`EVAL-LINEAR-040`/`EVAL-LINEAR-041`（gd-flow 路由与边界）、`EVAL-LINEAR-042`（lwflow 隔离边界）。

## Review Trigger

- 出现隐式触发：未被显式点名也进入 `gd-flow` / `lwflow`，或普通提交、普通 Linear 请求被误导向该模式。
- land 或 `--delivery` 语义变化（例如默认交付改为本地直落、`local-land` 不再只覆盖本轮）。
- profile 计数或 rule–skill parity 契约调整（新增/移除配对、改变预算阈值）。

## More Information

实现位于 `skills/core/gd-flow/`、`skills/integrations/lwflow/` 与规则 `docs/rules/git-rules.md`、`docs/rules/linear-workflow.md`；路由说明见 `docs/rules/agent-skill-routing.md`，与 `$git-deliver` 的边界见 `skills/core/git-deliver/SKILL.md`。相关决策：ADR-0013 定义 develop 无服务端门禁的本地直落，ADR-0011 定义交付生命周期与受管服务归属；本条目只新增显式入口，不替换或收紧既有路径。
