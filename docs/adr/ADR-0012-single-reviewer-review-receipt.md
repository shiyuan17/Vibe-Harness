---
id: ADR-0012
title: Single-reviewer high-risk review receipt
status: accepted
date: 2026-10-10
owner: vibe-harness-maintainers
decision-makers: [vibe-harness-maintainers]
consulted: []
informed: []
supersedes: []
superseded-by: null
---

# Single-reviewer high-risk review receipt

## Context and Problem Statement

`develop` 的 required gate 由 `independent-review` job 承担：高风险变更必须携带 schema v2 评审回执，且回执在结构上要求两个身份与 context 都不同的 reviewer，并要求宿主验证的 `contextIndependence=verified`。该项要求在实践中不可执行：Codex 宿主的 `freshContext.evidence` 仍是 `configured-unverified`，第二个不继承上下文的复审环境与宿主级 verified 证据都拿不到；同时保留「审查必须独立于实施者」这一真正的保护目标并不需要凑满两个人。结果是高风险改动无法在单维护者、单宿主环境下取得 approved 回执，门禁从保护退化为枯死。

## Decision Drivers

- 保留独立性内核：复审者身份与 context 必须区别于实施者，复审只读，回执绑定 diff 指纹与最终验证收据。
- 去掉无法在宿主层取证的人数与宿主 verified 要求，使门禁在真实环境中可执行。
- 保持 v1/v2 兼容与结构可校验：v2 仍必须同时给出 `reviewers` 与 `contextIndependence`，v1 继续只对普通变更成立。

## Considered Options

- 维持「两名 reviewer + 宿主 `contextIndependence=verified`」不变。
- 放宽为「至少一名 reviewer，`contextIndependence` 允许 `attested`、拒绝 `unavailable`」。
- 取消高风险回执门禁。

## Decision Outcome

选定方案：**至少一名 reviewer，`contextIndependence` 允许 `attested`、拒绝 `unavailable`**。理由是审查独立性已由身份/上下文互异、只读声明、回执与 `headSha`/`baseSha`/`changeFingerprint`/验证收据的绑定共同保证，人数从 2 降为 1 不改变这些不变量；`attested` 允许但必须写明证据来源，`unavailable` 仍视为不成立。完全取消门禁会同时丢掉绑定与审查义务，成本高于收益。

## Consequences

- 正面：单维护者、单宿主环境下高风险改动的独立审查门禁重新可执行，且证据仍逐字绑定变更内容与验证状态。
- 取舍：失去第二个独立视角与宿主强证据这一层冗余，独立性声明降级为自陈；需要以证据来源说明、CI 侧的降级指标与后续宿主能力建设来补偿。

## Confirmation

- `tests/integration/project-audit.test.js`：单 reviewer v2 回执（`verified` 与 `attested`）判定 `healthy`；`unavailable` 报 `REVIEW_CONTEXT_INDEPENDENCE_UNAVAILABLE`；空 `reviewers` 报 `REVIEW_RECEIPT_SCHEMA`；v1 高风险仍报 `REVIEW_SCHEMA_V2_REQUIRED`。
- `tests/integration/eval-ci.test.js`：required 模式接受单 reviewer + `attested` 的回执，并继续阻断缺字段的 v2 回执。
- `tests/component/pack-contract.test.js` 保证 `docs/schemas/review-receipt.schema.json` 与源 schema 逐字一致。

## Review Trigger

宿主能够提供可验证的 fresh-context 证据，或连续出现 `REVIEW_FINGERPRINT_STALE`、`REVIEW_SAME_IDENTITY` 一类降级时，重新评估是否恢复 `verified` 要求或第二复审者。

## More Information

- 关联 ADR-0006（发布边界门禁与 Writer 落地 develop 合并）、ADR-0009（develop required fast gate）。
- 实现面：`schemas/review-receipt.schema.json`、`scripts/lib/review-audit.js`、`scripts/independent-review.js`。
- 编号说明：本 ADR 使用 ADR-0012，为在途分支预留 ADR-0010/ADR-0011，避免合入 `develop` 时出现重复 ADR id。
