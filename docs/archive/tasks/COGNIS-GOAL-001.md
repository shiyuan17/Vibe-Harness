状态：Completed

# COGNIS-GOAL-001 强化需求澄清与持久目标模式

- 工作流档位：完整
- 当前阶段：交付
- 当前状态：空闲
- 处理结果：完成

## 目标

让 Cognis 在普通任务中保持最少必要澄清，在显式需求探索中形成完整需求认知，并通过独立 `define-goal` Skill 将结果转成 Codex 原生持久目标或跨平台可移植目标书。

## 验收标准

| AC-ID | 标准 |
| --- | --- |
| AC-01 | `clarify-requirements` 区分普通解阻与显式需求发现，事实问题不转交用户，高影响产品决定不静默默认。 |
| AC-02 | `define-goal` 生成不超过 4000 字符、覆盖结果/事实/决定/边界/验收/续跑的执行型或探索型 Goal Brief。 |
| AC-03 | 只有显式激活且宿主能力可用时才调用原生 Goal；已有目标不被静默替换，非 Codex 宿主提供诚实的可移植降级。 |
| AC-04 | core/full、Codex/Claude/Gemini 的 catalog、adapter capability、安装与升级生命周期一致，minimal/docs-only 不新增 Skill。 |
| AC-05 | clarification、goal、routing、offline/online Eval、确定性测试、临时项目生命周期和独立 Tester/Reviewer 覆盖关键反例。 |

## 验证计划

先冻结现有 routing、clarification、offline 与 online baseline；按 Eval/TDD 添加失败合同，再实现 Skill 与安装面。运行聚焦 Node 测试、Skill/Eval 审计、`pnpm check`、`pnpm docs:audit`、`pnpm test:integration`、`pnpm smoke:lifecycle` 和 core/full 临时项目命令；冻结变更集后派发独立 Tester 与 Reviewer，fan-in 后重跑集成验证。

## 上下文缓存边界

- 稳定前缀：治理内核、Skill 路由、Goal Brief 合同、adapter capability 与评测规格。
- 动态后缀：当前 diff、临时项目、runner 状态、命令输出、变更集指纹与独立收据。
- Skill、routing、adapter 或 Eval 变化后刷新治理指纹；任何 Git 可见实现改动使旧核验失效。
- 不持久化原始对话、凭据、绝对临时路径或在线 runner 敏感环境。

## 下一步动作

无。最终 Tester/Reviewer 已对指纹 `afbbfc0690eeea649060ba68e19ca21de3d096902f8f48ace5010ad561c9076d` 完成独立回传，父 Agent 已在两份收据完成后重跑四个集成验证命令。

## 完整流程控制

```json
{
  "控制版本": 3,
  "任务类型": "单任务",
  "集成验证": ["pnpm check", "pnpm docs:audit", "pnpm test:integration", "pnpm smoke:lifecycle"],
  "责任角色": "实现负责人",
  "写入范围": ["skills/core/clarify-requirements", "skills/core/define-goal", ".agents/skills/clarify-requirements", ".agents/skills/define-goal", "rules", "docs/rules", "manifests", "adapters/codex/install-map.json", "schemas/adapter-pack.schema.json", "evals", "scripts", "tests", "package.json", "README.md", "README.zh-CN.md", "docs/architecture.md", "docs/migration-guide.md", "docs/inventory", "docs/tasks/COGNIS-GOAL-001.md", "docs/tasks/CBM-RESOURCE-001.md", "docs/reviews/COGNIS-GOAL-001-red-team.md", "docs/catalog.json"],
  "禁止动作": ["覆盖用户未归属改动", "修改全局 Agent 或 MCP 配置", "实现自定义 /goal 命令替代宿主原生能力", "降低评测阈值或自动批准 reference", "修改 codebase-memory 产品实现或真实项目"],
  "输入": ["用户确认的实施计划", "leader Skill 固定来源与公开最佳实践", "改动前 Eval baseline"],
  "输出格式": ["Goal Brief 公共合同", "Skill 与 adapter 安装面", "评测和测试证据", "独立核验 Handoff"],
  "不得修改范围": ["runtime/tools/codebase-memory-mcp", "D:/Github/JW/CNAS", "D:/SVN-Project/PaProject/PathologySysApi", "全局 Agent 配置"],
  "依赖任务": [],
  "冲突任务": ["CBM-RESOURCE-001"],
  "并行安全": "独占写入",
  "时间盒分钟": 180,
  "停止条件": "五条验收标准均有本轮证据，Tester 通过且 Reviewer 批准",
  "回滚方案": "按任务 diff 恢复 Skill、Eval、catalog、adapter、文档与任务合同，保留 CBM 可恢复暂停记录",
  "人工确认": "已确认",
  "核验者": "cognis_tester",
  "红队审查者": "cognis_reviewer",
  "红队审查包": "docs/reviews/COGNIS-GOAL-001-red-team.md",
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
    "编号": "HO-GOAL-TESTER-FINAL",
    "类型": "子任务回传",
    "来源角色": "cognis_tester",
    "目标角色": "实现负责人",
    "Agent/运行收据": ".cognis/subagents/receipts/9a1718e785f2a923a0a40fa0dd72bd5a9160294c1de32c1277cae59d34ac5866.json",
    "状态": "待接收",
    "变更集指纹": "afbbfc0690eeea649060ba68e19ca21de3d096902f8f48ace5010ad561c9076d",
    "已完成": ["独立运行最终 Tester 完整验收矩阵"],
    "未完成": ["父级 fan-in 集成验证"],
    "验证证据": ["聚焦 16/16、check 471 通过 2 跳过、integration 106 通过 1 跳过、smoke 10/10、docs 70、Goal 12×3、offline score 1"],
    "未验证项": ["真实 Codex online model Eval", "真实 Codex runner smoke", "真实 codebase-memory provisioning"],
    "风险": ["在线模型行为仍缺 provider 证据"],
    "下一步": "等待实现负责人接收 Tester 回传",
    "恢复提示": "从 sealed Tester 收据与冻结指纹继续 fan-in",
    "时间": "2026-07-27T13:52:00.000Z"
  },
  {
    "版本": 1,
    "编号": "HO-GOAL-TESTER-FINAL",
    "类型": "子任务回传",
    "来源角色": "cognis_tester",
    "目标角色": "实现负责人",
    "Agent/运行收据": ".cognis/subagents/receipts/9a1718e785f2a923a0a40fa0dd72bd5a9160294c1de32c1277cae59d34ac5866.json",
    "状态": "已接收",
    "变更集指纹": "afbbfc0690eeea649060ba68e19ca21de3d096902f8f48ace5010ad561c9076d",
    "已完成": ["独立运行最终 Tester 完整验收矩阵", "父 Agent 核对 Tester 收据与实际 Git 状态"],
    "未完成": ["父级 fan-in 集成验证"],
    "验证证据": ["Tester 收据 sealed/passed，起止 workspace 与 protected-evidence 指纹一致"],
    "未验证项": ["真实 Codex online model Eval", "真实 Codex runner smoke", "真实 codebase-memory provisioning"],
    "风险": ["在线模型行为仍缺 provider 证据"],
    "下一步": "等待 Reviewer 回传并执行 fan-in",
    "恢复提示": "Tester 回传已接收，继续核对 Reviewer 收据",
    "时间": "2026-07-27T13:52:01.000Z"
  },
  {
    "版本": 1,
    "编号": "HO-GOAL-TESTER-FINAL",
    "类型": "子任务回传",
    "来源角色": "cognis_tester",
    "目标角色": "实现负责人",
    "Agent/运行收据": ".cognis/subagents/receipts/9a1718e785f2a923a0a40fa0dd72bd5a9160294c1de32c1277cae59d34ac5866.json",
    "状态": "已返回",
    "变更集指纹": "afbbfc0690eeea649060ba68e19ca21de3d096902f8f48ace5010ad561c9076d",
    "已完成": ["独立运行最终 Tester 完整验收矩阵", "父 Agent 核对 Tester 收据与实际 Git 状态", "Tester 回传完成 fan-in"],
    "未完成": ["父级 fan-in 集成验证"],
    "验证证据": ["Tester 收据 sealed/passed，workspace afbbfc06...9076d"],
    "未验证项": ["真实 Codex online model Eval", "真实 Codex runner smoke", "真实 codebase-memory provisioning"],
    "风险": ["在线模型行为仍缺 provider 证据"],
    "下一步": "与 Reviewer 回传合并后重跑集成验证",
    "恢复提示": "Tester Handoff 已返回，等待父级集成验证",
    "时间": "2026-07-27T13:52:02.000Z"
  },
  {
    "版本": 1,
    "编号": "HO-GOAL-REVIEWER-FINAL",
    "类型": "子任务回传",
    "来源角色": "cognis_reviewer",
    "目标角色": "实现负责人",
    "Agent/运行收据": ".cognis/subagents/receipts/68ca53708140b26e9f8eedac766b0ab92eff3412a00dc3e3209ca1f39c6b3c77.json",
    "状态": "待接收",
    "变更集指纹": "afbbfc0690eeea649060ba68e19ca21de3d096902f8f48ace5010ad561c9076d",
    "已完成": ["完成最终 findings-first Reviewer 与 Red Team 审查"],
    "未完成": ["父级 fan-in 集成验证"],
    "验证证据": ["无开放 Critical、High、Medium 或 Low；RT-GOAL-001/002 已关闭；Reviewer 结论批准"],
    "未验证项": ["OCR 第二视角超时", "真实 Codex online model Eval"],
    "风险": ["公开 Codex manual 未提供 /goal 合同，依赖宿主 capability 探测与可移植降级"],
    "下一步": "等待实现负责人接收 Reviewer 回传",
    "恢复提示": "从 sealed Reviewer 收据与冻结指纹继续 fan-in",
    "时间": "2026-07-27T13:52:03.000Z"
  },
  {
    "版本": 1,
    "编号": "HO-GOAL-REVIEWER-FINAL",
    "类型": "子任务回传",
    "来源角色": "cognis_reviewer",
    "目标角色": "实现负责人",
    "Agent/运行收据": ".cognis/subagents/receipts/68ca53708140b26e9f8eedac766b0ab92eff3412a00dc3e3209ca1f39c6b3c77.json",
    "状态": "已接收",
    "变更集指纹": "afbbfc0690eeea649060ba68e19ca21de3d096902f8f48ace5010ad561c9076d",
    "已完成": ["完成最终 findings-first Reviewer 与 Red Team 审查", "父 Agent 核对 Reviewer 收据、finding 与实际 diff"],
    "未完成": ["父级 fan-in 集成验证"],
    "验证证据": ["Reviewer 收据 sealed/approved，起止 workspace 与 protected-evidence 指纹一致"],
    "未验证项": ["OCR 第二视角超时", "真实 Codex online model Eval"],
    "风险": ["公开 Codex manual 未提供 /goal 合同，依赖宿主 capability 探测与可移植降级"],
    "下一步": "与 Tester 回传合并后执行父级验证",
    "恢复提示": "Reviewer 回传已接收，继续父级 fan-in",
    "时间": "2026-07-27T13:52:04.000Z"
  },
  {
    "版本": 1,
    "编号": "HO-GOAL-REVIEWER-FINAL",
    "类型": "子任务回传",
    "来源角色": "cognis_reviewer",
    "目标角色": "实现负责人",
    "Agent/运行收据": ".cognis/subagents/receipts/68ca53708140b26e9f8eedac766b0ab92eff3412a00dc3e3209ca1f39c6b3c77.json",
    "状态": "已返回",
    "变更集指纹": "afbbfc0690eeea649060ba68e19ca21de3d096902f8f48ace5010ad561c9076d",
    "已完成": ["完成最终 findings-first Reviewer 与 Red Team 审查", "父 Agent 核对 Reviewer 收据、finding 与实际 diff", "Reviewer 回传完成 fan-in"],
    "未完成": ["父级 fan-in 集成验证"],
    "验证证据": ["Reviewer 收据 sealed/approved，Red Team 结论批准"],
    "未验证项": ["OCR 第二视角超时", "真实 Codex online model Eval"],
    "风险": ["公开 Codex manual 未提供 /goal 合同，依赖宿主 capability 探测与可移植降级"],
    "下一步": "父 Agent 重跑任务合同声明的集成验证",
    "恢复提示": "Tester/Reviewer Handoff 均已返回，执行父级集成验证",
    "时间": "2026-07-27T13:52:05.000Z"
  }
]
```

## 验收证据

| AC-ID | 证据类型 | 命令或产物 | 退出码 | 核验时间 | 核验者 | 实际结果 |
| --- | --- | --- | --- | --- | --- | --- |
| AC-01 | 命令 | pnpm check | 0 | 2026-07-27T21:57:10+08:00 | 父 Agent | fan-in 后全量检查 473 项：471 通过、2 项环境跳过、0 失败；clarification 24-case catalog 与发现/解阻反例通过。 |
| AC-02 | 命令 | pnpm check | 0 | 2026-07-27T21:57:10+08:00 | 父 Agent | `eval:goal` 子命令验证 12 cases、36 trials；六段结构、4000 字符、缺失/重复/越界 repetition 回归通过。 |
| AC-03 | 审查 | docs/reviews/COGNIS-GOAL-001-red-team.md | 0 | 2026-07-27T21:51:19+08:00 | 独立 Reviewer | Reviewer 收据 sealed/approved；零/缺失/重复/越界及四类错误激活反例失败，活动目标不静默替换，unsupported host 可移植降级。 |
| AC-04 | 命令 | pnpm test:integration | 0 | 2026-07-27T21:57:10+08:00 | 父 Agent | fan-in 后 107 项集成测试：106 通过、1 项真实 provisioning 环境跳过、0 失败；跨 adapter/profile 与 schema 合同通过。 |
| AC-04 | 命令 | pnpm smoke:lifecycle | 0 | 2026-07-27T21:57:10+08:00 | 父 Agent | core/full 共 10 个 init、dry-run、write、validate、eval/doctor 步骤全部退出 0。 |
| AC-05 | 命令 | pnpm docs:audit | 0 | 2026-07-27T21:57:10+08:00 | 父 Agent | fan-in 后 70 篇文档通过审计，任务、Red Team、catalog 与需求/目标公共说明一致。 |
| AC-05 | 命令 | pnpm eval:offline | 0 | 2026-07-27T21:50:28+08:00 | 独立 Tester | criticalPassRate=1、overallScore=1；skills audit 为 8 native、2 integration、0 router。 |

## 剩余风险

- online Codex runner 依赖运行环境提供 `CODEX_MODEL`；不可用时必须记录 degraded，不能替代真实模型证据。
- 真实 Codex runner smoke 与真实 codebase-memory provisioning 按环境条件跳过；不属于本任务产品实现范围。
- OCR 第二视角请求超时，已由独立 Reviewer 完成全部必需审查轴并批准。
- 独立验收在系统 Temp 保留了 core/full 临时项目；它们不在 Git 工作区，也不影响安装一致性证据。
