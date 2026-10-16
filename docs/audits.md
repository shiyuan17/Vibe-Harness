# 项目审计

vibe-harness audit --project PATH --kind memory|review|improvements|cleanup|all 提供统一的项目级治理审计。默认只读；只有 improvements kind 可以使用 --write，并且唯一持久化目标是 docs/memory/IMPROVEMENTS.json。all 只汇总 memory、review 和 improvements；cleanup 需要显式指定，不包含在 all 内。

## Memory freshness

memory kind 检查空模板、无效日期、失效文件引用，以及引用文件晚于最后验证时间的情况。目标非空的 .agents/memory/CURRENT.md 超过一天未验证即 stale；durable memory 默认九十天提醒，存在 reviewBy 时优先使用该日期。输出为 healthy、warning 或 degraded，不会自动修改 Memory。

## Independent review

review kind 根据 base diff、当前 head、变更指纹、高风险路径和最终 verification receipt 验证独立审查。收据可由已安装的 open-code-review、宿主原生 Reviewer 或人工 Reviewer 生成，再通过 --receipt PROJECT_RELATIVE_PATH 提供；审计器只校验标准 JSON，不调用 Reviewer，也不把结构化身份声明描述为密码学认证。

approved 要求 Reviewer 与实现者身份、context ID 均不同，readOnly 为 true，最终验证绑定当前 head 且 stable 为 true，并且没有未解决的 High 或 Critical finding。收据文件本身不参与变更指纹，避免自引用；任何其他新提交或工作树变更都会使旧收据失效。

v1 回执保持可读，但只对普通变更成立：高风险变更一律要求 v2，v1 回执在高风险下报 `REVIEW_SCHEMA_V2_REQUIRED`，不能支持 approved。v2 是高风险变更的复审契约：Schema 结构上要求至少给出一个 `reviewers` 条目（身份与 contextId 均不得等于实施者）与 `contextIndependence`；`attested` 声明支持 approved，`unavailable` 不支持。缺少复审者或缺少独立性声明时，收据本身就不成立，而不是仅在审计时降级。

收据绑定 `pull_request.base.sha` 与 `pull_request.head.sha`：independent-review job 检出 PR head 提交，复审者不依赖 GitHub 临时 merge commit 也能复算 changeFingerprint。取不到比对 base 的 diff 时审计 fail-closed，不再退化成空变更集。

高风险 PR 的 body 只允许一个 Independent Review Receipt JSON 区块。scripts/independent-review.js 默认以 shadow 模式运行；设置 VIBE_HARNESS_INDEPENDENT_REVIEW_MODE=required 后才会让 degraded 结果返回失败，本仓库 develop/main 的 `pull_request` 门禁使用 required 模式。

scripts/check-pull-request-approval.js 默认同为 shadow 模式，只记录是否存在当前的非作者批准；设置 VIBE_HARNESS_PR_APPROVAL_MODE=required 后才会在缺少批准时失败。

## Improvement candidates

improvements kind 从 review findings 和垃圾回收观察中生成幂等候选。自动过程只能写入 proposed 或 eligible-for-owner-review，不会修改规则、自动接受候选或删除文件。可复现 Bug 和 Critical 安全 finding 一次即可进入 owner review；Hook、linter 和 Rule 需要两个独立 episode，Skill 需要三个。垃圾回收只报告至少九十天未变更且未被 manifest、catalog、测试或文档引用的治理资产。

改进闭环由 owner 显式执行：确认失败与现有资产责任 → 候选评审 → 最小修复 → 定向验证 → 后续可比场景效果回查。确定性缺陷沉淀普通回归测试；Agent 行为问题进入 Eval。先核对现有 Rule/Skill 的选择、调用、验证与停止边界；仅在可比 episode 证明没有匹配 owner 时才考虑新增能力。已有 `evidenceRefs` 可关联审查证据、修复提交、验证收据和 Eval 结果，不引入自动连接器或逐任务回灌门禁。

`implemented` 只表示修复已经落地，不能代表效果已改善；改善主张须在相同测量条件下对照后续结果并说明证据强度。GC 与行为问题分别判断，不用资产删除数、规则数或候选数作为质量指标。`docs/rules` 是当前规则源，旧 `rules` 仍在候选扫描范围以兼容已有项目；未引用且超过九十天只产生待复核线索，不证明应删除。

## Cleanup

cleanup kind 对整个项目做只读陈旧资产扫描：失效引用、catalog 孤儿、install-state 与 eval 镜像漂移、代码索引过期、未被引用的文件与导出，以及超过一百八十天未验证的治理文档。审计器不删除、不重写任何文件；删除是 `stale-cleanup` Skill 中单独显式确认的步骤。确定性发现与启发式候选分级输出，候选保持 info 级别，必须经人工或 Agent 验证后才能进入清理。

cleanup 刻意不纳入 `all`：它枚举整个项目并报告启发式候选，会淹没 all 聚焦产出的收据；需要垃圾回收观察时显式调用 `--kind cleanup`。

    pnpm vibe-harness audit --project ../some-project --kind memory
    pnpm vibe-harness audit --project ../some-project --kind review --receipt audit-reports/review.json
    pnpm vibe-harness audit --project ../some-project --kind improvements --receipt audit-reports/review.json
    pnpm vibe-harness audit --project ../some-project --kind improvements --receipt audit-reports/review.json --write
    pnpm vibe-harness audit --project ../some-project --kind cleanup

## Find Question 深度问题发现

`vb find question --project <path>` 与 `vibe-harness find question --project <path>` 等价。它与上面的 review 回执检查不同：只生成 `status=planned` 审查包，不读取业务源码、不执行模型或测试、不联网、不生成 finding，不用零条目证明“无问题”。包由 `$find-question` Skill 或审查者消费，成果沿用 finding-report 模板和 review-report 六字段契约，不生成独立评审批准回执。

| 参数 | 默认与语义 |
| --- | --- |
| `--project` | 必填现存项目目录；不要求安装配置或 Git，缺 Git 时基线为 null/unknown |
| `--scope` | 默认 `.`；逗号分隔实际文件/目录，不支持 glob；拒绝不存在、链接、越界及显式排除范围 |
| `--depth` | deep；quick 单链路抽查、standard 单业务域、deep 跨模块分批；不隐式启动高成本验证 |
| `--focus` | 默认全部：contract-field、logic-rule、reference-consumer、data-consistency、configuration、authorization、lifecycle、api-observability；逗号分隔，未知值拒绝 |
| `--output` / `--json` | 默认 markdown；json 输出 schema 校验的审查包；`--json` 等价于 `--output json` |
| `--report` | 默认 audit-reports/find-question.md；只允许 audit-reports 下单层 Markdown 文件名，不允许源码/配置路径 |
| `--write` | 唯一写入是新建 Markdown 审查草稿；stdout 格式不改变落盘格式，不覆盖已有文件；拒绝链接、红区及 inspect-only |

`readOnly=true` 声明审查对象源码只读；真实草稿写入另由 `report.written` 表示，只有写入成功才为 true。schemaVersion 1 的 packet 不包含已完成 findings；最终人工/Agent 报告不冒充 packet 或通过回执。退出 0 仅表示准备成功；无效参数、缺失路径、受阻写入或 schema 失败退出 1。

`exclusions` 明示依赖、构建产物、Git/索引缓存、治理运行产物与生成镜像的排除策略（如 node_modules、dist、.agents、docs/templates、docs/schemas）。这是后续审查边界，不是 CLI 已完成枚举；需要审查生成面时回到其源目录，不能把被排除面宣布正确。quick 不偷偷丢弃授权/生命周期等风险，而是减少每类的检查深度；聚焦省略的类别明确列入限制。超过一个模块先分批，只有已取得证据的批次计入覆盖。

### 来源与效果验证

2026-10-16 核对官方 [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/)、[API Security Top 10 2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/)、[CWE-476 / CWE 4.20](https://cwe.mitre.org/data/definitions/476.html)、[NIST SSDF 1.1](https://csrc.nist.gov/pubs/sp/800/218/final)。分发 Skill 保留固定版本的离线检查摘要，不委托外部文档执行，不上传代码，不宣称合规。

新增 Skill 的入口预算增量为 60 行、name/description 增量为 150 字符，合计上限 510 行、2350 字符；单 Skill 150 行和资源目录限制不变。职责限定为深度跨层审查，普通 bug review 不改路由。

`evals/suites/vibe-harness-find-question.json` 提供合成缺陷与反例；`pnpm eval:online --suite vibe-harness-find-question` 可在一次性 fixture 上进行三轮真实行为观察。离线 oracle 正反控只证明评测合同，不能证明检出率改善；未执行同条件新旧对比时必须标注真实效果未验证。不自动提升现有 reference。

本次是新增独立只读准备入口与兼容模板，没有改变安装/授权协议、发布门禁或现有审计 schema，故不另立架构 ADR；新增 packet schema 是与独立评审回执隔离的计划数据。
