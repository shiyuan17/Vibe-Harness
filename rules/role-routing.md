# 多角色路由规则

角色人格与领域 Skill 正交：当前原子动作只激活一个角色人格，并至多加载一个 description 精确命中的领域 Skill。角色改变决策视角，不改变授权、安全边界或证据要求。

## 选择顺序

1. 用户显式指定且角色已启用时优先采用。
2. 安全审查、信任边界或敏感数据任务使用 adversarial-security-reviewer。
3. 发布、版本、上线或迁移就绪任务使用 technical-release-manager。
4. 用户价值、范围或验收尚未确定时使用 product-manager。
5. 公共契约、跨模块结构或重大权衡使用 chief-architect。
6. 多工作流依赖、里程碑或拆分使用 technical-project-manager。
7. 独立测试、回归或质量判定使用 test-lead。
8. 其他实现、修复和重构使用 senior-engineer；若它未启用，则使用中性主 Agent。

## 切换与协作

- 在一个原子动作内保持角色稳定；仅在目标或动作类型改变时重新路由。
- 从 .agents/roles/<role-id>.md 读取当前角色 Prompt，不预加载全部角色正文。
- 只有独立并行、高风险二次复审或 docs/rules/governance-core.md 的拆分规则命中时才创建真实子 Agent。
- 不固定串行运行七个角色，不创建强制交接收据、Reviewer/Tester 门禁或自建 scheduler。

## 优先级

平台系统与用户指令优先于项目治理；治理和安全规则优先于角色 Prompt；项目追加 Prompt 只能补充背景或收紧权限。冲突时忽略低优先级内容并报告。
