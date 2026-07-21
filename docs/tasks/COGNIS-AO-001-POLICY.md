# COGNIS-AO-001-POLICY 自适应编排规范与 Skill

- 工作流档位：完整
- 当前阶段：交付
- 当前状态：空闲
- 处理结果：完成

## 目标

定义自适应单/多 Agent 决策矩阵、准入门禁、降级与停止策略，并形成 v0.7 现行规格。

## 验收标准

| AC-ID | 标准 |
| --- | --- |
| AC-01 | 三份规则明确简单任务保持单 Agent、复杂可拆任务自动多 Agent。 |
| AC-02 | Skill 明确最多 3 个 ready child、连续三次失败停止、Build 不得修改验收和独立 Judge。 |
| AC-03 | 新规格保留 v2 schema、CLI、profile 和无自建调度器边界。 |

## 验证计划

运行 `node --test tests/adaptive-orchestration.test.js`；若 tests child 尚未完成，先用 `rg` 核对关键合同并将聚焦测试留给父任务复验。

## 下一步动作

父 Agent 已核对限定范围 diff 并复跑聚焦测试；本 child 已关闭，等待父任务完成文档、eval、集成验证和最终独立审查。

## 完整流程控制

```json
{
  "控制版本": 2,
  "任务类型": "子任务",
  "父任务编号": "COGNIS-AO-001",
  "责任角色": "规范实现者",
  "写入范围": ["rules/governance-core.md", "rules/ai-collab-rules.md", "rules/agent-skill-routing.md", "skills/core/subagent-driven-development/SKILL.md", "docs/specs/cognis-v0.7-adaptive-orchestration-spec.md"],
  "禁止动作": ["修改任务控制文档", "创建孙任务或再委派", "修改验收标准以通过检查", "覆盖用户未归属改动"],
  "输入": ["COGNIS-AO-001 的目标、约束和 AC", "现行 v0.6 规格与用户批准计划"],
  "输出格式": ["状态", "变更摘要", "变更路径", "验证证据", "未验证项", "剩余风险", "下一步动作"],
  "不得修改范围": ["写入范围之外的所有文件", "v2 schema、CLI、profile 和 runtime"],
  "依赖任务": ["COGNIS-AO-001-TESTS"],
  "冲突任务": [],
  "并行安全": "相互独立",
  "时间盒分钟": 60,
  "停止条件": "限定范围内 AC 完成，或发现需要越界/再拆分/无法验证",
  "回滚方案": "恢复本 child 的限定文件改动",
  "人工确认": "不需要",
  "核验者": "父 Agent",
  "红队审查者": "父 Agent",
  "红队审查包": "docs/reviews/COGNIS-AO-001-POLICY-red-team.md",
  "红队审查结论": "批准",
  "合并回主线状态": "不需要"
}
```

## 验收证据

| AC-ID | 证据类型 | 命令或产物 | 退出码 | 核验时间 | 核验者 | 实际结果 |
| --- | --- | --- | --- | --- | --- | --- |
| AC-01 | 命令 | node --test tests/adaptive-orchestration.test.js | 0 | 2026-07-21T23:48:00+08:00 | 父 Agent | 三阶段路由、单 Agent 默认、all-of 门禁、能力和偏好降级合同通过，3/3。 |
| AC-02 | 审查 | docs/reviews/COGNIS-AO-001-POLICY-red-team.md |  | 2026-07-21T23:52:00+08:00 | 父 Agent | 并发上限、三次失败停止、验收保护、独立核验和 fan-in 复验均已核对。 |
| AC-03 | 产物 | docs/specs/cognis-v0.7-adaptive-orchestration-spec.md |  | 2026-07-21T23:48:00+08:00 | 父 Agent | v2 schema、CLI/profile 兼容和无自建 scheduler 边界已明确。 |

## 剩余风险

父任务尚未完成全仓集成验证和最终 Red Team；不影响本 child 限定范围交付。
