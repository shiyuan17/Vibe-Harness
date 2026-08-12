# 测试规则

测试范围与完成主张匹配；不因任务档位自动运行固定矩阵。

| 改动 | 建议验证 |
| --- | --- |
| 普通对话 / 只读诊断 | 事实核对、静态检查或无需命令 |
| 局部行为 | 受影响范围的聚焦测试和适用 lint/typecheck |
| 共享行为、公共契约 | 调用方回归与集成检查 |
| UI | 组件测试和真实浏览器关键状态 |
| 安全、数据、发布 | 正向/负向路径、边界、回滚与必要的环境验证；适用时含故障注入 |

全量测试不是默认验证；仅在用户明确要求、CI/发布要求、影响面无法缩小或项目自身配置为门禁时运行。显式 Review、浏览器验证和 Eval 是可选产品能力，不由 Vibe-Harness 自动触发。

记录实际命令、退出码和关键结果。失败不得通过降低断言绕过；无法验证时缩小完成主张并说明风险。

验证记录应保留验收矩阵、每项命令的退出码、未验证项和剩余风险。

## 测试类型

按改动类型选择测试，不为凑数运行无关测试；下表是选择清单，非强制全覆盖矩阵。

| 类型 | 何时使用 | 关键属性 |
| --- | --- | --- |
| 静态（lint/typecheck） | 每次变更 | 最便宜的第一道防线，捕获笔误与类型错误，不验证业务逻辑 |
| 单元 | 单函数或模块逻辑 | 隔离、快、确定性 |
| 集成 | 多单元协作、公共契约、安装器与适配器 | 最接近真实使用，投入产出比最高 |
| 端到端 / 浏览器 | UI 关键状态与真实用户路径 | 慢且贵，少量覆盖 |
| 属性 | 可表述为不变性质的逻辑（解析、序列化、状态机） | 随机输入验证不变量，自动缩小到最小反例 |
| 模糊 | 解析器、输入边界、封闭系统 | 投喂畸形输入发现崩溃或异常行为 |
| 契约 | 多服务或 API 边界、防 spec drift | 消费方驱动，保证兼容性 |
| 快照 / golden | 复杂输出回归、遗留代码特征化 | 审批 baseline，非确定性输出禁用 |
| 对抗式 / 负向 | 安全、数据、发布、Agent 安全边界 | 验证禁止行为不发生，详见下节 |
| Eval（offline） | Agent 规则/Skill/模板/adapter/Hook 非确定性回归 | 确定性 replay，reference 比对 |
| Eval（online） | Agent 能力上限/可靠性、LLM-as-judge | 多轮 pass@k/pass^k，judge 对齐 |

Agent 测试终态优先于固定过程：合法替代路径不应判为失败。工具调用的正确性（选择、参数、轨迹）是独立被测对象，不只验证最终输出。

关键修改的测试范围应覆盖关系链分析识别的受影响消费方；共享行为或公共契约变更至少包含一条调用方回归断言，与 governance-core 的关系链分析相互印证。

## 工程约定

下述为运行器无关的行为契约；Vibe-Harness 自身仓库的具体写法见本节末参考实现。

- 运行器：用项目语言惯用测试运行器（如 `node --test`、pytest、`go test`、`cargo test`、JUnit），通过构建工具暴露 `test:unit` / `test:integration` / `eval:*` 等统一入口。
- 分层：单元 / 集成两层加 Eval（Agent 非确定性）；集成测试串行运行，避免共享临时状态污染。
- 断言：用语言惯用断言（`assert/strict`、`t.Errorf`、`assert_eq!`、`assertEquals`），失败即清晰报错；基准路径用语言惯用方式解析，禁止硬编码绝对路径。
- 隔离：临时资源用语言惯用方式创建并在 `try/finally` 或 cleanup 中清理，断言抛错也必须执行清理。
- Mock：优先依赖注入式手写替身；需要自动还原时用运行器内置 mock 机制（而非手动 patch 全局状态）。
- 门禁：不得提交无意跳过测试的残留（`.only` / `.skip` / `@Disabled` / `#[ignore]`）；合法的条件跳过用选项式声明或运行时 skip。
- 卡死兜底：所有 `test:*` 脚本设失败兜底超时（unit/eval 约 30s、integration 约 120s）；该值只作失败兜底，非可靠的进程取消。

### 参考实现：Node.js（Vibe-Harness 自身仓库）

Vibe-Harness 自身仓库使用以下约定，作为上述行为契约的参考示例，非强制目标项目：

- 框架：仅用 Node.js 内置测试运行器（`node --test` + `node:assert/strict`），不引入第三方测试依赖。
- 分层：通过 `package.json` 脚本分为 unit / eval / integration；集成测试 `--test-concurrency=1` 串行。
- 卡死兜底：`--test-timeout`（unit/eval 30s、integration 120s）。
- 风格：顶层 `test('描述句', fn)`，不使用 `describe` 套件；断言统一 `node:assert/strict`；基准路径用 `import.meta.dirname`。
- 隔离：临时目录用 `mkdtemp` 并在 `try/finally` 中 `rm` 清理。
- Mock：优先依赖注入式手写替身；只在验证调用次数/参数时考虑 `t.mock.fn`，且用 `t.mock` 而非顶层 `mock` 确保自动还原。
- 门禁：`.test.js` 不得提交 `test/it/describe` 的 `.only` 或 `.skip` 残留；pre-commit 扫描暂存内容拦截，合法的条件跳过用选项对象 `{ skip: ... }` 或运行时 `context.skip(...)`。

## 对抗式与负向测试

安全、数据、发布改动应包含至少一条负向断言（推荐，不阻断完成主张）；Agent 安全边界改动应覆盖对抗式场景。负向断言验证禁止行为不发生，与正向断言互补。

对抗式 case 属于 Eval 范畴：用 `kind: adversarial` 声明，配合 `forbidden-event` / `forbidden-output-fragment` / `forbidden-artifact` 等 oracle 断言禁止行为未发生。分类骨架参考 OWASP LLM Top 10：

- 指令注入：直接或间接 prompt injection，验证 agent 不执行注入指令。
- 敏感信息泄露：验证凭据、绝对路径、原始对话不进入产物或日志。
- 越权代理（excessive agency）：未声明写入必须产生 `undeclared-workspace-write` 并触发安全断言；验证不执行未授权工具调用。
- 资源耗尽（unbounded consumption）：验证输入长度或轮次受限，不无限消耗。
- 不安全输出：验证下游可执行的输出被拦截或转义。
- 供应链：验证不可信 plugin、MCP server 或 Skill 不影响已安装核心。

故障注入：工具失败、网络失败或 judge 不可用时按 fail-closed 转 degraded；degraded attempt 必须保留，不能只报告成功样本。

## 测试与 Eval 边界

确定性代码走普通产品测试（单元/集成）；Agent 规则/Skill/模板/adapter/Hook 的非确定性行为走 Eval。

- `eval:replay` 必须确定性 stub LLM 与时间，用于回归比对。
- `llm-rubric`（LLM-as-judge）仅 online：judge 调用非确定，offline suite 禁止包含；judge 不可用按 fail-closed 转 degraded。
- reference 更新必须单独审查并显式确认，不得为让变更通过而自动提升；reference 不匹配、缺失或自动更新均不能作为完成证据。

测试与 Eval 的执行步骤、oracle 类型、case kind 枚举等细则见 `docs/rules/eval-driven-development.md`，两份文档使用同一套分类词。
