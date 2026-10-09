# 表达模式（Response Mode）业界机制调查

调查日期：2026-09-18。受众：Vibe-Harness 维护者与审查者。

> 快照口径：本文的业界机制描述为 2026-09-18 调研快照，各产品表面演化较快，引用时以来源文档为准；本文只服务当次设计决策（`docs/rules/response-modes.md`），计数与功能清单被取代时按 inventory 规则移入 archive，不回溯改写。

## 结论先行

业界主流 Agent 产品在 2025-2026 已把「输出风格 / 表达方式」收敛为独立控制层，与任务能力（Skill）、推理深度（reasoning effort）分离；核心共识是**短索引常驻 + 正文按需加载 + 显式调用兜底 + 极简模式保留安全关键信息**。Vibe-Harness 当前没有这一层：输出粒度（简洁交付）、思考深度（风险档位）、成本（Fast Path）全部内嵌在 governance-core，由任务属性驱动，用户无法按场景显式切换表达方式。落点决策：以常驻规则文件 `docs/rules/response-modes.md` 承载模式目录（全宿主可装，含 zcode），AGENTS.md 增加一行路由索引；不做每模式 Skill、不做宿主 command 安装面、不引入配置枚举。

## Vibe-Harness 现状空档

- 输出形态已有**交付物契约**（`docs/rules/review-report.md` 六字段、`templates/delivery.md` 三字段、clarify-requirements 提问结构），但只覆盖特定交付物类型，不覆盖日常问答的解释深度、通俗度、结构选择。
- 最接近的先例是 `clarification.posture`：三值枚举经 `project-config` 校验后渲染为 AGENTS.md 常驻行——证明「枚举→常驻行」链路已有成熟实现，但它是单一维度的配置驱动，不是按消息切换的模式层。
- 仓库没有 prompt 类 slash command 安装面（无 `.agents/commands/`、`.claude/commands/`），也未提供输出风格控制；该层是真实空档而非重复建设。

## 业界机制对比

| 产品 | 机制 | 与本设计的映射 |
| --- | --- | --- |
| Claude Code Output Styles | 5 个内置风格（Default/Proactive/Concise/Explanatory/Learning），自定义风格为 markdown + frontmatter（如 `keep-coding-instructions`）；官方定位「改变回应方式而非知识」；子 Agent 不受主对话风格影响 | 最直接对标。Concise 的保底条款（见下）与「子 Agent 不隐式继承」直接采纳进规则 |
| Cursor | Custom Modes 可将任意 skill 持久化为模式；rules 按触发方式四分（Always / Auto Attached / Agent Requested / Manual） | 四分法印证「自动选择 + 显式调用」双通道是标准做法 |
| Codex CLI | AGENTS.md 常驻指令 + skills 双通道；自定义 prompts 已弃用收敛到 skills；reasoning effort（low/medium/high）独立于表达 | 印证表达层与推理深度是两个旋钮；本设计中验证深度由风险档位决定、模式只影响表达 |
| VS Code Copilot | prompt files（`.prompt.md`）已弃用，收敛为 chat modes | 与 Codex 同向：prompt 文件表面在退场，不建议新建 command 安装面 |
| Gemini CLI | GEMINI.md 分层上下文；模式切换靠显式命令 | 常驻上下文最小化 + 显式切换的又一例证 |
| aider | chat modes（/ask /code /architect），按消息切换 | 「单消息作用域」语义来源：模式默认只作用于当前消息 |
| agentskills.io | 开放标准：name + description 常驻索引，正文按需加载（渐进披露） | 规则文件的「命中索引常驻 + 正文按需读」与该标准同构 |

## 业界共识清单

1. **渐进披露**：常驻层只放短索引（名称 + 一句话触达条件），正文按需加载。
2. **常驻层最小**：风格控制本身不占大量常驻预算（Claude Code 自定义风格可继承 coding instructions 而非复制）。
3. **保底条款**：极简/压缩风格不得裁剪错误报告、安全告警与确认信息（Claude Code Concise 明文规定）。
4. **双通道激活**：按任务自动选择 + 用户显式切换，显式优先。
5. **粘性区分**：单消息作用域（aider）与持续会话作用域（Output Styles）是两种产品选择；高频复用的默认风格适合粘性，任务型模式适合单消息。
6. **正交轴**：表达方式（怎么呈现）、任务能力（会不会做）、推理深度（想多深）是三个独立旋钮，产品均拆开提供。
7. **规则是上下文不是配置**：风格以 markdown 上下文承载，不侵入宿主配置（对应本仓库「安装器不得写全局 Agent 配置」）。
8. **description 质量驱动自动选择**：自动路由的准确性取决于触达条件的措辞质量，而非机制本身。

## 设计映射与取舍

| 设计点 | 决策 | 依据 |
| --- | --- | --- |
| 落点 | 常驻规则文件 `docs/rules/response-modes.md` + AGENTS.md 一行索引 | 规则全宿主可装（zcode 无 skills 能力）；AGENTS.md 预算门禁已内建；业界 prompt 文件表面在退场 |
| 模式集合 | 18 个全集，重叠模式（/clarify /debug /review /test /do /completeness）用绑定指针 + 表达叠加去重 | 避免复制既有能力内容造成双源漂移；Skill 路由与模式路由互不替代（与 review-report 第 3 条先例一致） |
| 作用域 | 单消息作用域，显式重申或声明持续 | 任务型模式高频切换，粘性会造成隐性成本；与 role-routing 的「阶段变化重新选择」语义对齐 |
| 子 Agent | 模式不隐式作用，需在派发提示词显式声明 | Claude Code 先例：子 Agent 不受主对话风格影响 |
| 保底 | 极简/压缩模式不得裁剪错误报告、安全告警、确认请求、验证结果与证据标签 | Claude Code Concise 保底条款；governance-core 证据标准不因模式降级 |
| 优先级 | 既有交付物契约优先（delivery、review-report、clarify-requirements），模式只调整其外叙述粒度 | 交付物契约是治理口径，模式是表达层，后者不覆盖前者 |
| 枚举配置 | 不引入 `response.mode` 配置枚举（v1 规则驱动） | clarification.posture 先例留待确有需要时扩展；规则驱动零配置成本 |
| 评测 | 专项 suite `evals/suites/vibe-harness-response-modes.json`，含反向断言（模式不改变任务行为） | eval-driven-development：行为类规则必须先有失败用例再定稿 |

## 明确不采纳

- **每模式一个 Skill**：zcode 宿主装不到 skills；18 个模式会把 Skill 路由面撑大且与 description 路由语义混淆。
- **宿主 command 文件安装面**（`.claude/commands/` 等）：全新安装面，与 Codex/VS Code 弃用 prompt 文件的趋势相反。
- **修改 governance-core.md 加入模式逻辑**：内核保持最小；rulesLine 命中索引已足够路由（「领域规则只在命中信号时补充细节」）。
- **模式改变验证范围或完成判据**：验证深度由风险档位与 verify 配置决定；模式若能放宽验证，会破坏「没有本轮有效验证不得声称完成」的硬边界。

## 调研来源

- Claude Code Output Styles：https://code.claude.com/docs/en/output-styles （内置风格清单、自定义 frontmatter、Concise 保底条款）
- Cursor rules 与 Custom Modes：https://cursor.com/docs/context/rules 、https://cursor.com/docs/agent/custom-modes
- OpenAI Codex（AGENTS.md、skills、reasoning effort）：https://developers.openai.com/codex/
- VS Code Copilot chat modes 与 prompt files 弃用：https://code.visualstudio.com/docs/copilot/chat
- agentskills.io 开放标准：https://agentskills.io
- Gemini CLI：https://github.com/google-gemini/gemini-cli
- aider chat modes：https://aider.chat/docs/usage/modes.html

以上 URL 为调研当日可访问入口，产品文档路径可能调整；本文结论不依赖单一来源。
