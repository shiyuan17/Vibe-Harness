# 项目审计

vibe-harness audit --project PATH --kind memory|review|improvements|cleanup|all 提供统一的项目级治理审计。默认只读；只有 improvements kind 可以使用 --write，并且唯一持久化目标是 docs/memory/IMPROVEMENTS.json。all 只汇总 memory、review 和 improvements；cleanup 需要显式指定，不包含在 all 内。

## Memory freshness

memory kind 检查空模板、无效日期、失效文件引用，以及引用文件晚于最后验证时间的情况。目标非空的 .agents/memory/CURRENT.md 超过一天未验证即 stale；durable memory 默认九十天提醒，存在 reviewBy 时优先使用该日期。输出为 healthy、warning 或 degraded，不会自动修改 Memory。

## Independent review

review kind 根据 base diff、当前 head、变更指纹、高风险路径和最终 verification receipt 验证独立审查。收据可由已安装的 open-code-review、宿主原生 Reviewer 或人工 Reviewer 生成，再通过 --receipt PROJECT_RELATIVE_PATH 提供；审计器只校验标准 JSON，不调用 Reviewer，也不把结构化身份声明描述为密码学认证。

approved 要求 Reviewer 与实现者身份、context ID 均不同，readOnly 为 true，最终验证绑定当前 head 且 stable 为 true，并且没有未解决的 High 或 Critical finding。收据文件本身不参与变更指纹，避免自引用；任何其他新提交或工作树变更都会使旧收据失效。

高风险 PR 的 body 只允许一个 Independent Review Receipt JSON 区块。scripts/independent-review.js 默认以 shadow 模式运行；设置 VIBE_HARNESS_INDEPENDENT_REVIEW_MODE=required 后才会让 degraded 结果返回失败。

scripts/check-pull-request-approval.js 默认同为 shadow 模式，只记录是否存在当前的非作者批准；设置 VIBE_HARNESS_PR_APPROVAL_MODE=required 后才会在缺少批准时失败。

## Improvement candidates

improvements kind 从 review findings 和垃圾回收观察中生成幂等候选。自动过程只能写入 proposed 或 eligible-for-owner-review，不会修改规则、自动接受候选或删除文件。可复现 Bug 和 Critical 安全 finding 一次即可进入 owner review；Hook、linter 和 Rule 需要两个独立 episode，Skill 需要三个。垃圾回收只报告至少九十天未变更且未被 manifest、catalog、测试或文档引用的治理资产。

## Cleanup

cleanup kind 对整个项目做只读陈旧资产扫描：失效引用、catalog 孤儿、install-state 与 eval 镜像漂移、代码索引过期、未被引用的文件与导出，以及超过一百八十天未验证的治理文档。审计器不删除、不重写任何文件；删除是 `stale-cleanup` Skill 中单独显式确认的步骤。确定性发现与启发式候选分级输出，候选保持 info 级别，必须经人工或 Agent 验证后才能进入清理。

cleanup 刻意不纳入 `all`：它枚举整个项目并报告启发式候选，会淹没 all 聚焦产出的收据；需要垃圾回收观察时显式调用 `--kind cleanup`。

    pnpm vibe-harness audit --project ../some-project --kind memory
    pnpm vibe-harness audit --project ../some-project --kind review --receipt audit-reports/review.json
    pnpm vibe-harness audit --project ../some-project --kind improvements --receipt audit-reports/review.json
    pnpm vibe-harness audit --project ../some-project --kind improvements --receipt audit-reports/review.json --write
    pnpm vibe-harness audit --project ../some-project --kind cleanup
