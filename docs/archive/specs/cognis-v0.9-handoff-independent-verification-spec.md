状态：Superseded

# Cognis v0.9 Handoff 与独立核验规格

## 目标

v0.9 把“已配置多 Agent”提升为可验证的执行合同：完整任务必须提供宿主 hook 观察到的独立 Tester 与 Reviewer 运行证据，并证明两份合格结果对应交付时的同一冻结变更集。项目内收据是机器可校验的运行证据，不是抵御拥有工作区写权限攻击者的密码学强认证。

## 固定流程

`Build → 冻结变更集 → Tester + Reviewer 并行只读核验 → Handoff/Fan-in → 修复后重新核验 → 集成验证 → Delivery`

- 快速任务和非行为改动保持单 Agent。
- 轻量行为改动在 Codex full 可用时派发 Tester。
- 完整或高风险任务必须取得 Tester 与 Reviewer 的独立回传；Reviewer 同时满足 Red Team。
- 核验期间主 Agent 不得修改变更集。修复或任何其他 Git 可见实现改动都会使旧收据失效。
- 原生能力不可用时不得伪造 child；完整任务阻止完成，或记录可追责的人工等价核验。

## v3 任务合同

新完整任务使用 `控制版本: 3`。v1/v2 继续按旧语义读取，未完成旧任务只有主动升级为 v3 后才启用新门禁。TaskDocument IR 保持 schemaVersion 1，并增加 `controlVersion` 与 `handoffs`。

同一任务 Markdown 的 `交接记录` JSON 是唯一 Handoff 真值。记录类型固定为 `阶段交接`、`子任务回传`、`暂停恢复`，状态固定为 `待接收`、`已接收`、`已返回`、`阻塞`。每个编号必须从 `待接收` 开始并按状态机转换；类型、来源/目标角色、收据和指纹在同一编号内不可改变。完成门禁要求最新冻结变更集同时存在 `cognis_tester` 和 `cognis_reviewer` 的合格封存收据。

## 收据与指纹

v2 收据保存在 `.cognis/subagents/receipts/`，只包含 schema 版本、哈希化 session/agent/turn ID、角色、时间、状态、续跑次数、规范化角色结论、输出字段校验、开始/结束变更集指纹和受保护任务/审查证据指纹。不得保存 prompt、transcript 或模型原文。固定输出字段必须在 fenced code、HTML block、引用、列表和缩进代码之外各作为 Markdown 根级字段出现一次；closing fence 后只能有空白，重复或歧义字段无效。缺少字段、重复字段或不可识别状态时，SubagentStop 最多请求一次续跑；结构完整的 Tester `阻塞` 或 Reviewer `要求修改` / `缺少证据而阻塞` 直接形成结论有效但不可批准的终态收据，不得要求 child 改判。Git 可见变更集或 `docs/tasks`、`docs/reviews` 在核验期间变化也会直接使收据无效。同一 `session/agent/turn/role` 运行身份派生稳定 receipt key，并通过 exclusive create 原子保证只能创建一份收据，终态也不能用相同 turn 重启；同一收据不得跨任务复用，修复后只能用新的 turn 创建新收据。v1 收据只作为 legacy 健康记录读取，不能满足新的完成门禁。

冻结变更集指纹覆盖 HEAD、tracked/staged/unstaged/deleted 和未跟踪 Git 可见实现文件；排除 `.cognis/` 运行元数据及 `docs/tasks/`、`docs/reviews/` 治理证据，避免父 Agent 在 fan-in 后写入 Handoff 或审查包导致自失效。独立的受保护证据指纹确保核验角色运行期间不能修改这些排除路径。项目内公开哈希用于检测错配、重复和意外篡改，不是对拥有工作区写权限进程的强认证；需要更强威胁模型时必须由宿主或 CI 提供工作区外签名证明。

v3 完整单任务与父任务都声明 `集成验证`，子任务不声明也不重复承担父级 fan-in 门禁。完成门禁要求每条命令存在退出码 0 的任务证据，且核验时间晚于最新 Tester 与 Reviewer 收据的 `completedAt`；因此 child 自报或核验前的历史测试不能替代父 Agent fan-in 后复验。人工等价核验者与责任角色的身份比较使用 NFKC、trim 与 locale-neutral upper/lower folding，归一后空身份无效；比较在不确定时偏向拒绝独立性声明，防止大小写、全角字符或 `ß/ss` 等表示差异绕过门禁。人工等价核验证据必须是项目内、不经过符号链接的非空常规文件，目录或空占位文件不能满足门禁。

## Adapter 与安装

- Codex full：`subagents=stable`，安装 `.codex/agents/cognis_tester.toml` 与 `cognis_reviewer.toml`；两者属于红区，真实写入需 `--confirm-red-zone`。
- Claude/Gemini：本轮 `subagents=unsupported`，不安装 Codex 角色文件；doctor、baseline 和安装摘要报告降级原因。
- Tester 使用 `workspace-write` 运行可能生成忽略缓存的测试，但不得留下 Git 可见修改；Reviewer 使用 `read-only`、高推理强度和 findings-first 输出。

## 验证

确定性测试覆盖 v3 schema/IR、Handoff 首态与身份不变、重复或错配收据、同一运行身份并发 Start 原子性、路径穿越与符号链接、根级输出解析、合法负面结论不受改判压力、缺字段一次续跑、角色新 turn 重跑、Tester 修改实现或治理证据检测、指纹失效及 fan-in 后集成验证时序。Eval 覆盖轻量/完整派发、暂停恢复、能力降级、小文档单 Agent、共享写入、过期批准和父级集成验证；offline replay 只证明 suite/oracle/reference 合同一致性，真实派发仍由 hook/runtime 测试、项目收据和 online canary 共同证明。
