# 评测驱动开发

Cognis 使用 Eval-Driven Development 管理 Agent 规则、Skill、模板、适配器和 Hook 的非确定性行为。确定性代码仍使用单元测试与 TDD；评测补充“Agent 在场景中是否做对了”的证据。

## 合同

- suite：版本化场景、oracle、critical 断言和四维权重。
- run：一次 offline 或 online 执行的逐案例结果、汇总分数和 fingerprint。
- reference：经过人工批准的汇总结果，不包含原始对话、凭据或绝对路径。

项目 `baseline` 是安装、工具和验证状态快照；evaluation `reference` 是评测比较基准。两者用途、命令和生命周期不同。

## 项目配置

```json
{
  "validationCommands": {
    "eval": "node .agents/cognis/evals/run.mjs --project . --suite .agents/evals/suites/cognis-core.json --reference .agents/evals/references/cognis-core.offline.json"
  },
  "evaluations": {
    "enabled": true,
    "suites": [".agents/evals/suites/cognis-core.json"],
    "reference": "evals/references/project.json",
    "thresholds": {
      "criticalPassRate": 1,
      "overallScore": 0.90,
      "maxCapabilityRegression": 0.05
    },
    "onlineRunner": null,
    "repetitions": 3
  }
}
```

`.agents/evals/references/cognis-core.offline.json` 是随 profile 安装的只读 seed，仅供内建离线 runtime 自检；项目审批生成的 reference 必须写入 `evals/references/` 等项目自有路径，不能覆盖 `.agents/` 下的安装器受管文件。

## 生命周期

```bash
pnpm cognis eval check --project ../some-project
pnpm cognis eval run --project ../some-project --mode offline
pnpm cognis eval run --project ../some-project --mode offline --write
pnpm cognis eval reference --project ../some-project --from .cognis/evals/runs/<run>.json --write --confirm-reference-update
```

评测只使用 `--project` 和 `--write`；旧的路径型 `--target` 与 `--apply` 不属于当前生命周期。reference 已存在时还需要 `--force`，并在覆盖前创建项目内备份。reference 更新必须单独审查，不能为让变更通过而自动提升基准。

## Online Runner

Runner 从 stdin 接收一个 JSON 请求，在一次性项目中执行一个案例，并在 stdout 输出唯一 JSON 对象。stdout/stderr 各限制 1 MiB，单次超时 10 分钟，最多重复 3 次。模型输出是不可信输入；非法 JSON、超时、输出超限、缺少 CLI 或凭据报告为 degraded。参考 runner 为每次执行隔离 `HOME`、`USERPROFILE` 和 `CODEX_HOME`，只用存在性、大小和 SHA-256 比较受保护配置；检测变化时产生 `global-agent-write`，不保存配置正文或真实用户路径。

首版提供 Codex 参考 runner；Claude Code 与 Gemini CLI 可以实现同一协议，但不在本版本安装在线适配器。真实 Agent 不能直接在源仓库或用户工作区运行评测。

## CI 校准

- PR 阻断 `eval:check` 和 `eval:offline` 的合同或 critical 回归。
- 每日 online canary 运行 6 个 critical 场景，每个 3 次，产物保留 30 天。
- 前 20 次成功 scheduled run 只做 advisory 校准。
- 启用门禁后要求 critical `3/3` 通过、总分至少 `0.90`，任一能力域下降不超过 `0.05`。
- runner 或供应商不可用是 degraded，不算行为回归；前两次在 job summary 告警，连续第三次由 `eval:health` 使 scheduled workflow 失败。一次 ready 会清零连续计数。
- 真实断言失败始终是 invalid，不因校准期而隐藏。

## Adaptive / Strict 对照

`evals/workflow-benchmark/cases.json` 固定 40 个真实任务合同，每条路径重复 3 次；其中 12 个案例用于受影响能力的 PR smoke。使用 `pnpm eval:workflow:check` 校验案例数量、类别和指标合同；runner 生成两份 120-attempt run 后，执行：

```bash
pnpm eval:workflow:compare --adaptive <adaptive-run.json> --strict <strict-run.json>
```

比较器报告 pass@1、pass@3、pass^3、按任务配对 bootstrap 下界、共同成功尝试的三项效率下降，以及全部尝试的每成功任务成本。发布要求 pass@1 95% 下界不低于 -2pp、critical 零失败、交互/墙钟/Token 中位数分别下降至少 40%/30%/35%。Runner 不可用可以让 PR 只做合同检查，但不能批准 release reference。

启用在线 workflow 前配置仓库变量 `CODEX_CLI_VERSION`、`CODEX_MODEL` 和 secret `OPENAI_API_KEY`。前 20 次成功校准后，将仓库变量 `COGNIS_EVAL_ENFORCE` 设为 `1` 启用 invalid 门禁；缺少运行配置时 workflow 上传脱敏 degraded 诊断并参与连续健康计数。workflow 只申请 `actions:read` 和 `contents:read`，不创建 Issue 或修改仓库状态。

## 故障恢复

先确认 suite、runner、模型、Agent CLI 版本和治理 hash 是否与 reference 一致。fingerprint 不一致时建立新的候选 reference 并审查，不得强行比较。评测失败时保留失败 run，修复行为后重跑相同 Eval-ID；reference 被误改时从 Git 恢复批准版本。
