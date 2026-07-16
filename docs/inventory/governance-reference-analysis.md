# 治理参考审计

本轮只提炼公开仓库的结构模式，不复制系统提示词或项目专有内容。

| 来源 | 审计 commit | 采用模式 |
| --- | --- | --- |
| 外部公开治理模式 | — | 少数强门禁、证据优先、关键流程 pressure test |
| mattpocock/skills | `391a2701dd948f94f56a39f7533f8eea9a859c87` | 小而可组合、单一真值、用户调用与模型调用分离 |
| addyosmani/agent-skills | `4e8bd9fde4a38cd009053e649f4cdc7cd36b568b` | 渐进披露、触发描述、反合理化、行为验证 |
| [Andrej Karpathy coding guidelines](https://x.com/karpathy/status/2015883857489522876) | 用户提供的 MIT 来源文本 | 公开假设与取舍、简单优先、精准改动、可验证目标 |

LoopEngine 的提示结构收敛为 Outcome、Context、Constraints、Route、Verify、Stop。组合类指导使用正向执行配方；权限、安全、不可逆操作和完成声明继续使用硬禁止门禁。

Karpathy Guidelines 不新增 Skill 或独立规则入口：编码前决策与可验证目标归入 `governance-core`，简单实现和精准改动归入 `coding-rules`；测试、计划、审查和代码精简继续复用现有真值。
