# COGNIS-AO-001 自适应单/多 Agent 路由治理

- 工作流档位：完整
- 当前阶段：交付
- 当前状态：空闲
- 处理结果：完成

## 目标

在保持 v2 任务合同和现有 CLI/profile 行为不变的前提下，为 Cognis 增加风险分级、需求分类和编排判定三阶段路由，并用规则、Skill、文档、测试和评测形成治理闭环。

## 约束

- 不新增 Agent 调度器、全局配置、用户身份评级或权限等级。
- 不覆盖当前工作区已有的 RTK、installer、hook 或 README 改动。
- 简单查询、文档、局部页面和单模块任务默认保持单 Agent。

## 验收标准

| AC-ID | 标准 |
| --- | --- |
| AC-01 | 现行规则明确三阶段路由、单 Agent 默认和多 Agent 全部准入条件。 |
| AC-02 | full 多 Agent Skill 明确并发上限、连续三次失败停止、验收条件保护和独立核验。 |
| AC-03 | v0.7 规格、catalog、架构、README 与 CHANGELOG 形成唯一当前真值，v0.6 作为被替代历史保留。 |
| AC-04 | 路由测试和 offline eval 覆盖简单任务、复杂可拆任务、复杂耦合任务、显式滥用请求、交互偏好和能力降级。 |
| AC-05 | 全部仓库必跑检查通过，最终 diff 获独立 Red Team 批准。 |

## 验证计划

运行 `pnpm check`、`pnpm docs:audit`、`pnpm eval:check`、`pnpm eval:offline`、`pnpm skills:audit` 和 `git diff --check`，并由独立 reviewer 核对最终 diff、证据与兼容边界。

## 评测映射

| AC-ID | Eval-ID |
| --- | --- |
| AC-01 | EVAL-MULTI-AGENT-007 |
| AC-01 | EVAL-MULTI-AGENT-008 |
| AC-01 | EVAL-MULTI-AGENT-009 |
| AC-01 | EVAL-MULTI-AGENT-010 |
| AC-01 | EVAL-MULTI-AGENT-011 |
| AC-01 | EVAL-MULTI-AGENT-012 |
| AC-04 | EVAL-MULTI-AGENT-007 |
| AC-04 | EVAL-MULTI-AGENT-008 |
| AC-04 | EVAL-MULTI-AGENT-009 |
| AC-04 | EVAL-MULTI-AGENT-010 |
| AC-04 | EVAL-MULTI-AGENT-011 |
| AC-04 | EVAL-MULTI-AGENT-012 |

## 下一步动作

无；全部 AC 已获得本轮证据，Red Team 阻断问题已修复并通过独立复审。

## 完整流程控制

```json
{
  "控制版本": 2,
  "任务类型": "父任务",
  "责任角色": "集成负责人",
  "写入范围": ["docs/**", "README.md", "README.zh-CN.md", "CHANGELOG.md", "evals/**", "manifests/capabilities.json", "rules/**", "skills/core/subagent-driven-development/**", "tests/adaptive-orchestration.test.js", "tests/documentation-governance.test.js"],
  "禁止动作": ["覆盖用户未归属改动", "新增自建 Agent 调度器", "修改 v2 task schema、CLI 或 profile 行为"],
  "输入": ["用户批准的自适应路由计划", "现行 v0.6 多 Agent 治理合同", "当前工作区未提交改动"],
  "输出格式": ["变更摘要、验证证据、未验证项、剩余风险和 Git 状态"],
  "不得修改范围": ["runtime/**", "scripts/**", "schemas/**", "adapters/**", "manifests/capabilities.json 之外的 manifests/**", "用户现有改动的语义"],
  "子任务": ["COGNIS-AO-001-POLICY", "COGNIS-AO-001-TESTS"],
  "执行批次": [["COGNIS-AO-001-TESTS"], ["COGNIS-AO-001-POLICY"]],
  "集成验证": ["pnpm check", "pnpm docs:audit", "pnpm eval:check", "pnpm eval:offline", "pnpm skills:audit", "git diff --check"],
  "依赖任务": [],
  "冲突任务": [],
  "并行安全": "独占写入",
  "时间盒分钟": 240,
  "停止条件": "全部 AC 获得本轮证据且独立审查批准",
  "回滚方案": "按本任务新增和修改的 diff 逐文件恢复，不影响工作区原有改动",
  "人工确认": "不需要",
  "核验者": "独立核验者",
  "红队审查者": "独立核验者",
  "红队审查包": "docs/reviews/COGNIS-AO-001-red-team.md",
  "红队审查结论": "批准",
  "合并回主线状态": "不需要"
}
```

## 验收证据

| AC-ID | 证据类型 | 命令或产物 | 退出码 | 核验时间 | 核验者 | 实际结果 |
| --- | --- | --- | --- | --- | --- | --- |
| AC-01 | 命令 | node --test tests/adaptive-orchestration.test.js | 0 | 2026-07-21T23:58:00+08:00 | 父 Agent | 三阶段路由、简单任务单 Agent 和 all-of 准入合同 3/3 通过。 |
| AC-01 | 评测 | .cognis/evals/runs/2026-07-21T16-10-22-133Z.json |  | 2026-07-22T00:10:22+08:00 | 父 Agent | EVAL-MULTI-AGENT-007..012 全部通过，覆盖三阶段路由、门禁、串行反例、滥用请求与能力降级。 |
| AC-02 | 命令 | pnpm skills:audit | 0 | 2026-07-22T00:14:43+08:00 | 父 Agent | 18 个 Skill 的图、依赖、入口预算与 fallback 审计通过。 |
| AC-03 | 命令 | pnpm docs:audit | 0 | 2026-07-22T00:14:43+08:00 | 父 Agent | v0.7 当前规格、v0.6 归档、catalog、架构和双语说明通过，35 个文档受检。 |
| AC-04 | 评测 | .cognis/evals/runs/2026-07-21T16-10-22-133Z.json |  | 2026-07-22T00:10:22+08:00 | 父 Agent | 41 个案例通过并匹配 reference；EVAL-MULTI-AGENT-007..012 全部通过，critical pass rate 与 overall score 均为 1。 |
| AC-04 | 命令 | pnpm eval:check | 0 | 2026-07-22T00:14:43+08:00 | 父 Agent | suite、checked-in result、reference 与 fingerprint 合同通过。 |
| AC-04 | 命令 | pnpm eval:offline | 0 | 2026-07-22T00:14:43+08:00 | 父 Agent | 41 个案例确定性复放通过，critical pass rate 与 overall score 均为 1。 |
| AC-05 | 命令 | pnpm check | 0 | 2026-07-22T00:14:43+08:00 | 父 Agent | lint、validate、routing 与全量测试通过，432 pass、0 fail、2 skip。 |
| AC-05 | 命令 | pnpm test:integration | 0 | 2026-07-22T00:06:00+08:00 | 父 Agent | installer/profile 集成测试 98 pass、0 fail、1 skip。 |
| AC-05 | 命令 | pnpm smoke:lifecycle | 0 | 2026-07-22T00:06:00+08:00 | 父 Agent | core/full init、dry-run、write、validate、offline eval 与 doctor 共 10 步全部通过。 |
| AC-05 | 命令 | git diff --check | 0 | 2026-07-22T00:14:43+08:00 | 父 Agent | 无 whitespace error；仅 Windows LF 到 CRLF 提示。 |
| AC-05 | 审查 | docs/reviews/COGNIS-AO-001-red-team.md |  | 2026-07-22T00:18:03+08:00 | 独立核验者 | AO-RT-001 与 AO-RT-002 均已修复，无 Medium 延期，最终结论批准。 |

## 剩余风险

真实 provider 多 Agent 行为未在 offline fixture 中执行，平台能力仍按运行时可用性降级；未在独立 Linux 主机复跑 lifecycle。
