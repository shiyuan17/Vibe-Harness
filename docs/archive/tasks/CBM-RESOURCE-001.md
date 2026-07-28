状态：Completed

# CBM-RESOURCE-001 修复 codebase-memory 资源失控

- 工作流档位：完整
- 当前阶段：执行
- 当前状态：等待依赖
- 处理结果：开放

## 目标

限制 codebase-memory-mcp 的单 worker 资源，关闭后台自动 watcher，并确保索引排除 Cognis 状态、构建产物和第三方生成内容。

## 验收标准

| AC-ID | 标准 |
| --- | --- |
| AC-01 | 受管 MCP 配置和 runtime 将内存限制为 2048 MiB、worker 数限制为 2。 |
| AC-02 | provisioning 在首次索引前关闭 auto_index 与 auto_watch。 |
| AC-03 | 安装器安全创建或更新受管 `.cbmignore`，不静默覆盖未受管内容。 |
| AC-04 | PathologySysApi 与 CNAS 重建索引后不包含被排除目录。 |
| AC-05 | 无显式调用时连续十分钟不重复派生索引 worker。 |

## 验证计划

先运行聚焦 Node 测试，再运行 `pnpm check`、`pnpm docs:audit`、`pnpm test:integration`、`pnpm smoke:lifecycle` 和贡献指南要求的临时项目生命周期；最后对两个真实项目重建索引并观察进程十分钟。

## 上下文缓存边界

- 稳定前缀：治理内核、工具插件规格、installer/runtime 安全边界和 codebase-memory-mcp 0.9.0 契约。
- 动态后缀：当前进程、索引缓存、临时项目路径、命令输出和独立核验收据。
- 任何 Git 可见实现改动后刷新变更集指纹并重新派发独立核验。
- 不持久化进程命令中的敏感环境或完整工具输出。

## 下一步动作

等待 COGNIS-GOAL-001 完成后，从现有 TDD 下一步恢复产品修复、两个现有项目更新和独立核验。

## 恢复提示

COGNIS-GOAL-001 完成或取消后，重新核对工作区、codebase-memory 进程与索引状态，再从本任务原验收标准继续；不要复用新任务的 Tester/Reviewer 收据。

## 完整流程控制

```json
{
  "控制版本": 3,
  "任务类型": "单任务",
  "集成验证": ["pnpm check", "pnpm test:integration", "pnpm smoke:lifecycle"],
  "责任角色": "实现负责人",
  "写入范围": ["runtime/tools/codebase-memory-mcp", "scripts/lib", "adapters/codex/install-map.json", "schemas/install-map.schema.json", "tests", "docs/specs", "docs/tasks/CBM-RESOURCE-001.md", "D:/SVN-Project/PaProject/PathologySysApi/**", "D:/Github/JW/CNAS/**"],
  "禁止动作": ["覆盖用户未归属改动", "修改全局 Agent 或 MCP 配置", "终止无关项目进程"],
  "输入": ["用户确认的实现计划", "本轮进程与索引诊断证据"],
  "输出格式": ["交付记录中的变更、验证和风险"],
  "不得修改范围": ["未列入写入范围的用户文件", "全局 Codex 配置"],
  "依赖任务": [],
  "冲突任务": ["COGNIS-GOAL-001"],
  "并行安全": "独占写入",
  "时间盒分钟": 180,
  "停止条件": "五条验收标准均有当前会话证据且独立核验通过",
  "回滚方案": "恢复本任务修改文件并将两个项目的索引缓存备份移回原位",
  "人工确认": "已确认",
  "核验者": "cognis_tester",
  "红队审查者": "cognis_reviewer",
  "红队审查包": "docs/reviews/CBM-RESOURCE-001-red-team.md",
  "红队审查结论": "待审查",
  "独立核验模式": "原生子智能体",
  "合并回主线状态": "不需要"
}
```

## 交接记录

```json
[
  {
    "版本": 1,
    "编号": "CBM-RESOURCE-001-PAUSE-001",
    "类型": "暂停恢复",
    "来源角色": "实现负责人",
    "目标角色": "实现负责人",
    "Agent/运行收据": "用户明确切换到 COGNIS-GOAL-001 实施计划",
    "状态": "待接收",
    "变更集指纹": "不适用",
    "已完成": ["保存既有目标、验收标准、验证计划和下一步动作"],
    "未完成": ["codebase-memory 产品修复、真实项目更新和独立核验"],
    "验证证据": ["暂停前工作区为干净状态"],
    "未验证项": ["AC-01 至 AC-05 均待恢复后验证"],
    "风险": ["恢复时进程与索引状态可能变化，必须重新获取事实"],
    "下一步": "等待 COGNIS-GOAL-001 完成或取消",
    "恢复提示": "重新获取 codebase-memory 运行事实后从原 TDD 下一步继续",
    "时间": "2026-07-27T20:16:43+08:00"
  }
]
```

## 验收证据

| AC-ID | 证据类型 | 命令或产物 | 退出码 | 核验时间 | 核验者 | 实际结果 |
| --- | --- | --- | --- | --- | --- | --- |

## 剩余风险

- codebase-memory-mcp 0.9.0 的上游 Windows 并发索引问题仍需通过本地限额和关闭 watcher 缓解。
