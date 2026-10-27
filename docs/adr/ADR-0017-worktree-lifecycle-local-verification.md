---
id: ADR-0017
title: worktree 生命周期门禁收敛：宿主 worktree 优先与本地核验授权
status: superseded
date: 2026-10-15
owner: vibe-harness-maintainers
decision-makers: [vibe-harness-maintainers]
consulted: []
informed: []
supersedes: []
superseded-by: ADR-0020
---

# worktree 生命周期门禁收敛：宿主 worktree 优先与本地核验授权

## Context and Problem Statement

`docs/rules/git-rules.md` 的「显式 develop flow」与 `skills/core/vb-git-develop-flow/SKILL.md` 此前把「worktree 拓扑变化」与 hostWrite、externalWrite 并列，要求先具备宿主注入的 `vibe-harness.execution-envelope/v2` 与 hostContext（source=host、process=isolated、network、observedAt）。真实 Codex 宿主不注入这些字段，而 `governance-core.md` 的「能力受阻」又不允许通过重复询问用户解除，于是 Agent 在创建隔离 worktree 之前就判定缺少宿主隔离核验并停止整个请求——对应会话 `codex://threads/01a13d2a-479e-7f93-a604-520d9871d9d4` 中「无法正常创建 worktree」的现象。

runtime 侧从来没有这道门禁：`runtime/commands/run.mjs worktree <bootstrap|land|list|check|recover|cleanup>` 不读 Envelope，Hook 把 `git worktree add|remove|prune|list` 归类为 `gitBranch` 工作区效果并直接放行，只有 `git worktree move` 属于不可变工作区操作。阻塞完全来自规则与 Skill 的措辞，而该措辞把工作区内部操作误当成了跨边界授权。

## Decision Drivers

- 授权必须来自可获得的事实：worktree 生命周期由「用户在本轮的显式请求 + 运行时能核对的 Git 事实」授权，规则不得要求不可获得的宿主证明。
- 宿主证明与非对称风险匹配：hostWrite、externalWrite、credentialUse、红区与高风险间接写入是真正的跨边界效果，仍须宿主注入；工作区内部操作不应消耗同一套证明。
- 与 runtime 既有行为一致：不修改 `run.mjs`、`policy.mjs`、`execution-envelope.mjs` 的语义，只让规则、Skill 与文档表达既有分类。
- 入口归属清晰：宿主 worktree 由宿主侧清理，`worktree land` 继续只回收由 `worktree bootstrap` 创建并登记的仓库外 worktree。

## Considered Options

- 让宿主补齐 v2 Envelope 与 hostContext：否决，宿主不注入这些字段，Agent 也无法自造，等于永久阻塞隔离工作区的建立。
- 删除 worktree 相关门禁：否决，会把 `git worktree move`、红区与跨边界写入一并放开，扩大本决策要保护的风险面。
- 按 effect 拆分：worktree 生命周期收敛为工作区内部操作（本地核验 + 本轮显式请求），宿主证明只保留给跨边界效果。采纳。

## Decision Outcome

选定方案：**按 effect 拆分 worktree 门禁**。

- **工作区与目标核验**：worktree 生命周期只要求本地工作区核验加本轮用户显式请求。事实包括冻结的 base SHA、任务分支、干净工作树、allowedWriteRoots 和归属明确的改动，全部由运行时按 Git 事实核对；这些事实不授予 hostWrite、externalWrite 或凭据。
- **宿主核验**：hostContext 只用于跨边界效果（hostWrite、externalWrite、credentialUse、红区与高风险间接写入），仍要求 `execution-envelope/v2`、source=host、filesystem、approval、process=isolated、network 与 observedAt。
- **能力受阻**：缺少宿主证明只阻塞依赖它的跨边界步骤；建立隔离工作区、实现、聚焦验证与提交继续推进，不据此停止整个请求，也不把工作降级为主检出直改。
- **入口选择**：worktree 入口改为宿主 worktree 优先——从已核实的 `origin/develop` 基线创建并核对基线 SHA，由宿主把会话根切到该 worktree。`worktree bootstrap` 只用于声明了 `worktree.mirrors`、`worktree.ports` 或 `worktree.provision`（治理面投影、端口分段、依赖链接）的项目。
- **落地归属**：`worktree land` 的 CLI 与 fail-closed 门禁不变，仍只回收 `worktree bootstrap` 创建并登记的仓库外 worktree；宿主 worktree 走独立交付路径（推送任务分支，或按项目 delivery 配置走 PR/MR）。
- **替换范围**：本决策只取代 ADR-0002 中「worktree 拓扑变化要求宿主证据」一条；ADR-0002 的其余条款（v2 Envelope 字段、恢复检查点、不授权 `git worktree move`）继续有效，历史正文不改写。

## Consequences

- 正面：显式 `vb-git-develop-flow` 在真实 Codex 会话中可以创建宿主 worktree 并推进，不再因缺少不可获得的宿主证明而停止。
- 正面：`governance-core.md`、`git-rules.md`、`linear-workflow.md` 与三个 Skill 用同一 effect 边界表述，`vb-git-develop-flow` Skill 不再需要 hostContext 词汇。
- 取舍：worktree 生命周期不再有宿主级证明，只靠运行时能核对的 Git 事实与本轮显式请求；证据强度如实标注为「不再依赖不可获得的宿主证明」，不等于取消宿主级隔离。
- 取舍：宿主 worktree 不进入 `land` 登记表，落地因此有两类形态（bootstrap 登记的本地 land，宿主 worktree 的推送或 PR/MR），两类都要求在回收前读到推送或合并事实。
- 正面：Linear 模式的宿主事件自动领单与跨实例互斥仍要求宿主签发的 v2 Envelope 与原子 Claim，本决策不动该授权根。

## Confirmation

- 规则与 Skill 锚点：`scripts/lib/pack-validation.js` 的 `SKILL_EXECUTION_BOUNDARY_CHECKS`（共享 term + 每文件 term，`vb-git-develop-flow` 不再要求 hostContext/source=host/process=isolated/observedAt，改为要求本地核验与入口选择措辞）与 `CONTENT_QUALITY_CHECKS` 的 governance-core、git-rules、linear-workflow 锚点，由 `pnpm validate` 执行。
- 负面控制：`tests/component/rules-depth.test.js` 断言删掉「worktree 生命周期只要求本地工作区核验」「宿主核验只用于跨边界效果」「不据此停止整个请求」即失败；`tests/component/manifest-schema.test.js` 断言三个 Skill 仍保留共享的 fail-closed 措辞、两个 Linear Skill 仍要求 hostContext，而删掉 `vb-git-develop-flow` 的宿主证明措辞不构成违规。
- Hook 行为：`tests/integration/hook-runtime.test.js` 断言无 Envelope 时 `git worktree add|remove|prune|list` 与 `run.mjs worktree bootstrap|land` 放行，`git worktree move` 仍拒绝，hostWrite、externalWrite 与 credentialUse 仍 fail-closed。
- 手工验收：在真实 Codex 会话以宿主 worktree 为会话根跑一次 `vb-git-develop-flow`，确认不再出现「缺少宿主隔离核验」的停止。

## Review Trigger

- worktree 生命周期重新被绑定到宿主证明，或再次出现「缺少宿主隔离核验」的停止。
- `worktree land` 的回收范围、`--delivery` 语义或宿主 worktree 交付路径变化。
- 宿主开始稳定注入 v2 Envelope 与 hostContext，使跨边界证明可以覆盖工作区内部操作。

## More Information

实现位于 `docs/rules/governance-core.md`、`docs/rules/git-rules.md`、`docs/rules/linear-workflow.md`、`docs/rules/agent-skill-routing.md`，Skill 位于 `skills/core/vb-git-develop-flow/`、`skills/integrations/vb-linear-worktree-develop/`、`skills/integrations/linear-workflow/`，说明文档见 `docs/hooks.md` 与 `runtime/hooks/README.md`。相关决策：ADR-0002（本决策只取代其中「worktree 拓扑变化要求宿主证据」一条）、ADR-0015（显式 develop flow 入口）、ADR-0011（交付生命周期与受管服务归属）。
