状态：Completed

# COGNIS-HANDOFF-001 Handoff 与独立测试审查流程

- 工作流档位：完整
- 当前阶段：交付
- 当前状态：空闲
- 处理结果：完成

## 目标

为 Cognis 增加机器可验证的 v3 Handoff、Codex 原生 Tester/Reviewer 角色、运行收据与变更集新鲜度门禁，并在 Claude/Gemini 上提供明确降级。

## 约束

- 不恢复已退休的流程 Skill，不新增自建 Agent 调度器。
- v1/v2 历史任务继续按旧语义读取，未完成旧任务升级为 v3 后才启用新门禁。
- 运行收据不得保存 prompt、transcript 或模型输出，只保存哈希化标识、角色、时间、状态和工作区指纹。
- 自托管安装只通过受支持的 installer dry-run/write/upgrade 流程恢复，保留无法证明归 Cognis 所有的用户文件。

## 验收标准

| AC-ID | 标准 |
| --- | --- |
| AC-01 | v3 schema、任务 IR 和治理校验器支持结构化交接记录、状态转换及 v1/v2 兼容。 |
| AC-02 | Codex full 安装原生 Tester/Reviewer 角色；角色文件属于红区；Claude/Gemini 明确报告降级。 |
| AC-03 | SubagentStart/Stop 生成和封存最小运行收据，拒绝重复、伪造、越界、缺字段及过期证据，并最多续跑一次。 |
| AC-04 | 完整任务完成要求最新变更集同时具备 Tester/Reviewer 有效回传，父 Agent 在 fan-in 后重跑集成验证。 |
| AC-05 | Eval 覆盖派发、暂停恢复、能力降级、单 Agent 反例、共享写入反例、证据失效及 child 自报不可替代父级验证。 |
| AC-06 | 架构、规格、README、迁移、catalog、changelog、doctor、baseline 和安装摘要形成一致真值。 |
| AC-07 | 自托管安装恢复有效，完整验证矩阵通过，最终 diff 获独立 Reviewer/Red Team 批准。 |

## 验证计划

先运行新增的聚焦测试和 Eval 确认 RED，再实现并运行 `pnpm check`、`git diff --check`、`pnpm docs:audit`、`pnpm eval:check`、`pnpm eval:offline`、`pnpm test:integration`、`pnpm smoke:lifecycle`、core/full 临时项目生命周期矩阵和 `pnpm cognis validate --project .`。

## 评测映射

| AC-ID | Eval-ID |
| --- | --- |
| AC-04 | EVAL-HANDOFF-001 |
| AC-04 | EVAL-HANDOFF-002 |
| AC-05 | EVAL-HANDOFF-003 |
| AC-05 | EVAL-HANDOFF-004 |
| AC-05 | EVAL-HANDOFF-005 |
| AC-05 | EVAL-HANDOFF-006 |
| AC-05 | EVAL-HANDOFF-007 |
| AC-05 | EVAL-HANDOFF-008 |

## 下一步动作

无。v7 Tester/Reviewer 已对最终 workspace 指纹完成独立回传，Handoff 已 fan-in，父 Agent 已在目标工作区重跑任务合同中的三个集成命令。

## 完整流程控制

```json
{
  "控制版本": 3,
  "任务类型": "单任务",
  "集成验证": ["pnpm check", "pnpm test:integration", "pnpm smoke:lifecycle"],
  "责任角色": "集成负责人",
  "写入范围": ["adapters/**", "docs/**", "evals/**", "manifests/**", "runtime/**", "schemas/**", "scripts/**", "templates/**", "tests/**", "AGENTS.md", "README.md", "README.zh-CN.md", "CHANGELOG.md", ".agents/**", ".codex/**"],
  "禁止动作": ["覆盖用户未归属改动", "修改全局 Agent 或 MCP 配置", "绕过红区确认", "用 child 自报替代父级集成验证"],
  "输入": ["用户批准的 Handoff 与独立测试审查实施计划", "Codex Subagents 与 Hooks 官方合同", "当前仓库治理与 installer 合同"],
  "输出格式": ["变更摘要", "验证证据", "未验证项", "剩余风险", "交接记录", "Red Team 审查结论"],
  "不得修改范围": ["工作区之外的所有文件", "用户无法证明归 Cognis 所有的资产"],
  "依赖任务": [],
  "冲突任务": [],
  "并行安全": "独占写入",
  "时间盒分钟": 480,
  "停止条件": "全部 AC 获得最新变更集证据、Tester 与 Reviewer 回传有效、自托管安装通过且独立审查批准",
  "回滚方案": "按本任务 diff 逐文件恢复；自托管迁移仅回滚由 installer 状态证明归 Cognis 所有的写入",
  "人工确认": "已确认",
  "核验者": "独立 Tester",
  "红队审查者": "独立 Reviewer",
  "红队审查包": "docs/reviews/COGNIS-HANDOFF-001-red-team.md",
  "红队审查结论": "批准",
  "独立核验模式": "原生子智能体",
  "合并回主线状态": "不需要"
}
```

## 交接记录

```json
[
  {
    "版本": 1,
    "编号": "HO-TESTER-V6",
    "类型": "子任务回传",
    "来源角色": "cognis_tester",
    "目标角色": "集成负责人",
    "Agent/运行收据": ".cognis/subagents/receipts/18b39ec90f210867dbe4009e1a1089c607a684d2330595c519e74a3f7cab6d72.json",
    "状态": "待接收",
    "变更集指纹": "9834de2731b589c058bb393840acceeb8ba57880446f5ea0bd4b3a175d408c78",
    "已完成": ["独立运行完整 Tester 验收矩阵"],
    "未完成": ["父级 fan-in 集成验证"],
    "验证证据": ["聚焦 75/75、check 461 通过 2 跳过、integration 101 通过 1 跳过、smoke 10/10、docs 66、Eval 49/49"],
    "未验证项": ["real Codex runner、真实 codebase-memory provisioning、online model Eval"],
    "风险": ["503 个历史资产保持 unmanaged"],
    "下一步": "等待集成负责人接收 Tester 回传",
    "恢复提示": "从 sealed Tester 收据与冻结指纹继续 fan-in",
    "时间": "2026-07-26T22:03:00.000Z"
  },
  {
    "版本": 1,
    "编号": "HO-TESTER-V6",
    "类型": "子任务回传",
    "来源角色": "cognis_tester",
    "目标角色": "集成负责人",
    "Agent/运行收据": ".cognis/subagents/receipts/18b39ec90f210867dbe4009e1a1089c607a684d2330595c519e74a3f7cab6d72.json",
    "状态": "已接收",
    "变更集指纹": "9834de2731b589c058bb393840acceeb8ba57880446f5ea0bd4b3a175d408c78",
    "已完成": ["独立运行完整 Tester 验收矩阵", "父 Agent 核对 Tester 收据与实际 Git 状态"],
    "未完成": ["父级 fan-in 集成验证"],
    "验证证据": ["Tester 收据 sealed/passed，起止指纹一致"],
    "未验证项": ["real Codex runner、真实 codebase-memory provisioning、online model Eval"],
    "风险": ["503 个历史资产保持 unmanaged"],
    "下一步": "等待 Reviewer 回传并执行 fan-in",
    "恢复提示": "Tester 回传已接收，继续核对 Reviewer 收据",
    "时间": "2026-07-26T22:03:01.000Z"
  },
  {
    "版本": 1,
    "编号": "HO-TESTER-V6",
    "类型": "子任务回传",
    "来源角色": "cognis_tester",
    "目标角色": "集成负责人",
    "Agent/运行收据": ".cognis/subagents/receipts/18b39ec90f210867dbe4009e1a1089c607a684d2330595c519e74a3f7cab6d72.json",
    "状态": "已返回",
    "变更集指纹": "9834de2731b589c058bb393840acceeb8ba57880446f5ea0bd4b3a175d408c78",
    "已完成": ["独立运行完整 Tester 验收矩阵", "父 Agent 核对 Tester 收据与实际 Git 状态", "Tester 回传完成 fan-in"],
    "未完成": ["父级 fan-in 集成验证"],
    "验证证据": ["Tester 收据 sealed/passed，workspace 9834de27...c78"],
    "未验证项": ["real Codex runner、真实 codebase-memory provisioning、online model Eval"],
    "风险": ["503 个历史资产保持 unmanaged"],
    "下一步": "与 Reviewer 回传合并后重跑集成验证",
    "恢复提示": "Tester Handoff 已返回，等待父级集成验证",
    "时间": "2026-07-26T22:03:02.000Z"
  },
  {
    "版本": 1,
    "编号": "HO-REVIEWER-V6",
    "类型": "子任务回传",
    "来源角色": "cognis_reviewer",
    "目标角色": "集成负责人",
    "Agent/运行收据": ".cognis/subagents/receipts/33aafad47db739b53017bce6e8953e56bfe3843bca919f0f9c6b5e5f9569ecd0.json",
    "状态": "待接收",
    "变更集指纹": "9834de2731b589c058bb393840acceeb8ba57880446f5ea0bd4b3a175d408c78",
    "已完成": ["完成独立 findings-first Reviewer 与 Red Team 审查"],
    "未完成": ["父级 fan-in 集成验证"],
    "验证证据": ["无 Critical、High 或未关闭 Medium；Reviewer 结论批准"],
    "未验证项": ["OCR 第二视角因 64 秒超时未取得", "real Codex runner、真实 codebase-memory provisioning、online model Eval"],
    "风险": ["L-01：rename 与清理同时失败可能降低诊断质量"],
    "下一步": "等待集成负责人接收 Reviewer 回传",
    "恢复提示": "从 sealed Reviewer 收据与冻结指纹继续 fan-in",
    "时间": "2026-07-26T22:03:00.000Z"
  },
  {
    "版本": 1,
    "编号": "HO-REVIEWER-V6",
    "类型": "子任务回传",
    "来源角色": "cognis_reviewer",
    "目标角色": "集成负责人",
    "Agent/运行收据": ".cognis/subagents/receipts/33aafad47db739b53017bce6e8953e56bfe3843bca919f0f9c6b5e5f9569ecd0.json",
    "状态": "已接收",
    "变更集指纹": "9834de2731b589c058bb393840acceeb8ba57880446f5ea0bd4b3a175d408c78",
    "已完成": ["完成独立 findings-first Reviewer 与 Red Team 审查", "父 Agent 核对 Reviewer 收据、finding 与实际 diff"],
    "未完成": ["父级 fan-in 集成验证"],
    "验证证据": ["Reviewer 收据 sealed/approved，起止指纹一致"],
    "未验证项": ["OCR 第二视角因 64 秒超时未取得", "real Codex runner、真实 codebase-memory provisioning、online model Eval"],
    "风险": ["L-01：rename 与清理同时失败可能降低诊断质量"],
    "下一步": "与 Tester 回传合并后执行父级验证",
    "恢复提示": "Reviewer 回传已接收，继续父级 fan-in",
    "时间": "2026-07-26T22:03:01.000Z"
  },
  {
    "版本": 1,
    "编号": "HO-REVIEWER-V6",
    "类型": "子任务回传",
    "来源角色": "cognis_reviewer",
    "目标角色": "集成负责人",
    "Agent/运行收据": ".cognis/subagents/receipts/33aafad47db739b53017bce6e8953e56bfe3843bca919f0f9c6b5e5f9569ecd0.json",
    "状态": "已返回",
    "变更集指纹": "9834de2731b589c058bb393840acceeb8ba57880446f5ea0bd4b3a175d408c78",
    "已完成": ["完成独立 findings-first Reviewer 与 Red Team 审查", "父 Agent 核对 Reviewer 收据、finding 与实际 diff", "Reviewer 回传完成 fan-in"],
    "未完成": ["父级 fan-in 集成验证"],
    "验证证据": ["Reviewer 收据 sealed/approved，Red Team 结论批准"],
    "未验证项": ["OCR 第二视角因 64 秒超时未取得", "real Codex runner、真实 codebase-memory provisioning、online model Eval"],
    "风险": ["L-01：rename 与清理同时失败可能降低诊断质量"],
    "下一步": "父 Agent 重跑任务合同声明的集成验证",
    "恢复提示": "Tester/Reviewer Handoff 均已返回，执行父级集成验证",
    "时间": "2026-07-26T22:03:02.000Z"
  },
  {
    "版本": 1,
    "编号": "HO-TESTER-V7",
    "类型": "子任务回传",
    "来源角色": "cognis_tester",
    "目标角色": "集成负责人",
    "Agent/运行收据": ".cognis/subagents/receipts/275cf82d2c58480acf13cd5103d26d064775b4ae4f928e61829db60acdeb8d7b.json",
    "状态": "待接收",
    "变更集指纹": "0c37cf0a306eba9713c03de5d22f8813b8df3ee5b8667d2d90c952692f2c477d",
    "已完成": ["独立运行 v7 Tester 完整验收矩阵"],
    "未完成": ["父级 fan-in 集成验证"],
    "验证证据": ["75/75、check 461 通过 2 跳过、integration 101 通过 1 跳过、smoke 10/10、docs 67、Eval 49/49"],
    "未验证项": ["real Codex runner、真实 codebase-memory provisioning、online model Eval"],
    "风险": ["504 个资产按 ownership 保持 unmanaged"],
    "下一步": "等待集成负责人接收 v7 Tester 回传",
    "恢复提示": "从 v7 sealed Tester 收据继续 fan-in",
    "时间": "2026-07-26T22:23:00.000Z"
  },
  {
    "版本": 1,
    "编号": "HO-TESTER-V7",
    "类型": "子任务回传",
    "来源角色": "cognis_tester",
    "目标角色": "集成负责人",
    "Agent/运行收据": ".cognis/subagents/receipts/275cf82d2c58480acf13cd5103d26d064775b4ae4f928e61829db60acdeb8d7b.json",
    "状态": "已接收",
    "变更集指纹": "0c37cf0a306eba9713c03de5d22f8813b8df3ee5b8667d2d90c952692f2c477d",
    "已完成": ["独立运行 v7 Tester 完整验收矩阵", "父 Agent 核对 Tester 收据与实际 Git 状态"],
    "未完成": ["父级 fan-in 集成验证"],
    "验证证据": ["v7 Tester 收据 sealed/passed，起止指纹一致"],
    "未验证项": ["real Codex runner、真实 codebase-memory provisioning、online model Eval"],
    "风险": ["504 个资产按 ownership 保持 unmanaged"],
    "下一步": "等待 v7 Reviewer 回传并执行 fan-in",
    "恢复提示": "v7 Tester 回传已接收，继续核对 Reviewer 收据",
    "时间": "2026-07-26T22:23:01.000Z"
  },
  {
    "版本": 1,
    "编号": "HO-TESTER-V7",
    "类型": "子任务回传",
    "来源角色": "cognis_tester",
    "目标角色": "集成负责人",
    "Agent/运行收据": ".cognis/subagents/receipts/275cf82d2c58480acf13cd5103d26d064775b4ae4f928e61829db60acdeb8d7b.json",
    "状态": "已返回",
    "变更集指纹": "0c37cf0a306eba9713c03de5d22f8813b8df3ee5b8667d2d90c952692f2c477d",
    "已完成": ["独立运行 v7 Tester 完整验收矩阵", "父 Agent 核对 Tester 收据与实际 Git 状态", "v7 Tester 回传完成 fan-in"],
    "未完成": ["父级 fan-in 集成验证"],
    "验证证据": ["v7 Tester 收据 sealed/passed，workspace 0c37cf0a...477d"],
    "未验证项": ["real Codex runner、真实 codebase-memory provisioning、online model Eval"],
    "风险": ["504 个资产按 ownership 保持 unmanaged"],
    "下一步": "与 v7 Reviewer 回传合并后重跑集成验证",
    "恢复提示": "v7 Tester Handoff 已返回，等待父级集成验证",
    "时间": "2026-07-26T22:23:02.000Z"
  },
  {
    "版本": 1,
    "编号": "HO-REVIEWER-V7",
    "类型": "子任务回传",
    "来源角色": "cognis_reviewer",
    "目标角色": "集成负责人",
    "Agent/运行收据": ".cognis/subagents/receipts/10c55a898bb602dbc0b08284370ca5cd9c89daef4f84b7294c0f3ebb2e753ff7.json",
    "状态": "待接收",
    "变更集指纹": "0c37cf0a306eba9713c03de5d22f8813b8df3ee5b8667d2d90c952692f2c477d",
    "已完成": ["完成 v7 独立 findings-first Reviewer 与 Red Team 审查"],
    "未完成": ["父级 fan-in 集成验证"],
    "验证证据": ["无 Critical、High 或未关闭 Medium；v7 Reviewer 结论批准"],
    "未验证项": ["OCR 第二视角超时", "real Codex runner、真实 codebase-memory provisioning、online model Eval"],
    "风险": ["L-01：rename 与清理同时失败可能降低诊断质量"],
    "下一步": "等待集成负责人接收 v7 Reviewer 回传",
    "恢复提示": "从 v7 sealed Reviewer 收据继续 fan-in",
    "时间": "2026-07-26T22:23:00.000Z"
  },
  {
    "版本": 1,
    "编号": "HO-REVIEWER-V7",
    "类型": "子任务回传",
    "来源角色": "cognis_reviewer",
    "目标角色": "集成负责人",
    "Agent/运行收据": ".cognis/subagents/receipts/10c55a898bb602dbc0b08284370ca5cd9c89daef4f84b7294c0f3ebb2e753ff7.json",
    "状态": "已接收",
    "变更集指纹": "0c37cf0a306eba9713c03de5d22f8813b8df3ee5b8667d2d90c952692f2c477d",
    "已完成": ["完成 v7 独立 findings-first Reviewer 与 Red Team 审查", "父 Agent 核对 Reviewer 收据、finding 与实际 diff"],
    "未完成": ["父级 fan-in 集成验证"],
    "验证证据": ["v7 Reviewer 收据 sealed/approved，起止指纹一致"],
    "未验证项": ["OCR 第二视角超时", "real Codex runner、真实 codebase-memory provisioning、online model Eval"],
    "风险": ["L-01：rename 与清理同时失败可能降低诊断质量"],
    "下一步": "与 v7 Tester 回传合并后执行父级验证",
    "恢复提示": "v7 Reviewer 回传已接收，继续父级 fan-in",
    "时间": "2026-07-26T22:23:01.000Z"
  },
  {
    "版本": 1,
    "编号": "HO-REVIEWER-V7",
    "类型": "子任务回传",
    "来源角色": "cognis_reviewer",
    "目标角色": "集成负责人",
    "Agent/运行收据": ".cognis/subagents/receipts/10c55a898bb602dbc0b08284370ca5cd9c89daef4f84b7294c0f3ebb2e753ff7.json",
    "状态": "已返回",
    "变更集指纹": "0c37cf0a306eba9713c03de5d22f8813b8df3ee5b8667d2d90c952692f2c477d",
    "已完成": ["完成 v7 独立 findings-first Reviewer 与 Red Team 审查", "父 Agent 核对 Reviewer 收据、finding 与实际 diff", "v7 Reviewer 回传完成 fan-in"],
    "未完成": ["父级 fan-in 集成验证"],
    "验证证据": ["v7 Reviewer 收据 sealed/approved，Red Team 结论批准"],
    "未验证项": ["OCR 第二视角超时", "real Codex runner、真实 codebase-memory provisioning、online model Eval"],
    "风险": ["L-01：rename 与清理同时失败可能降低诊断质量"],
    "下一步": "父 Agent 重跑任务合同声明的集成验证",
    "恢复提示": "v7 Tester/Reviewer Handoff 均已返回，执行父级集成验证",
    "时间": "2026-07-26T22:23:02.000Z"
  }
]
```

## 验收证据

| AC-ID | 证据类型 | 命令或产物 | 退出码 | 核验时间 | 核验者 | 实际结果 |
| --- | --- | --- | --- | --- | --- | --- |
| AC-01 | 命令 | node --test --test-concurrency=1 tests/handoff-governance.test.js | 0 | 2026-07-27T05:29:00+08:00 | 父 Agent | 20/20 通过；覆盖 v3、Handoff、严格输出、人工等价边界、v1 legacy-only、deterministic EEXIST 与失败清理。 |
| AC-02 | 命令 | pnpm test:integration | 0 | 2026-07-27T06:30:30+08:00 | 父 Agent | fan-in 后 102 项集成测试完成；101 通过、1 环境跳过、0 失败，覆盖 Codex full 与 Claude/Gemini 降级。 |
| AC-03 | 命令 | node --test --test-concurrency=1 tests/handoff-governance.test.js tests/hook-runtime.test.js tests/hook-installation.test.js tests/project-baseline.test.js tests/codex-adapter.test.js | 0 | 2026-07-27T05:33:00+08:00 | 父 Agent | 75/75 聚焦回归通过，包含稳定 receipt key、串行/并发 exclusive create、v1 兼容、失败清理、生命周期和安装健康度。 |
| AC-04 | 评测 | .cognis/evals/runs/2026-07-26T22-36-03-081Z.json | 0 | 2026-07-27T06:36:03+08:00 | 父 Agent | `pnpm cognis eval run --project . --mode offline --write` 重新核验通过；EVAL-HANDOFF-001/002/007/008 均通过，reference matched。 |
| AC-05 | 评测 | .cognis/evals/runs/2026-07-26T22-36-03-081Z.json | 0 | 2026-07-27T06:36:03+08:00 | 父 Agent | EVAL-HANDOFF-003..008 均通过；49 个 suite case 全部通过，critical pass rate 与 overall score 均为 1。 |
| AC-06 | 命令 | pnpm docs:audit | 0 | 2026-07-27T06:21:59+08:00 | 独立 Tester | 67 篇文档通过审计，Red Team 包已接入 catalog/index，源码、runtime、installer 和 self-host 镜像合同一致。 |
| AC-07 | 命令 | pnpm check | 0 | 2026-07-27T06:28:00+08:00 | 父 Agent | fan-in 后 lint、validation、routing、clarification 及 463 项测试完成；461 通过、2 跳过、0 失败。 |
| AC-07 | 命令 | pnpm smoke:lifecycle | 0 | 2026-07-27T06:30:30+08:00 | 父 Agent | fan-in 后 core/full 共 10 个 init、dry-run、write、validate、eval/doctor 步骤全部退出 0。 |
| AC-07 | 命令 | pnpm cognis validate --project . | 0 | 2026-07-27T05:45:00+08:00 | 父 Agent | self-host 为 ready；受支持 full dry-run/write 完成，67 个受管文件一致，Tester/Reviewer 已安装，504 个历史资产保持 unmanaged。 |

## 剩余风险

- Windows 并发全量测试中 fake runner 成功路径曾超过原 1 秒测试上限；成功路径测试上限已调为 5 秒，专门的 20ms timeout 反例保持不变并通过。
- 真实 codebase-memory provisioning 与 real Codex runner smoke 按环境条件跳过；online model Eval 未运行，offline replay 不替代真实派发证据。
- 504 个历史资产按 ownership 规则保持 unmanaged，20 个 `retire-modified` 资产由 installer 保留；当前 67 个受管文件一致。
- 第五轮两份 started 收据因原始 Hook identity 未保存在收据中且已无法安全恢复而不能封存或复用；doctor 将其保留为 `started: 2` 的 health-visible 历史异常，最终 Handoff 只引用第六轮新 turn 收据。
- 第五轮 Reviewer 的 deterministic EEXIST、v1 legacy 与失败清理 findings 已按 TDD 修复。
- v6 Tester/Reviewer 收据已 `sealed/passed` 与 `sealed/approved`，但创建 Red Team 包后首次 fan-in 检查发现 `docs/catalog.json` 漏项；catalog 修复改变 workspace 指纹，v6 收据与 HO-TESTER-V6/HO-REVIEWER-V6 不得用于最终完成门禁。
- v7 Tester/Reviewer 收据已 `sealed/passed` 与 `sealed/approved`，最终 workspace 指纹为 `0c37cf0a306eba9713c03de5d22f8813b8df3ee5b8667d2d90c952692f2c477d`；父级 fan-in 三命令均在两份收据完成后退出 0。
