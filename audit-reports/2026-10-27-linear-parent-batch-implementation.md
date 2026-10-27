# Linear Parent 单任务树批次交付实施证据

本次在既有未提交改动上叠加实现，保留普通 PR/MR 和无批次计划语义，
不操作外部项目、不安装额外可选 Skill，不在真实项目提交或推送。
合成仓库内的 Git、远端和 Linear 模拟状态写入仅用于验收。

## 实现

- `plan-units.executionBatch` 与既有任务锚点绑定 Parent、成员摘要、
  工作区、分支、冻结基线、精确目标及原生依赖快照。
- 每项代码任务以已验证的提交树完成本地提交；认证收据绑定
  Issue、计划、检查定义和 SHA。正常后续提交保持历史完成事实，
  SHA 非祖先、Hook 改树、计划或检查定义漂移则阻断。
- task 与可选 DAG 的批内前驱使用相同本地完成判据；DAG 自报
  succeeded 不能替代证据。无依赖节点稳定串行，不添加依赖边。
- Parent 最终 HEAD 是唯一 stage 来源；事务保留各 Issue 的提交列表、
  验证 ID、已验证提交、tree 与检查定义摘要。整批完成前不部分发布。
- publish 保留源任务树、分支和锚点，报告远端已确认且清理待处理；
  Linear 子任务和 Parent Done 确认后使用已有 cleanup --batch。
  重试状态同步不重复 push，清理失败仅重试清理。
- 同步源 Skill、调用提示、metadata、规则、任务拆分入口和当前已安装
  runtime/native Skill。保留显式策略与旧别名；未安装的 Linear Skill
  仅更新源资产。新契约决策见 ADR-0027。

## 行为证据

一次性 Git 仓库与 bare 远端执行真实提交和推送；正控断言工作树数量、
逐 Issue 文件归属、提交祖先图、远端 SHA、验证树和模拟状态写入时序。

已覆盖一个任务树承载三个 Issue、最终完成前远端不变、单 source
stage、有效 stage 收据复用、最终提交 SHA 保留、追加修复、批内前驱
放行、批外等待、单 Writer 稳定顺序、正常 HEAD 前进、伪造/失效证据、
只读与已交付任务不造空提交、跨批交付循环、成员扩展确认、中途失败、
远端前进重验、合并冲突、远端保护拒绝、多 push 地址及 Hook 拒绝。

回写模拟覆盖成功写入后响应丢失：先重读，仅补缺失项，Parent 在子项
之后完成。运行时发布重试不重复推送，显式清理重试不重新验证或推送；
实际 provider 的 Linear 写入未执行，不能声称真实 Linear 已同步。

判据负控包括未执行、混合提交、额外任务树、缺少匹配树的检查、
提前 Done 及缺少远端交付；正确样本通过。判据检查实际 Git 产物，
不以固定回答文字判定行为成功。

## 验证状态

- `pnpm check:fast`：passed，含 typecheck 与 201 项单元测试。
- `pnpm skills:audit`、`pnpm docs:audit`、`pnpm tests:catalog check`、
  `node scripts/validate.js`：passed；自安装一致性通过。
- Parent 合成行为、评测正负控、任务锚点及 DAG 聚焦测试：passed。
- 首次受影响组件回归：130 项中 125 项 passed，5 项 failed，均关联
  下述 reference 指纹漂移；首次验收未自动修改 reference 或签入行为
  产物。原始组件输出保留在被忽略的任务目录，后续授权修复见下节。
- 普通交付/验证集成回归：passed，测试进程退出码为 0；覆盖
  `linear-workflow.test.js`、`verification-parity.test.js` 和
  `project-worktree-command.test.js`。批次实现未替代旧独立交付语义。
- `git diff --check`：passed（Git 提示部分既有文件的换行归一化）。
- 首次 `pnpm eval:check`：failed，只有 reference 资产指纹漂移：
  aggregateHash 及 config、hooks、rules、skills 分组。
  修改前冻结记录已记录相同漂移类别；未修改 reference、replay 或
  behavioral 签入产物来消除失败。受此影响的组件检查单独报告。

## 经明确授权修复 reference 漂移

用户后续明确要求“进行漂移修复”。核对 config/schema、Hook、规则及
Skill 的已有改动后，按正规入口生成 offline run，显式更新 reference，
再同步安装镜像、replay 和 stub-behavioral。旧产物均由生成器备份到
`.vibe-harness/backups/`；本次不修改 suite、oracle、分数或通过阈值。

aggregateHash 从 `edec6ff6f29a7711f129c283bfaffe34025c4f6efc617f233d9bb63dcb950955`
更新为 `8421812ad4c0b9829739a3befbec5fd58ae82e6de18626adea47acc2ad59a5f7`。
config、hooks、rules、skills 四组指纹同步，资产数量保持一致；
reference 批准时间为 `2026-10-27T15:15:34.193Z`。

修复后 `pnpm eval:check`、`pnpm eval:replay`、`pnpm eval:behavioral`、
`pnpm eval:sync` 全部 passed，安装投影 drift 为 0；replay 和行为层
的 criticalPassRate、overallScore 均为 1。五个相关组件测试文件
（eval-contract、eval-behavioral、eval-projection、eval-assets、
eval-topology）共 55 项全部 passed，包含首次失败的全部 5 项。
`pnpm check:fast` 再次 passed，含 typecheck 与 201 项单元测试。

这次修复只恢复当前资产与确定性产物的一致性；下节在线评测的
degraded 状态及缺少可比模型基线的限制不变。

## 在线评测与限制

修改前冻结信息位于被忽略的任务目录，包含 Eval ID、资产指纹、
fixture、判据、三轮配置和负控清单。已有未提交改动无法重建同条件
不可变模型基线，因此前后模型改善比较为 blocked。

实际尝试使用 `codex-cli 0.153.4`、WSL、`gpt-6.1-sol` 和每轮
240000 ms 上限。第一组的三轮均未通过，诊断仅显示 CLI diagnostics，
不足以断言其根因。后续诊断尝试明确返回 `EVAL_RUNNER_UNAVAILABLE`：
`mode-restricted, sandbox-write-denied`，记录 degraded 并停止后续轮次。
两组尝试均保留脱敏摘要；不丢弃失败尝试，不把 CLI 可启动当成后端可写。

没有可比模型基线和完整成功在线样本，不能声称模型行为改善；
本次仅证明确定性实现和判据行为。未进行可比耗时实验，也不声明实际
速度提升。已消除的重复建树、逐任务 stage 和重复有效验证由产物断言
证明，实际收益仍需可比测量。

## 恢复与回滚

活动批次保留源树、提交和事务；冲突、Hook、验证或目标问题停止
受影响步骤，不 stash、rebase、强推或破坏性清理。状态回写结果不明
先重读，完成后再显式清理。回滚只撤销本次可选扩展，先保留或结束
活动批次，不让旧运行时消费未知上下文，不回写已有提交 SHA。
