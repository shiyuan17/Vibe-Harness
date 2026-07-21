# COGNIS-MA-001 父子任务多 Agent 治理闭环

- 工作流档位：完整
- 当前阶段：交付
- 当前状态：空闲
- 处理结果：完成

## 目标

在保留单一 Markdown 任务真值和 v1 兼容性的前提下，实现版本化父子任务合同、跨文档任务图校验、迁移诊断和 full-profile 执行辅助。

## 约束

- 不新增 Agent 调度器、消息总线、全局 Agent 配置或旧 task.json 生命周期。
- 保护现有 hook 元数据清理改动。
- 子任务治理采用扁平 DAG 和父 Agent 单一编排责任。

## 验收标准

| AC-ID | 标准 |
| --- | --- |
| AC-01 | v1 合同保持兼容，新模板和 schema 支持 v2 single/parent/child。 |
| AC-02 | 跨文档 validator 阻断无效父子关系、依赖、冲突、批次、写入重叠和未闭环完成状态。 |
| AC-03 | doctor、规则、Skill、hook、安装 surface、文档与 eval 对齐新合同。 |
| AC-04 | 仓库必跑检查、core/full 临时项目生命周期和独立审查通过。 |

## 验证计划

- 聚焦运行 schema、任务图、hook、doctor、安装和 eval 测试。
- 运行 AGENTS.md 与 CONTRIBUTING.md 要求的完整验证矩阵。
- 在临时项目执行 core/full init、dry-run、write、validate 和 doctor。

## 评测映射

| AC-ID | Eval-ID |
| --- | --- |
| AC-03 | EVAL-MULTI-AGENT-001 |

## 下一步动作

无；全部 AC 已获得本轮证据并通过独立 Red Team 复审。

## 完整流程控制

```json
{
  "控制版本": 2,
  "任务类型": "单任务",
  "责任角色": "实现负责人",
  "写入范围": ["rules/**", "templates/**", "schemas/**", "runtime/**", "scripts/**", "skills/**", "adapters/**", "manifests/**", "evals/**", "tests/**", "docs/**", "README.md", "README.zh-CN.md", "CHANGELOG.md"],
  "禁止动作": ["覆盖用户未归属改动", "写入全局 Agent 配置", "恢复旧 task.json 或 workflow manifest"],
  "输入": ["用户确认的实施计划", "当前 v0.5 治理合同", "官方多 Agent 与 Codex hook 文档"],
  "输出格式": ["变更摘要、验证证据、未验证项、剩余风险和 Git 状态"],
  "不得修改范围": ["用户现有改动的语义", "项目外文件"],
  "依赖任务": [],
  "冲突任务": [],
  "并行安全": "独占写入",
  "时间盒分钟": 240,
  "停止条件": "全部 AC 获得本轮证据且独立审查批准",
  "回滚方案": "按本次 diff 逐文件恢复，不影响用户原有改动",
  "人工确认": "不需要",
  "核验者": "独立核验者",
  "红队审查者": "独立核验者",
  "红队审查包": "docs/reviews/COGNIS-MA-001-red-team.md",
  "红队审查结论": "批准",
  "合并回主线状态": "不需要"
}
```

## 验收证据

| AC-ID | 证据类型 | 命令或产物 | 退出码 | 核验时间 | 核验者 | 实际结果 |
| --- | --- | --- | --- | --- | --- | --- |
| AC-01 | 命令 | node --test tests/multi-agent-governance.test.js tests/manifest-schema.test.js tests/documentation-governance.test.js | 0 | 2026-07-20T00:09:49+08:00 | 实现负责人 | v1 兼容、v2 变体、路径与模板合同通过，38/38。 |
| AC-02 | 命令 | pnpm check | 0 | 2026-07-20T00:09:49+08:00 | 实现负责人 | 385 pass、0 fail、2 skip；含任务图正反例。 |
| AC-03 | 评测 | .cognis/evals/runs/2026-07-21T16-10-22-133Z.json |  | 2026-07-22T00:10:22+08:00 | 父 Agent | 当前 41 个案例通过，reference fingerprint matched；v0.6 的 EVAL-MULTI-AGENT-001..006 保持通过，critical pass rate 与 overall score 均为 1。 |
| AC-03 | 命令 | pnpm docs:audit | 0 | 2026-07-20T00:09:49+08:00 | 实现负责人 | 28 个治理文档通过审计。 |
| AC-03 | 命令 | pnpm skills:audit | 0 | 2026-07-20T00:09:49+08:00 | 实现负责人 | 18 个 Skill 图与入口预算通过。 |
| AC-04 | 命令 | pnpm test:integration | 0 | 2026-07-20T00:09:49+08:00 | 实现负责人 | 97 pass、0 fail、1 个真实工具 smoke 按设计跳过。 |
| AC-04 | 命令 | pnpm smoke:lifecycle | 0 | 2026-07-20T00:09:49+08:00 | 实现负责人 | core/full 10 个生命周期步骤全部通过。 |
| AC-04 | 人工 | AGENTS.md core/full 两套显式临时项目生命周期 |  | 2026-07-20T00:09:49+08:00 | 实现负责人 | 9 个 init/install/validate/doctor 命令全部退出 0。 |
| AC-04 | 审查 | docs/reviews/COGNIS-MA-001-red-team.md |  | 2026-07-19T23:51:46+08:00 | 独立核验者 | RT-MA-001 至 RT-MA-004 已关闭，最终结论批准。 |
| AC-04 | 命令 | git diff --check | 0 | 2026-07-20T00:09:49+08:00 | 独立核验者 | 无 whitespace 错误，仅 Windows CRLF 转换提示。 |

## 剩余风险

未执行真实在线 Agent/provider eval；未在独立 Linux 主机复跑生命周期。Windows 完整测试已覆盖跨平台 adapter 与临时项目安装路径。
