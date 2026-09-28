# Harness 自主性与完成规则优化

状态：规则、模板、安装镜像与回归场景已修改；离线 reference 已获用户明确批准并通过正式入口更新，离线验证通过。Astra 在线行为验证仍受阻。

## 改动

- 执行内核统一自主执行、澄清、授权持续性、局部暂停与完成语义；普通实现、验证修复和明确归属的临时产物清理沿用已有授权。
- 仅对现有意图和事实无法解决的高影响决定澄清；等待回答时继续独立工作。
- 批准针对缺少覆盖授权或新增影响的动作；先准备具体差异，不用准备工作提前执行待批准操作。
- 删除公共契约必拆分、计数决定 DAG、单会话一个决定、固定简报和完整输出要求；实际协作仍检查依赖、归属及集成验收。
- Memory 正文限制明确限定对象；按需加载互补 Skill；本地交付不要求未授权的提交、推送或合并。
- 同步各 adapter、专项停止条件、角色、Linear 规则与 Skill、中英文模板、安装镜像和资产检查。
- 新增 12 个 canonical-rule 场景，每组三轮；拆分与失败恢复用例移除预定答案，改用隐藏行为判据。
- Hook 执行代码、Execution Envelope schema、红区和凭据保护未修改；Hook README 说明现有实际门禁行为。

## 本轮验证

| 检查 | 结果 |
| --- | --- |
| pnpm check | passed；218 项测试通过，含 lint、资产与文档校验 |
| pnpm skills:audit / pnpm roles:audit | passed |
| pnpm typecheck | passed |
| 安装投影、project-profile、skill-closure、Linear 聚焦集成 | passed；80 项测试通过 |
| pnpm eval:check | passed；场景和 oracle 合同有效 |
| pnpm test:eval | 204 passed，0 failed，1 skipped；批准更新基准后两项指纹失配失败已消除 |
| pnpm eval:replay | passed；38 个场景的确定性重放与已批准基准一致 |
| 候选离线结果与 reference 合同验证 | passed；38 个场景的结果、断言和分数保持不变 |
| git diff --check | passed |

确定性新增测试验证：未完成 fixture 失败、实际正确改动通过；模拟越权部署、误删用户文件、重复已完成版本修改均失败；服务验证缺失仍不能证明任务完成。提示展开测试确认实际治理源码进入 fixture，评分答案不进入任务提示。这些测试不证明模型已表现出所需行为。

## Astra 在线验证

同一 suite、模型 gpt-6-astra、reasoning high、native backend、每场景三轮，分别保留旧、新规则指纹。前后预检均为 EVAL_JUDGE_CREDENTIALS_MISSING，各 36 个试次未启动。没有在线成功率、Token、耗时改善或稳定性结论。

- [旧规则预检](online-before.json)
- [新规则预检](online-after.json)

历史授权、澄清回答和恢复上下文是供应的场景输入，不是真实跨 turn、compaction 或子 Agent 生命周期证据。原生生命周期仍需要受支持的 H15/H20 等场景验证。

## 已批准的离线 reference 更新

已核对当前指纹与批准前候选一致。用户明确回复“批准确认”后，使用正式 reference 入口及 --write --confirm-reference-update --force 更新基准，保留自动备份，并同步签入结果与安装镜像。以下候选材料保留供追溯，实际批准时间见核对收据。

- [精确差异](reference-update.patch)
- [候选 reference](reference-candidate.json)
- [候选确定性结果](result-candidate.json)
- [核对收据](reference-review.json)

更新涉及 evals/results/vibe-harness-core.offline.json、evals/references/vibe-harness-core.offline.json 及 .agents/evals/references 镜像。38 个场景的输入、评分、断言、结果和阈值不变；只更新 config、hooks、rules、skills 分组指纹及批准时间。config 对应能力清单注册，hooks 对应 README 及其镜像，rules/skills 对应本轮规则和技能修改；没有修改 Hook 执行逻辑。

依据 CONTRIBUTING.md 的 Eval reference 更新清单和 docs/rules/eval-driven-development.md，reference 更新必须独立审查并显式确认。已按批准范围写入，同步确定性结果和镜像，并重跑 eval:check、eval:replay 和 test:eval，均通过。批准不会补足缺失的 Astra 在线证据。

未执行提交、推送、合并或发布。批准前候选保留为审阅材料；最终已批准基准位于 evals/references/，并与 .agents/evals/references/ 镜像一致。
