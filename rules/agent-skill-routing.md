# 原生 Skill 选择规则

Skill 只补充模型缺少的领域知识，不覆盖项目规则、治理硬边界或人工门禁。宿主直接依据每个 `SKILL.md` 的 description 选择能力，不使用 Router 或流程 Skill 链。

## 选择

- 需求存在事实无法消除的高影响产品决定时使用 `clarify-requirements`。
- 首次聚焦验证失败且根因未知时使用 `systematic-debugging`；Agent 行为或评测合同变化使用 `eval-driven-development`。
- 信任边界使用 `security-and-hardening`；公共契约使用 `api-and-interface-design`；前端体验使用 `frontend-design`；跨仓运行时使用 `runtime-cross-repo-rollout`。
- 同一阶段默认只加载一个 Skill；成功路径不为规划、验证或审查预加载 Skill，只有失败信号、复杂验证设计或任务真正切换领域后再加载下一个。

计划、测试原则、完成验证、普通 Review、多 Agent 和 Red Team 由治理内核、项目命令、宿主原生能力与完整任务门禁承担。能力不可用时使用项目规则和确定性验证，不模拟 Skill、工具或结果。红区、权限、凭据、生产、外部写入和不可逆操作始终保留人工门禁。
