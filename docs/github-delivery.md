# GitHub 三层分支与可靠交付配置

仓库 workflow 提供稳定的 merge-gate、发布前验证、真实 tarball、SHA256、release evidence 和 GitHub build provenance。GitHub 仓库设置仍需管理员应用，不能由仓库文件自动生效。

## Develop ruleset

从干净且最新的 <code>origin/main</code> 创建 <code>develop</code> 后，将 GitHub 默认分支切换到 <code>develop</code>：

- 只允许 Pull Request；<b>不设置 required status check</b>（合入 <code>develop</code> 不运行 CI）。
- 普通 <code>feat/*</code> 与 <code>fix/*</code> 使用 squash merge；合并后删除任务分支。
- 所有风险等级的 PR 都不强制人工审批、不要求远端 CI；持有 Issue 登记的 Writer 可在 Execution Envelope 授权 <code>mergeRequestWrite</code> 后自行 squash 合并，或由作者启用 auto-merge。合入 <code>develop</code> 视为完成，唯一前置是本地验证通过，且该验证建立在合并时的最新 <code>origin/develop</code> 之上：目标 ref 已前进时重跑受影响检查，或交由 merge queue 在最新 base 上重跑。
- 高风险 PR（命中 <code>schemas/</code>、<code>manifests/</code>、<code>adapters/</code>、<code>runtime/</code>、<code>rules/</code>、<code>skills/core/</code>、<code>templates/</code>、<code>scripts/</code>、<code>.github/workflows/</code> 或 <code>package.json</code>）仍必须携带 Risk Evidence 章节与唯一的 Independent Review Receipt；<code>independent-review</code> 当前为 shadow 模式，不阻断合并，但收据缺失、与 diff 不匹配或结论为 negative 时不得自行落地合并。
- 任务分支目标存活不超过约两个工作日；更大工作使用拆分或 feature flag，而非长期共享 feature 分支。

## Main ruleset

为 main 创建 active ruleset，并配置：

- 只允许同仓库的 <code>develop</code>、<code>hotfix/*</code> 和 <code>release-please--branches--main*</code> 通过 Pull Request 合并，要求分支基于最新 main。
- required status check 只选择 merge-gate，启用 strict / require branches to be up to date。完整发布门禁只在发布边界运行：<code>develop → main</code> 提升、<code>hotfix/* → main</code> 以及 <code>release/*</code>；workflow 里的聚合 job 名是 <code>merge-gate</code>，文档中的历史名 <code>main-release-gate</code> 指同一发布边界。
- 要求解决全部对话。普通任务不得直达 main；<code>develop → main</code> 发布提升必须使用 merge commit，保留任务提交。
- 禁止 force push 和分支删除。
- 当前不要求 reviewer 或 CODEOWNERS；有非作者写权限协作者后再启用高风险 owner review。

失败 check 会使 merge-gate 失败；PR 新提交会生成新的 check suite，旧 SHA 的结果不能满足最新提交。

## CI 门禁接线

workflow 在同一个 <code>pull_request</code> 事件上运行三个一致性 job，再统一聚合到 merge-gate：

- <code>branch-policy</code>：校验 PR 来源分支，main 只接受同仓库的 <code>develop</code>、<code>hotfix/*</code>、<code>release-please--branches--main*</code>，develop 接受任务分支前缀。
- <code>independent-review</code>：校验高风险 PR body 中的独立审查收据区块。
- <code>high-risk-approval</code>：校验是否存在当前的非作者批准。
- <code>merge-gate</code> 聚合 <code>product</code>、<code>supply-chain</code>、<code>risk-evidence</code> 与以上三个门禁。它同时是 main ruleset 的唯一 required check，因此 develop PR 上的失败不会阻塞合并。

<code>independent-review</code> 与 <code>high-risk-approval</code> 默认 shadow 模式：只记录结论，不因缺少收据或批准而失败；设置 <code>VIBE_HARNESS_INDEPENDENT_REVIEW_MODE=required</code> 或 <code>VIBE_HARNESS_PR_APPROVAL_MODE=required</code> 后才转为强制。

发布边界另有一道准备度检查：<code>release-verify</code> 在安装依赖前运行 <code>pnpm release:readiness --sha "$GITHUB_SHA" --require-clean</code>，核对 <code>package.json</code>、<code>.release-please-manifest.json</code> 与 <code>CHANGELOG.md</code> 是否一致，并把收据写入 release-artifacts。

CI 去冗余同样由变更计划驱动：当所选检查仅剩 docs 审计时，change-plan 输出 <code>docsOnly</code>，fast-gate 据此跳过不受纯文档变更影响的 <code>eslint</code> 与 <code>check:fast</code>（docs 审计仍运行）；<code>release-verify</code> 复用同一变更计划产物，docs-only 推送只保留发布必需检查（readiness、docs 审计、runtime 审计、pack 契约与真实 tarball 打包），代码推送仍执行完整验证矩阵——同一次 main 推送上 full-gate 已全量运行。

## 迁移顺序与回同步

1. 先固定 release-please 的 <code>target-branch: main</code>，部署分支来源检查和 develop/main 两级门禁。
2. 从干净且最新的 <code>origin/main</code> 创建 <code>develop</code>，应用 ruleset，再切换默认分支；不得使用带未提交改动的工作区创建基线。
3. 将开放的非发布 PR 改为目标 <code>develop</code>；release-please PR 保持目标 <code>main</code>。
4. 发布后创建 <code>main → develop</code> PR 并请求 auto-merge；失败时阻止 Release Issue Done 并人工处理冲突。

hotfix 从 <code>main</code> 创建并先合入 <code>main</code>。其合并立即触发同一回同步流程，确保正式线修复不会在下一次 develop 提升时丢失。

## Release token

创建仓库 Secret RELEASE_PLEASE_TOKEN，使用仅限本仓库的 fine-grained token：

- Repository access：仅此仓库。
- Permissions：Contents read/write、Pull requests read/write；其他权限保持只读或不授予。
- 记录明确过期日与轮换负责人；有效期建议不超过 90 天，并按记录的轮换日更换。

该 token 使 release-please 创建的 Release PR 触发正常 CI。workflow 不执行 npm publish；真实边界是 Release PR、Git tag 与 GitHub Release。

## 发布失败

既有 release tag 和资产不可移动、覆盖或复用。发布后发现问题时 revert 对应变更，再创建新的 patch release。release evidence 固定记录该策略。

## 7+7 天复核

每日 online canary 保留至少 30 天产物，并按生成时间下载末尾 21 次已完成运行。窗口比较按生成时间取末尾 14 个有效日并切出两个不重叠的七天窗口；provider、model、CLI、reasoning、suite 或 case portfolio 不一致，出现 degraded，或缺少 Episode / 守护指标时，只能输出 insufficient-evidence。主指标是 owner observed rate 与 verified handoff rate；critical pass rate、危险写入、unexpected failure 和 degraded run 是守护指标，Token 与耗时只作 advisory。
