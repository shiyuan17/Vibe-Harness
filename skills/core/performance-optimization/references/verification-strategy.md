# 验证策略与执行账本

## 执行账本

任务锚点记录每个实施单元的状态、选中检查、结果和收据。上下文压缩后从账本恢复：已完成且证据仍有效的检查不重跑；失效证据必须明确标为 stale。

## 合并树

- worktree 已隔离时直接复用，不为“流程完整”再创建一层。
- 候选 worktree 先验证合并结果，再把主检出快进到已验证的 commit。
- 最终 deep 验证只针对合并后的树；源 worktree 的旧通过结果不能替代合并树证据。

## 门禁

- 合并到 `develop` 可以免人工 relevance review，但必须保留全部选中检查、最终树、写指纹、provenance 和合并候选验证。
- `main`、release 和其他受保护分支仍要求明确审查上下文。
- 免审记录使用 `not_required` + `REVIEW_NOT_REQUIRED`，不得伪装成 `relevant`。

## 参考边界

借鉴 google-agent-skills 的“测量优先”与按需 references、Superpowers 的账本/隔离/最终树复核、ECC 的 Hook profile 与稳定遥测；不照搬每任务独立 reviewer、每任务全量测试或自动多 Agent。
