# Agent Skill 路由规则

Skill 只补强任务 Workflow，不得覆盖目标项目 `AGENTS.md`、治理内核、Review、Coding、Frontend 或其他专项规则的硬约束。先确定风险档位、主 Workflow、人工门禁和验证要求，再按当前环境真实可用的能力选择 Skill。

## 选择原则

- 常规任务最多选择一个流程 Skill、一个领域 Skill和一个验证或审查 Skill；设计任务只选择一个主设计 Skill。
- LoopEngine manifest 中登记并由当前 profile 安装的是内置 canonical Skill。路由表只使用这些 Skill、明确安装的项目内工具或本地治理规则。
- 不引用或假定未安装的 Skill。首选能力不可用时必须记录原因、缺失的覆盖轴和 fallback，再使用已安装的等价 Skill、对应治理规则、项目命令或人工核验。
- 红区、权限、数据、构建发布、不可逆操作和范围扩大仍按目标项目治理要求升级确认，使用 Skill 不降低门禁。
- Review 统一进入 `code-review-and-quality`；该入口可检测项目内 `ocr` 工具并在可用时获取第二视角，CLI、LLM 或凭据不可用时回退到本地或人工审查。实现者不得因此自批高风险变更。

## 生命周期路由

| 阶段 | 优先能力 | 产出或 fallback |
| --- | --- | --- |
| Clarify | `brainstorming` | 澄清目标、成功标准和非目标；高强度追问由同一入口按需执行，无 Skill 时使用任务确认模板。 |
| Spec | 接口任务使用 `api-and-interface-design` | 明确行为、契约、错误和验收；无 Skill 时按专项规则编写规格。 |
| Plan | `writing-plans` | 形成可执行计划并按需拆成可独立验收单元；简单任务可按治理内核直接进入执行。 |
| Execute | 确定性行为使用 `test-driven-development`；Agent 行为使用 `eval-driven-development`；故障使用 `systematic-debugging` | 先观察失败，再小步实现并保护用户改动。 |
| Verify | `verification-before-completion`；UI 可用 `browser-verification` | 提供本轮真实命令、浏览器、接口或日志证据。 |
| Review | 完整/高风险使用 `adversarial-review-packet`；其他任务使用 `code-review-and-quality` | Red Team 审查包或常规审查；OCR 不可用时记录降级和未覆盖轴。 |
| Handoff | task/delivery 模板；full 可使用 `agentmemory` | 保留状态、证据、风险和恢复动作。 |
| Retrospective | AI 协作规则与交付模板 | 将重复失败转化为最小防复发动作。 |

## 信息呈现路由

- 复杂输入、进度、比较、证据或交付输出：若已安装 `ai-collab-rules.md`，读取该规则选择 todo、列表、表格或信息块；未安装时使用治理内核和任务/交付模板的最小结构。

## 领域路由

| 场景 | 领域能力 | 验证 |
| --- | --- | --- |
| 产品 UI、后台、表单、设置与界面 polish | `frontend-design` 的产品、后台与工具模式 | `browser-verification` 或人工浏览器证据 |
| 营销、品牌、作品集与视觉 redesign | `frontend-design` 的营销、品牌与作品集模式 | 浏览器和多视口证据 |
| 泛设计提升且页面方向不明确 | `frontend-design` | `browser-verification` 或人工浏览器证据 |
| API 与跨仓契约 | `api-and-interface-design` | `code-review-and-quality` 和契约证据 |
| Security | `security-and-hardening` | 独立安全/质量审查 |
| Architecture | 对应架构规则 | `code-review-and-quality` |
| Debug | `systematic-debugging` | 回归测试和根因证据 |
| Agent 规则、Skill、模板、适配器、Hook 或提示行为 | `eval-driven-development` | reference matched 的评测运行证据 |
| Memory 续接 | full profile 的 `agentmemory` | 无工具时回退本地任务与 handoff 文档 |

## 执行入口

安装了 Skills 时由 `using-loopengine` 读取本规则并选择实际可用入口；未安装 Skills 的 minimal 或 docs-only 项目直接按本规则、`docs/rules/governance-core.md` 和专项规则 fallback。本文维护推荐政策，不维护用户环境的全量 Skill 清单。
