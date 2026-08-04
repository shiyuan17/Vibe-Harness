状态：Completed

# COGNIS-GOAL-001 Red Team 审查包

- 任务编号：COGNIS-GOAL-001
- 审查者：cognis_reviewer
- 审查对象：workspace 指纹 `afbbfc0690eeea649060ba68e19ca21de3d096902f8f48ace5010ad561c9076d` 对应的完整 diff、任务验收标准与验证证据
- 审查时间：2026-07-27T13:51:19.310Z

## 审查范围

正确性与边界、安全与滥用、架构依赖、测试有效性、发布与回滚、治理合规；本任务不包含 UI，跨 adapter 的 Goal capability、安装和降级合同通过 schema、installer、integration 与 Eval 证据核对。

## 问题列表

| 问题编号 | 严重度 | 状态 | 位置 | 触发方式 | 影响 | 最小修复方向 |
| --- | --- | --- | --- | --- | --- | --- |
| RT-GOAL-001 | High | 已修复 | `scripts/eval-goal-check.js`、`scripts/lib/goal-definition-metrics.js` | 以零 trials 调用 evaluator，或只运行旧 `pnpm eval:goal` | 未执行 Goal 行为试验仍可绿灯，无法证明长度、激活和活动目标冲突 | 已增加 12×3 确定性 trial，并拒绝缺失、重复、越界 repetition 与错误行为 |
| RT-GOAL-002 | Medium | 已修复 | `schemas/adapter-pack.schema.json` | 删除 adapter 的 `capabilities.goals` 后执行 schema validation | capability 不完整仍可通过 catalog schema | 已将 `goals` 加入 capability required，并增加删除字段反例 |

## Medium 延期

| 问题编号 | 理由 | 责任人 | 关闭条件 | 批准者 |
| --- | --- | --- | --- | --- |

## 已核验证据

- 第一轮 Reviewer 收据：`.cognis/subagents/receipts/17ddf05dbe21505bc313005a5cc316678f7a48de68daa91677f3dae5b546e965.json`，终态 `invalid/changes-requested`，原因是结论未批准而非输出或指纹无效。
- 第一轮 Tester 收据：`.cognis/subagents/receipts/16442e9f63f416d544e8ed8c4ae0cba2e2709eb7be23f5fda2165669c8097949.json`，`sealed/passed`；实现修复后已因变更集变化失效，不用于最终门禁。
- RED：`node --test --test-concurrency=1 tests/goal-definition-metrics.test.js tests/manifest-schema.test.js` 在零 trials 与缺失 `goals` 反例上 2 项失败。
- GREEN：同一聚焦范围与 Goal/manifest/cross-adapter 回归共 44/44 通过；`pnpm eval:goal` 报告 12 cases、36 trials，`pnpm eval:check`、`pnpm docs:audit` 和 `git diff --check` 退出 0。
- 最终 Tester 收据：`.cognis/subagents/receipts/9a1718e785f2a923a0a40fa0dd72bd5a9160294c1de32c1277cae59d34ac5866.json`，`sealed/passed`，起止 workspace 与 protected-evidence 指纹一致。
- 最终 Reviewer 收据：`.cognis/subagents/receipts/68ca53708140b26e9f8eedac766b0ab92eff3412a00dc3e3209ca1f39c6b3c77.json`，`sealed/approved`，无开放 Critical、High、Medium 或 Low finding。
- 独立复审：Goal 零/缺失/重复/越界 repetition、四类错误激活均失败；分别删除 Codex、Claude、Gemini 的 `goals` 均 schema 失败；聚焦回归 47/47 通过。
- 独立完整矩阵：`pnpm check` 471 通过、2 环境跳过；`pnpm test:integration` 106 通过、1 环境跳过；`pnpm smoke:lifecycle` 10/10；`pnpm docs:audit` 70 篇；core/full 临时生命周期全部退出 0。
- 父 Agent fan-in 后重跑：`pnpm check` 471 通过、2 环境跳过；`pnpm docs:audit` 70 篇；`pnpm test:integration` 106 通过、1 环境跳过；`pnpm smoke:lifecycle` 10/10；`git diff --check` 退出 0，完成时间 2026-07-27T21:57:10+08:00。
- online canary 在缺少 `CODEX_MODEL` 时只允许记录 degraded，不作为通过证据。

## 未覆盖审查轴与剩余风险

- real Codex online model Eval 依赖运行环境提供 `CODEX_MODEL`，当前仅有 degraded 产物。
- OpenAI 公共 Codex manual 未提供可验证的 `/goal` 命令合同；实现以宿主原生 Goal capability 探测和可移植 Goal Brief 降级为边界，不模拟自定义命令。
- OCR 第二视角请求超时；最终由独立 Reviewer 完成全部必需审查轴。

## 结论

批准
