# 多角色路由规则

角色人格与领域 Skill 正交：当前原子动作只激活一个角色人格，并至多加载一个 description 精确命中的领域 Skill。角色改变决策视角，不改变授权、安全边界或证据要求。

## 选择顺序

1. 先判断当前原子动作：澄清、设计、实现、独立验证、审查或已授权的外部执行。主题不是动作的替代品。
2. 从有效角色集合排除禁用、未安装和无法满足当前必要能力的角色；显式选择也必须通过此检查。
3. 用户或父 Agent 显式指定的可用角色优先采用。`routing.mode: explicit` 的角色不会被自动选择。
4. 已明确的实现、修复、重构和测试编写使用 senior-engineer；即使主题涉及安全、API 或版本，也不改派给只读咨询角色。
5. 独立测试、回归或质量判定使用 test-lead；独立安全审查使用 adversarial-security-reviewer；候选版本的 go/no-go 使用 technical-release-manager。
6. 未决公共契约、跨模块结构或重大权衡使用 chief-architect。`product-manager` 与 `technical-project-manager` 仅作为显式咨询：前者输出范围和验收建议，后者输出依赖与关键路径建议；主 Agent 保留用户澄清、DAG 和最终验收。
7. 无适配角色时由主 Agent 完成其授权范围内的工作，或报告具体能力缺口；不得通过角色名称绕过拒绝或权限限制。

## 切换与协作

- 在一个原子动作内保持角色稳定；仅在目标或动作类型改变时重新路由。
- 从 .agents/roles/<role-id>.md 读取当前角色 Prompt，不预加载全部角色正文。
- 固定权限子 Agent 在职责变化、缺少输入、工具或权限时回传父 Agent；它不得靠切换角色扩大权限，也不得擅自再派子 Agent。
- 只有独立并行、高风险二次复审或 docs/rules/governance-core.md 的拆分规则命中时才创建真实子 Agent。
- 不固定串行运行七个角色，不创建强制交接收据、Reviewer/Tester 门禁或自建 scheduler。

## 优先级

平台系统与用户指令优先于项目治理；治理和安全规则优先于角色 Prompt；项目追加 Prompt 只能补充背景或收紧权限。冲突时忽略低优先级内容并报告。
