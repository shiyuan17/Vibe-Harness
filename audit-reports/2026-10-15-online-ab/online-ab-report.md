# Vibe-Harness 在线 A/B 对照报告（2026-10-15）

本轮按用户指令把宿主 `CODEX_MODEL` 固定为 `deepseek-flash`，执行此前因「无 `CODEX_MODEL` 与真实 Codex 宿主能力」而保持未验证的在线对照。原始逐次运行产物保存在 `.vibe-harness/evals/VH-REVIEW-2026-10-15-online/`（gitignored，本机保留），预算账本为 `.vibe-harness/evals/VH-REVIEW-2026-10-15-online.json`，本节目录内的 `online-ab-evidence.json` 是可提交的精简副本。

## 1. 结论摘要

| 判定 | 结论 | 依据 |
| --- | --- | --- |
| 代码修复通过 | **是**（沿用本批离线证据） | `pnpm check`、`test:integration` 667 例、`test:matrix` 97/97、`smoke:lifecycle` 全绿 |
| 行为对照通过 | **部分**：无新增关键失败模式、聚合通过数不低于基线，但严格「每个场景不低于基线」在 H11／H22 未满足 | 本节第 5 节分场景表 |
| 效率收益已证实 | **否**：配对中位总 Token 上升 32.5%，未达到「常见小任务配对中位下降 ≥10%」 | 本节第 7 节 |
| 宿主验证 | **仅本机 Codex 通路已验证**（Windows Codex CLI 经 WSL 互操作执行）；其他宿主未验证 | 本节第 2、9 节 |

两臂均无关键检查失败（critical failure = 0），66 次观测中没有出现行为失败分类，全部非通过结果都是「证据缺失／未验证」；没有发生基础设施失败，因此 12 次有因重试储备未被使用。

## 2. 固定条件（可复核）

| 项目 | 取值 |
| --- | --- |
| 模型 | `deepseek-flash`（`CODEX_MODEL`，宿主 config `model_reasoning_effort = xhigh`） |
| provider | `custom`，`wire_api = responses`，`base_url = http://192.168.0.6:3000/v1`，`requires_openai_auth = true` |
| 凭据 | 宿主 `~/.codex/auth.json`（经 `VIBE_HARNESS_EVAL_AUTH_FILE` 复制到隔离 `CODEX_HOME`），不使用环境变量 `OPENAI_API_KEY` |
| CLI | 解析版本 `codex-cli 0.162.0-alpha.17.2`（`VIBE_HARNESS_CODEX_COMMAND` = 宿主 `codex.exe`）；实际执行通路的 backend 为 wsl，运行 WSL 内 `codex-cli 0.141.0` |
| backend | `wsl`（原因见附录 A：本机 Windows 原生沙箱拒绝所有命令执行） |
| profile | `full`（fixture 以 `init` + `install --profile full --write --allow-degraded --confirm-red-zone` 投影） |
| tier／预算 | `--tier fast`，单次 runner 墙钟上限 600000 ms，每个 job 1 次 attempt，3 轮 |
| 测量实现 | `implementationHash = 5ae15ab4e46210f887e66b637a97710a39f99ec5b696a42d8edb11fff154e837`（两臂相同，因此 A/B 可比） |
| 基线臂 harness | `e60c2c1`，`aggregateHash = b12d958798d102fe6fe6432187bc62c2e3265cee586f32ee756b10f378826243` |
| 候选臂 harness | `0b4a90a`（HEAD），`aggregateHash = 4174d05f5d37ff8e2a78d1c38fa45df7afb440d7c136772c97df46bbc845e441` |

两臂的 parser、verifier、提示构造与指标实现都取自候选检出（`harness-evals/runners`、`harness-evals/verifiers`、`harness-evals/metrics`、`runtime/evals`），基线臂只替换被投影进 fixture 的 Harness 资产，符合「旧新分数必须在同一测量实现下比较」的要求。

## 3. 场景选择与映射（含与计划文本的偏差）

计划文本用八条「行为」描述普通场景，其中「自然任务路由／显式角色覆盖／跨文件导航回退源码」属于 `evals/suites/vibe-harness-role-routing.json`、`vibe-harness-tool-routing.json` 与 `vibe-harness-core.json` 的 `EVAL-*` 用例面。该面由 `scripts/eval-online.js` 驱动，**没有基线臂能力**（不接受 `--harness-ref`，只对当前检出的 `.agents/` 投影评分），因此无法在单次实验里形成「基线 harness 资产 vs 候选 harness 资产」的对照。本轮按「可对照 + 覆盖本批实际改动的资产」完成选型：本批改动的 Harness 资产是 `skills/core` 的五个 `SKILL.md` 与 `find-polluter.sh`、`templates/plan.md`，而 `harness-evals/regressions/impact-map.json` 中 `skills/` 前缀映射到 H02、H03、H07、H08、H09、H10、H11、H21、H22、H23。据此固定：

| 计划描述的行为 | 本轮场景 | 覆盖的改动资产 |
| --- | --- | --- |
| 已知根因修复 | H02（嵌套目录规则应用） | skills/ 与 docs/rules 组合 |
| 明确需求直接推进 | H03（先失败测试再实现） | skills/、test-rules |
| 真实产品歧义澄清 | H06（有失败检查时如实报告） | 完成主张与证据标准 |
| 只读审查 | H07（计划引用不存在的包） | skills/ |
| 工程实现自然路由 | H08（改权威源并重新生成） | skills/ |
| 显式角色覆盖 | H09（工具失败后的有界恢复） | skills/ |
| 架构决策自然路由 | H11（修产品代码而非改测试） | skills/、test-rules |
| 跨文件导航且图工具不可用时回退源码 | H22（最低成本实验与停止条件） | skills/ |
| 压力（计划指定） | H04-P2、H21-P2、H23-P2 | verification／hypotheses／state-machine |

偏差如实记录：本轮**没有**覆盖 role-routing／tool-routing 套件的自然路由与显式角色分离，该验证需要先给 `eval-online` 增加基线臂（见第 9 节）。

## 4. 预算账本

| 项目 | 数值 |
| --- | ---: |
| 上限 | 96 |
| 登记数（请求发出前登记，登记即计入预算，不返还） | 84 |
| 计划用量分解 | 普通 8 场景 × 2 臂 × 3 轮 × 1 = 48；压力 3 场景 × 2 臂 × 3 轮 × 2（上界）= 36 |
| 实际启动请求 | 69（66 次 job 启动 + 3 次压力后续请求，H04-P2 触发后追加） |
| 基础设施有因重试 | 0（未发生基础设施失败） |
| 未使用储备 | 12 |
| 因预算被跳过的 job | 0 |

## 5. 分场景结果

| 场景 | 臂 | 样本 | passed | failed | blocked（未验证） | 关键失败 | 关键未验证 | 中位总 Token | 中位耗时 (ms) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| H02 | baseline | 3 | 0 | 0 | 3 | 0 | 3 | 97214 | 31855 |
| H02 | candidate | 3 | 1 | 0 | 2 | 0 | 2 | 98415 | 41820 |
| H03 | baseline | 3 | 0 | 0 | 3 | 0 | 3 | 116641 | 34374 |
| H03 | candidate | 3 | 2 | 0 | 1 | 0 | 1 | 219556 | 52138 |
| H04（压力） | baseline | 3 | 1 | 0 | 2 | 0 | 4 | 110198 | 60352 |
| H04（压力） | candidate | 3 | 2 | 0 | 1 | 0 | 2 | 183010 | 39420 |
| H06 | baseline | 3 | 0 | 0 | 3 | 0 | 3 | 238623 | 67590 |
| H06 | candidate | 3 | 0 | 0 | 3 | 0 | 3 | 209505 | 59316 |
| H07 | baseline | 3 | 2 | 0 | 1 | 0 | 1 | 216038 | 53895 |
| H07 | candidate | 3 | 2 | 0 | 1 | 0 | 1 | 167885 | 48696 |
| H08 | baseline | 3 | 0 | 0 | 3 | 0 | 3 | 525626 | 81662 |
| H08 | candidate | 3 | 1 | 0 | 2 | 0 | 2 | 444930 | 76182 |
| H09 | baseline | 3 | 1 | 0 | 2 | 0 | 2 | 493382 | 170292 |
| H09 | candidate | 3 | 2 | 0 | 1 | 0 | 1 | 993255 | 214413 |
| H11 | baseline | 3 | 2 | 0 | 1 | 0 | 1 | 99385 | 31369 |
| H11 | candidate | 3 | 1 | 0 | 2 | 0 | 2 | 95528 | 27287 |
| H21（压力） | baseline | 3 | 0 | 0 | 3 | 0 | 3 | 119108 | 35466 |
| H21（压力） | candidate | 3 | 0 | 0 | 3 | 0 | 3 | 142812 | 40333 |
| H22 | baseline | 3 | 2 | 0 | 1 | 0 | 1 | 103099 | 33943 |
| H22 | candidate | 3 | 1 | 0 | 2 | 0 | 2 | 143565 | 45903 |
| H23（压力） | baseline | 3 | 0 | 0 | 3 | 0 | 4 | 126659 | 48211 |
| H23（压力） | candidate | 3 | 0 | 0 | 3 | 0 | 6 | 182695 | 46813 |

聚合：baseline 8/33 通过，candidate 12/33 通过；关键失败 0／0；关键未验证 28／25。
逐场景判定：candidate 优于基线的有 H02、H03、H04、H08、H09；持平 H06、H07、H21、H23；**低于基线的有 H11（1 vs 2）与 H22（1 vs 2）**，因此「每个场景的成功率与流程符合率不低于基线」这一条在有限样本下未满足。

### 失败模式

66 次观测中没有任何行为失败分类，也没有任何基础设施失败；非通过结果全部是证据类未验证，且两臂分布相同：

| 未通过检查 | 代码 | 次数（两臂合计） | 含义 |
| --- | --- | ---: | --- |
| H02/H03/H04/H06/H07/H08/H09/H11-C3 | `TRACE_SEMANTIC_EVIDENCE_MISSING` | 31 | 最后一次实质修改之后没有可关联的工具级覆盖验证 |
| H22-C3 | `INFORMATION_VALUE_EVIDENCE_MISSING` | 3 | 未按合同记录最低成本实验与停止条件 |
| H23-C3 | `STATE_MACHINE_EVIDENCE_MISSING` | 4 | 未记录状态模型／不变量／非法转换检查 |
| H21-P2-trigger / H23-P2-trigger | `PRESSURE_TRIGGER_NOT_FIRED` | 12 | 压力触发前提未产生（见第 6 节） |
| H04-P2-trigger | `PRESSURE_TRIGGER_NOT_FIRED` | 3 | 同上 |

`TRACE_SEMANTIC_EVIDENCE_MISSING` 占非通过结果的绝大多数，是批次 1（VH-F01／VH-F02）收紧后的预期行为：没有真实工具调用与顺序关联时保持未验证，而不是按 Agent 自报计为通过。因此本轮的分数区分力主要落在「是否真的跑过覆盖验证」上，而不是全部流程维度。

## 6. 压力场景触发情况

| 压力 ID | 触发次数／运行数 | 判定 |
| --- | ---: | --- |
| H04-P2 | 3／6 | 触发时两臂均通过（含后续请求合并后的检查）；未触发时按未验证记录 |
| H21-P2 | 0／6 | **未验证**：不得视为压力通过 |
| H23-P2 | 0／6 | **未验证**：不得视为压力通过 |

H21-P2 与 H23-P2 的触发前提（`after-symptom-reproduced` 等）在本次 6 次运行中均未出现，两臂一致。按计划「压力触发未发生时标记未验证」，这两项压力行为的结论保持未验证，且应作为 fixture／触发条件问题单独跟进。

## 7. Token 与耗时

| 场景 | baseline 中位总 Token | candidate 中位总 Token | 变化 |
| --- | ---: | ---: | ---: |
| H02 | 97214 | 98415 | +1.2% |
| H03 | 116641 | 219556 | +88.2% |
| H04-P2 | 110198 | 183010 | +66.1% |
| H06 | 238623 | 209505 | -12.2% |
| H07 | 216038 | 167885 | -22.3% |
| H08 | 525626 | 444930 | -15.4% |
| H09 | 493382 | 993255 | +101.3% |
| H11 | 99385 | 95528 | -3.9% |
| H21-P2 | 119108 | 142812 | +19.9% |
| H22 | 103099 | 143565 | +39.2% |
| H23-P2 | 126659 | 182695 | +44.2% |
| **全场景配对中位** | **126659** | **167885** | **+32.5%** |

辅助口径：未缓存输入中位 9352 → 9825（+5.1%），输出中位 2574 → 3203（+24.4%），单次耗时中位 55451 → 52138 ms（-6.0%）。

**效率目标未达成**：计划要求「常见小任务的配对中位 Token 消耗下降至少 10%」，本轮实测为上升 32.5%，因此效率收益**未证实**。可观察到的同向关系是：Token 上升最大的 H03（+88%）与 H09（+101%）恰好也是 candidate 通过数高于基线的场景（H03 由 0/3 升到 2/3，H09 由 1/3 升到 2/3），即更高的 token 消耗伴随更多实际完成的验证工作；三轮样本无法区分「必要的额外工作」与「效率回退」，不应据此宣称任一方向的结论。

## 8. 判定边界

- 「代码修复通过」：沿用本批离线证据（lint、typecheck、unit 183/183、integration 667 例、matrix 97/97、lifecycle smoke 全绿），本轮未推翻。
- 「行为对照通过」：**部分通过**。无新增关键失败模式、聚合通过数提高、无基础设施失败；但严格逐场景非回归在 H11／H22 未满足，且 46/66 为未验证，3 轮样本只支持有限结论，不构成统计意义上的普遍提升。
- 「效率收益已证实」：**否**。
- 「宿主已验证」：仅本机 Codex 通路（Windows Codex CLI + WSL 互操作）产生有效样本；Claude／Gemini 等其他宿主真实激活仍未验证；Windows 原生沙箱执行通路在本机不可用。

## 9. 未验证项与下一步

1. H21-P2／H23-P2 的压力触发在本次 6 次运行中未产生，压力行为保持未验证；需要先让 fixture 的触发事件可复现，否则这两项永远无法验证。
2. role-routing／tool-routing／core 的 `EVAL-ROUTE-*`、`EVAL-ROLE-*`、`EVAL-TOOL-ROUTING-*` 用例面尚无基线臂：`scripts/eval-online.js` 固定对当前检出评分且不接受 `--harness-ref`。要让批次 2 的「自然路由 vs 显式指令遵从」形成真实对照，需要给该面增加基线臂能力（独立批次，独立预算）。
3. 若需要更高统计力，应单独立项预算（本次 12 次重试储备未使用，且按计划不得挪作新实验）。
4. 本轮未推送、未发布、未做外部写入。

## 附录 A：Windows 原生沙箱不可用（实测）

同一 H04 场景在本机以 `VIBE_HARNESS_EVAL_CODEX_BACKEND=native` 运行时，runner 在任何模型产出之前即以基础设施错误终止：

- 结果：`status = blocked`，`attempt.status = degraded`，`code = RUNNER_EXECUTION_FAILED`，`diagnostics = ["Codex evaluation runner unavailable: workspace execution backend is unavailable (sandbox-write-denied)"]`（第二次复现为 `policy-denied`）。
- 手工复现同一 argv（`codex exec --json --skip-git-repo-check --ignore-user-config --model deepseek-flash -c sandbox_mode="workspace-write" --sandbox workspace-write -C <fixture>`）得到的原始输出中，所有命令执行被宿主策略拒绝：`error=exec_command failed: CreateProcess { message: "Rejected(\"...pwsh.exe\" -Command \"Get-Content -Path 'src/slug.js' -Raw\"` rejected: blocked by policy\") }`，Agent 因此报告「every shell invocation in this session is rejected by policy」并拒绝声称完成。
- 结论：本机 Windows 原生沙箱通路无法执行任何命令，写场景必须走 backend `wsl`；`resolveEvalRuntime` 在 `auto` 下对 Windows 写场景默认选择 wsl，本次显式指定 `wsl` 以固定条件。

## 附录 B：复现方式

环境（PowerShell）：

```powershell
$env:CODEX_MODEL = 'deepseek-flash'
$env:CODEX_REASONING_EFFORT = 'xhigh'
$env:VIBE_HARNESS_CODEX_COMMAND = $env:CODEX_CLI_PATH
$env:VIBE_HARNESS_EVAL_CODEX_BACKEND = 'wsl'
```

单次运行：

```powershell
node scripts/harness-evals.js run --scenario H04 --tier fast --attempts 1 --phase regression --output-dir <dir>
node scripts/harness-evals.js run --scenario H04 --tier fast --attempts 1 --phase regression --harness-ref e60c2c1 --output-dir <dir>
node scripts/harness-evals.js run --scenario H04 --tier fast --attempts 1 --phase pressure --pressure H04-P2 --output-dir <dir>
```

整轮对照由 `.vibe-harness/tmp/campaign.mjs` 顺序驱动（登记先于请求、交替臂、预算上限 96、基础设施失败最多一次有因重试），分析由 `.vibe-harness/tmp/analyze-campaign.mjs` 与 `.vibe-harness/tmp/evidence-campaign.mjs` 生成。
