状态：Completed

# COGNIS-ADAPTIVE-002 移除旧产品兼容并精简 Adaptive

- 工作流档位：完整
- 当前阶段：核验
- 当前状态：进行中
- 处理结果：开放

## 目标

删除旧产品可执行兼容层与退役 workflow benchmark，并让 Adaptive 只为显式绑定的完整任务加载上下文和完成门禁。

## 验收标准

| AC-ID | 标准 |
| --- | --- |
| AC-01 | 旧产品项目被只读拒绝，不写入 Cognis 资产。 |
| AC-02 | 未绑定 Adaptive 会话不加载任务或运行完整治理。 |
| AC-03 | 显式绑定完整任务后恢复其现有完整核验门禁。 |
| AC-04 | 不再存在可执行的 workflow benchmark 入口。 |
| AC-05 | 安装、校验与临时项目生命周期保持通过。 |

## 验证计划

先运行新增 Hook 与 legacy 回归测试，再运行受影响测试、`pnpm check`、`pnpm docs:audit`、`pnpm test:integration`、`pnpm smoke:lifecycle` 和 core/full 临时项目安装矩阵。

## 下一步动作

冻结当前变更集，等待 Tester 与 Reviewer 独立回传；fan-in 后重跑集成验证。

## 完整流程控制

```json
{
  "控制版本": 3,
  "任务类型": "单任务",
  "集成验证": ["pnpm check", "pnpm docs:audit", "pnpm test:integration", "pnpm smoke:lifecycle"],
  "责任角色": "实现负责人",
  "写入范围": ["adapters", "docs", "evals", "manifests", "runtime", "scripts", "schemas", "skills", "tests", "package.json", ".gitignore"],
  "禁止动作": ["覆盖用户未归属改动", "写入全局 Agent 配置", "自动迁移或删除旧产品项目"],
  "输入": ["用户确认的实施计划"],
  "输出格式": ["交付记录中的变更、验证和风险"],
  "不得修改范围": ["目标项目的旧产品资产", "全局 Codex 配置"],
  "依赖任务": [],
  "冲突任务": ["CBM-RESOURCE-001"],
  "并行安全": "独占写入",
  "时间盒分钟": 240,
  "停止条件": "五条验收标准均获当前证据、Tester 通过且 Reviewer 批准",
  "回滚方案": "恢复本任务 diff，保留用户既有工作区改动",
  "人工确认": "已确认",
  "核验者": "cognis_tester",
  "红队审查者": "cognis_reviewer",
  "红队审查包": "docs/reviews/COGNIS-ADAPTIVE-002-red-team.md",
  "红队审查结论": "待审查",
  "独立核验模式": "原生子智能体",
  "合并回主线状态": "不需要"
}
```

## 交接记录

```json
[]
```

## 验收证据

| AC-ID | 证据类型 | 命令或产物 | 退出码 | 核验时间 | 核验者 | 实际结果 |
| --- | --- | --- | --- | --- | --- | --- |
| AC-01 | 自动化 | `tests/legacy-unsupported.test.js`、`tests/cognis-cli.test.js` | 0 | 2026-07-28 | 实现负责人 | 旧配置被 `COGNIS_LEGACY_UNSUPPORTED` 拒绝，未创建 Cognis 状态。 |
| AC-02/03 | 自动化 | `tests/adaptive-task-binding.test.js`、`tests/hook-runtime.test.js` | 0 | 2026-07-28 | 实现负责人 | 无绑定会话无上下文/Stop 门禁；绑定完整任务才恢复上下文。 |
| AC-04 | 自动化 | `pnpm test`、可执行入口搜索 | 0 | 2026-07-28 | 实现负责人 | benchmark 命令、实现、fixture 和测试已退役。 |
| AC-05 | 自动化 | `pnpm check`、`pnpm docs:audit`、`pnpm test:integration`、`pnpm smoke:lifecycle`、core/full 临时项目矩阵 | 0 | 2026-07-28 | 实现负责人 | 全部通过；full doctor 返回 ready。 |

## 剩余风险

- 此版本不再升级旧产品项目；用户必须先自行备份和清理旧资产。
