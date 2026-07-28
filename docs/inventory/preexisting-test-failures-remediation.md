# Pre-existing 测试失败处理方案

> 审查范围：`pnpm test`（全量）中与本次 P0-P2 工作流审查无关的失败。
> 基线对照：pristine（stash 本轮改动）11 个独立失败；应用本轮改动后 8 个（本轮修复 3 个，引入 0 回归）。
> 验证命令：`pnpm check`（lint + validate + test:unit）20/20 全绿；`pnpm eval:clarification` 24 cases、`pnpm eval:goal` 12 cases、`tests/skill-closure.test.js` 7/7 全绿。

## 根因分类

全部 8 个失败属于同一类问题：**runtime/模板重构后，测试套件未同步更新**。具体分三组。

### 组 A：`governance` 模块/命令已移除，测试仍引用

重构把 `governance` 从 `moduleCatalog` 和 `validationCommands` 中彻底移除（`project-config.js:163-168` 主动拒绝 `governance` 配置），但三处测试仍引用旧名。

| 测试 | 文件:行 | 期望 | 实际 |
|---|---|---|---|
| `project verification executes eval after governance, lint, and typecheck` | `tests/eval-cli.test.js:105` | 验证顺序 `governance\nlint\ntypecheck\neval\n` | `project-verification.js:27` 实际顺序 `['lint','typecheck','test','eval']`，无 governance |
| `agentmemory upgrade dry-run retires only legacy entries...` | `tests/installer-lifecycle.test.js:215,228,244` | `--modules memory,governance,hooks` | `moduleCatalog` 无 `governance` 键，CLI 报 `Unknown module: governance` |
| `agentmemory upgrade preserves modified legacy entries...` | `tests/installer-lifecycle.test.js:238` | 同上 | 同上 |
| `MVP write upgrade uses the same tracked agentmemory retirement lifecycle` | `tests/installer-lifecycle.test.js:279` | 同上 | 同上 |

**修复方向**：把测试中的 `memory,governance,hooks` 改为 `memory,hooks`；`eval-cli.test.js:109,116,122` 的 `governance` 从顺序断言中移除（实现已不含该步）。

### 组 B：eval suite 收敛后契约未同步

`refactor(eval): 收敛评测执行面`（commit `f69a946`）把 `evals/suites/cognis-core.json` 从 47 case 缩到 18，删掉 `task-delivery-governance` 类别（21 case）和部分 skill-routing/safety-isolation case。但契约测试仍断言旧规模。

| 测试 | 文件:行 | 期望 | 实际 |
|---|---|---|---|
| `core suite contains exactly 47 generic cases in the required category split` | `tests/eval-contract.test.js:27` | 47 case，分布 `{install-lifecycle:6, task-delivery-governance:21, skill-routing:13, safety-isolation:7}` | 18 case，分布 `{install-lifecycle:6, skill-routing:7, safety-isolation:5}`，无 `task-delivery-governance` |

**修复方向**：更新 `eval-contract.test.js:29,34-39` 的期望值为 18 和当前分布。这是纯契约同步，不需要改 eval suite 本身（收敛是有意为之）。

### 组 C：模板字段简化后断言未同步

模板在重构中简化了字段名（`工作流档位`→`档位`、`## 硬边界摘要`→`## 硬边界`、移除 `轻量反证`、移除 `完整流程控制`），但两处测试仍断言旧字段名。

| 测试 | 文件:行 | 期望 | 实际模板 |
|---|---|---|---|
| `CLI write mode writes files when red-zone confirmation is explicit` | `tests/install-dry-run.test.js:172` | task.md 含 `工作流档位` | `templates/task.md:5` 是 `档位：` |
| 同上 | `tests/install-dry-run.test.js:173` | task.md 含 `完整流程控制` | 模板已移除该字段 |
| `MVP dry-run uses --project for path and --target codex...` | `tests/mvp-spec.test.js:105` | AGENTS.md 含 `## 硬边界摘要` | `AGENTS.template.md:13` 是 `## 硬边界` |
| 同上 | `tests/mvp-spec.test.js:106` | AGENTS.md 含 `轻量反证` | 模板已移除该字段 |

**修复方向**：更新测试断言为当前模板字段名（`档位`、`## 硬边界`），移除对已删字段（`完整流程控制`、`轻量反证`）的断言。

## 修复清单

按风险从低到高排序，均为**测试侧**改动，不触碰 runtime/模板/suite 实现。

### 1. 组 A：移除 governance 引用（4 个测试）

- `tests/eval-cli.test.js:109` —— 从 `['governance','lint','typecheck','eval']` 改为 `['lint','typecheck','eval']`
- `tests/eval-cli.test.js:116` —— 同步 `commandStatus` 键
- `tests/eval-cli.test.js:122` —— 顺序断言改为 `'lint\ntypecheck\neval\n'`
- `tests/installer-lifecycle.test.js:215,228,244,289` —— `--modules memory,governance,hooks` 改为 `--modules memory,hooks`

### 2. 组 B：同步 eval 契约（1 个测试）

- `tests/eval-contract.test.js:29` —— `47` 改为 `18`
- `tests/eval-contract.test.js:34-39` —— 分布改为 `{install-lifecycle:6, skill-routing:7, safety-isolation:5}`
- `tests/eval-contract.test.js:40` —— `new Set(...).size` 断言同步为 18

### 3. 组 C：同步模板字段断言（2 个测试）

- `tests/install-dry-run.test.js:172` —— `工作流档位` 改为 `档位`
- `tests/install-dry-run.test.js:173` —— 移除 `完整流程控制` 断言
- `tests/mvp-spec.test.js:105` —— `## 硬边界摘要` 改为 `## 硬边界`
- `tests/mvp-spec.test.js:106` —— 移除 `轻量反证` 断言

## 验证

修复已执行并验证通过：

```bash
pnpm test          # 289 tests, 287 pass, 0 fail, 2 skipped  ✅
pnpm check         # 20/20 pass                              ✅
node --test tests/eval-ci.test.js   # 6/6 pass                ✅
```

### 执行结果

全部 4 组修复已落地：

- **组 A**（governance 引用）：`eval-cli.test.js` 验证顺序改为 `lint,typecheck,test,eval`；`installer-lifecycle.test.js` 4 处 `--modules` 改为 `memory,hooks`。
- **组 B**（eval 契约）：`eval-contract.test.js` 期望值改为 18 case，分布 `{install-lifecycle:6, skill-routing:7, safety-isolation:5}`。
- **组 C**（模板字段）：`install-dry-run.test.js` 断言 `档位：`，移除 `完整流程控制`；`mvp-spec.test.js` 断言 `## 硬边界`，移除 `轻量反证`。
- **组 D**（eval-ci.test.js 深层不同步）：移除废弃 `runEvaluationCheck` import 和测试（函数已从 `context.mjs` 删除，逻辑内联到 `executeProjectVerification`）；offline routing 测试同步到当前 tool-routing scenario（Chrome DevTools MCP / RTK / ast-grep）；EDD docs 测试同步到当前 `docs/evals.md` 实际内容（reference / offline / online / suite / eval check）。

## 风险

- 全部改动在测试侧，不改变 runtime 行为、模板内容或 eval suite 设计。
- `governance` 移除是已落地的重构决策（`project-config.js` 主动拒绝该字段），测试同步只是承认既成事实。
- eval suite 收敛到 18 case 是有意为之（commit message `收敛评测执行面`），契约同步不回滚该决策。
- 模板字段简化同样是已落地决策，测试同步不影响已安装项目。
- `runEvaluationCheck` 函数删除后，其逻辑由 `executeProjectVerification`（`project-verification.js`）覆盖，后者有 `eval-cli.test.js` 的测试覆盖。
- 注意：全量 `pnpm test` 运行时不要在仓库根目录留下 `.log` 或 `.tmp-test-out.txt` 文件，否则 doctor 审计会检测到产品标识泄漏导致级联失败。
