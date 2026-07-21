# COGNIS-AO-001 Red Team 审查包

- 任务编号：COGNIS-AO-001
- 审查者：独立核验者
- 审查对象：当前实际工作区 diff、v0.7 规格、路由规则与 Skill、评测基线、父子任务证据
- 审查时间：2026-07-22T00:22:33+08:00
- 状态：批准

## 审查范围

审查正确性与边界、安全与滥用、架构依赖、测试有效性、兼容性、发布与回滚及治理合规。重点核对三阶段路由与单 Agent 默认、多 Agent 五项 all-of 门禁、能力降级与人工门禁、v2/CLI/profile 兼容、并发与停止条件、Build/Judge 独立、fan-in 新鲜证据、v0.7/v0.6 文档真值、EVAL-MULTI-AGENT-007..012 及 reference 更新；RTK、installer、hook 和工具 provisioning 的既有用户改动仅检查是否被保留，不归因于本任务。

## 问题列表

| 问题编号 | 严重度 | 状态 | 位置 | 触发方式 | 影响 | 最小修复方向 |
| --- | --- | --- | --- | --- | --- | --- |
| AO-RT-001 | High | 已修复 | `docs/tasks/COGNIS-AO-001.md` 的 `当前阶段` | 对当前工作区执行 `validateTasks(process.cwd())`，原值“审查”不在任务合同枚举内 | 父任务合同无效，后续完成门禁和旧 `pnpm check` 证据不能成立 | 已改为合法阶段“验证”，并由父 Agent 在最终工作区重新运行 `pnpm check`；独立复验 AO 任务图无错误 |
| AO-RT-002 | Medium | 已修复 | `docs/tasks/COGNIS-AO-001-TESTS.md` 的下一步动作、验收证据与剩余风险 | 对照已完成状态与父任务 GREEN 结果，原文仍称等待 policy 且尚未证明 GREEN | durable child 报告与实际 fan-in 状态矛盾，降低证据可追溯性 | 已改为无待办，补充 3/3 GREEN 父级复验证据并收敛剩余风险 |

## Medium 延期

| 问题编号 | 理由 | 责任人 | 关闭条件 | 批准者 |
| --- | --- | --- | --- | --- |

## 已核验证据

- 独立读取当前实际 diff，而非采信 child 自报。规则与 v0.7 规格一致规定 `风险分级 → 需求分类 → 编排判定`、默认单 Agent、五项条件全部满足才自动派发、能力不可用回退、用户偏好不绕过门禁，以及红区、发布、权限、破坏性操作和业务歧义保留人工决定。
- `skills/core/subagent-driven-development/SKILL.md` 明确父 Agent 最多同时运行三个 ready child、adapter 只能降低上限、连续三次失败或范围漂移/再拆分时停止上报、Build 不得放宽验收、Judge/Reviewer 独立，以及 fan-in 后检查实际 diff 并重跑目标工作区集成验证。
- v0.7 是 `docs/catalog.json` 中现行自适应编排规格；v0.6 已移动到 archive，除 `Implemented` 改为 `Superseded` 外内容保持一致，并明确由 v0.7 取代。README、中文 README、架构、文档索引、CHANGELOG、capability 指针和文档测试均指向当前规格。
- 当前 suite 为 `1.6.0`，保留工作区既有 EVAL-TOOL-RTK-002..005，并新增 EVAL-MULTI-AGENT-007..012。六个案例覆盖简单文档/页面、单模块、独立跨层自动派发、共享边界串行、显式滥用请求、能力降级和交互偏好隔离；原有 001..006 继续覆盖扁平 DAG、child 禁止再拆、fan-in 和完成门禁。
- reference 更新已显式核对：当前 checked-in result、reference 与最新 `2026-07-21T16-10-22-133Z` run 使用同一 suite 指纹 `be2002848bf9b2347321320f7ac33baba92e80389113b8e4b420f357b75159ec`，41 个案例通过，overall score 与 critical pass rate 均为 1；未把 RTK/tool 增量误归因于本任务。
- 独立复验 `node --test tests/adaptive-orchestration.test.js`：退出码 0，3/3 通过。
- 独立复验 `pnpm docs:audit`：退出码 0，35 个文档通过；`pnpm eval:check` 与 `pnpm eval:offline`：退出码均为 0；`pnpm skills:audit`：退出码 0，18 个 Skill 通过；`git diff --check`：退出码 0，仅有 Windows 行尾提示。
- 独立执行 AO 任务图过滤校验：退出码 0，无 `COGNIS-AO-001` 错误。父 Agent 在修正后的目标工作区记录 `pnpm check` 退出码 0，432 pass、0 fail、2 skip；另有 `pnpm test:integration` 98 pass、0 fail、1 skip及 `pnpm smoke:lifecycle` 10/10 证据。
- 最终收口复核确认审查包已登记到 `docs/catalog.json` 与 `docs/README.md`，父任务处于交付/空闲/完成状态，EVAL-MULTI-AGENT-007..012 已逐项映射到 AC-01 与 AC-04，完成态 `validateTasks(process.cwd())` 返回空错误列表；独立复跑 `pnpm docs:audit` 检查 36 个文档通过。
- AO 范围未修改 v2 schema、CLI、profile 或 adapter 行为，也未新增调度器、全局配置、用户身份/权限评级。工作区中的 runtime、scripts、adapter 与 RTK/tool 变更属于既有用户改动，审查未要求回退或覆盖。

## 未覆盖审查轴与剩余风险

未执行真实 provider 的多 Agent 行为或外部发布；本次变更是治理规则、文档、Skill 和离线 fixture 合同，运行时是否具备真实 child 能力仍由平台在执行时判断并按单 Agent 降级。未独立重复执行耗时的 installer integration 和 lifecycle smoke，采用父 Agent 在同一工作区记录的成功证据，并以独立的聚焦测试、任务图、文档、评测、Skill 与 diff 校验交叉核对。回滚可按 AO 任务限定文件逐项恢复，不应触及并存的 RTK/tool 用户改动。

## 结论

批准
