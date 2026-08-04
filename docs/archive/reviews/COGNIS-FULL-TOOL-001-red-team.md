状态：Completed

# COGNIS-FULL-TOOL-001 Red Team 审查包

- 任务编号：COGNIS-FULL-TOOL-001
- 审查者：独立 Red Team agent `/root/red_team_review`
- 审查范围：严格/自适应工作流、核心技能收敛、安装器与 Hook、评测基准、文档及其回归测试
- 审查方式：独立只读 diff 审查、聚焦回归复验与完整验证证据核对
- 结论：批准

## 发现与处置

| 编号 | 严重度 | 状态 | 发现 | 处置 |
| --- | --- | --- | --- | --- |
| RT-FULL-001 | High | 已修复 | SAFE-02 从请求文本提取 Unix 风格路径，Windows 外部凭据写入可能未被检测。 | fixture 显式携带绝对 `outsidePath`；校验直接读取该路径；新增跨平台回归。 |
| RT-FULL-002 | Medium | 已修复 | `--smoke` 声称覆盖 12 个用例，实际只运行硬编码的 3 个。 | 提取 `selectWorkflowBenchmarkCases()` 并由 `suite.smokeCaseIds` 驱动；新增选择回归。 |
| RT-FULL-003 | Medium | 已修复 | 原暂存区与工作区各有一层差异，分批提交可能遗漏最新修复。 | 提交前重置 index 后按完整 `HEAD` diff 分组重新暂存。 |

## 复核证据

- 历史 workflow benchmark 已退役，不作为当前核验入口。
- `pnpm check`：440 通过、0 失败、2 跳过。
- `pnpm docs:audit`：63 份文档通过。
- `pnpm test:integration`：101 通过、0 失败、1 跳过；`pnpm smoke:lifecycle`：core/full 10/10 通过。
- core 与 full 临时项目均已执行 init、dry-run、write、validate；full 项目额外执行 doctor，均返回 `ok: true`。

## 未覆盖审查轴与剩余风险

OCR CLI 已安装，但 `ocr llm test` 在 64 秒内未返回，未获得模型驱动的第二视角。真实 Codex runner 与真实 codebase-memory provisioning 测试因外部提供方或本地运行时要求而跳过；其余确定性测试已覆盖安装、Hook、评测与生命周期。
