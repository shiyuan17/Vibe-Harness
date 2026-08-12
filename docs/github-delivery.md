# GitHub 可靠交付配置

仓库 workflow 提供稳定的 merge-gate、发布前验证、真实 tarball、SHA256、release evidence 和 GitHub build provenance。GitHub 仓库设置仍需管理员应用，不能由仓库文件自动生效。

## Main ruleset

为 main 创建 active ruleset，并配置：

- 只允许通过 Pull Request 合并，要求分支基于最新 main。
- required status check 只选择 merge-gate，启用 strict / require branches to be up to date。
- 要求解决全部对话并使用线性历史。
- 禁止 force push 和分支删除。
- 当前不要求 reviewer 或 CODEOWNERS；有非作者写权限协作者后再启用高风险 owner review。

失败 check 会使 merge-gate 失败；PR 新提交会生成新的 check suite，旧 SHA 的结果不能满足最新提交。

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
