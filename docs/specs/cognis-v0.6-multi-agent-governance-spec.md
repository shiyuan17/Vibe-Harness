# Cognis v0.6 父子任务多 Agent 治理规格

状态：Implemented

版本说明：`v0.6` 是治理规格修订号，不等同于 `package.json` 的产品版本。本规格继承 v0.5 的五步循环、风险档位、单一 Markdown 真值、证据和 Red Team 等不变量，并替换其多 Agent 章节；历史关系由 `docs/catalog.json` 记录。

## 设计依据

采用 orchestrator-workers 的共同约束：优先单 Agent、只拆分独立工作、隔离 child 上下文、由主 Agent fan-in 并复验。参考 [Anthropic Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents)、[OpenAI Agent orchestration](https://openai.github.io/openai-agents-python/multi_agent/)、[Claude Code subagents](https://code.claude.com/docs/en/sub-agents)、[Microsoft orchestration patterns](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns) 和 [Codex hooks](https://developers.openai.com/codex/hooks/)。

## 单一真值与版本

- 每个节点只维护 `docs/tasks/<任务编号>.md`；不恢复 `task.json`、workflow manifest、消息总线或自建 scheduler。
- 无 `控制版本` 的完整流程控制块是 v1，长期保持可读并继续使用 v0.5 单文档校验。新模板默认写入 `"控制版本": 2`。
- v2 节点沿用责任角色、写入范围、禁止动作、依赖任务、冲突任务、并行安全、时间盒、停止条件、回滚、人工确认、核验和 merge-back 字段。
- 目标、控制块和 AC 构成 brief；状态、验收证据、剩余风险和下一步构成执行报告。父 Agent 是父子任务文档的唯一维护者，child 只返回固定结构化结果。

## v2 任务变体

- 单任务：没有值得隔离的独立工作时使用。
- 父任务：必须声明唯一 `子任务` 列表、二维 `执行批次` 和必须在合并后目标工作区执行的 `集成验证` 命令。
- 子任务：必须声明 `父任务编号`、最小 `输入`、`不得修改范围`，并固定返回 `状态、变更摘要、变更路径、验证证据、未验证项、剩余风险、下一步动作`。
- 任务图是扁平 DAG。只有父 Agent 可以派发；child 需要继续拆分时返回阻塞和拆分请求，由父 Agent 创建同级 child。

## 写入范围

v2 `写入范围` 只接受项目相对精确路径或末尾为 `/**` 的目录范围。绝对路径、`.`/`..` 路径段和其他 glob 形式无可靠判重语义，必须拒绝。两个范围相同或一个是另一个的路径祖先时视为重叠。

## 任务图校验

`validateTasks` 先解析全部任务 Markdown 并执行单文档校验，再调用独立任务图校验器。任务图必须阻断：

- v2 ID 与文件名不一致或 ID 重复；
- 父子引用缺失、双向不一致或出现孙任务；
- child 引用不存在或不属于同一父任务的依赖/冲突；
- child 依赖成环、冲突未对称声明；
- child 在执行批次中遗漏、重复或引用未登记节点；
- 依赖未放在更早批次；
- 冲突、写入范围重叠或独占写入的 child 位于同一批次。

## 完成门禁

- child 完成前所有依赖必须完成，merge-back 不得待处理；越界、依赖未满足、需要再拆分或无法验证时必须返回阻塞。
- parent 完成前所有 child 必须终结、无待处理 merge-back、每条集成验证命令都有本轮成功证据，最终 diff 获得非实现者的独立 Red Team 批准。
- 父 Agent 必须核对实际 diff 和 child 自报证据，在合并后的目标工作区复验；child 自报测试或自审不能替代该证据。

## Doctor 与安装分层

- `cognis doctor` 默认只报告 v1/v2、父/子数量；`--verbose` 才列 legacy 路径。legacy 父子合同产生非阻断 `TASK_CONTROL_V1_LEGACY` 警告，`validate` 不因 v1 新增失败。
- minimal：硬边界与 v2 模板；core：schema、任务 runtime 和 inline fallback；docs-only：可读合同，不安装 runtime；full：再安装多 Agent Skill 与 Codex hooks。
- `SubagentStart` 只注入 child 边界、禁止再委派和不得自批；`SubagentStop` 提醒父 Agent 核对 diff/证据并持久化状态。Codex hook 不具备阻止 subagent 启动的合同。
- Claude Code 与 Gemini CLI 依赖通用任务合同；不得宣称存在未实现的平台 hook 等价能力。

## 兼容与非目标

升级不自动改写用户 v1 任务。迁移通过新模板和 doctor 提示逐步完成。不新增平台抽象 API，不写全局 Agent 配置，不从 reusable 核心泄露项目专有标识。
