# Skill 编写与路由规则

Skill 是宿主按 description 直接选择的领域能力包：description 是唯一预加载的路由信息，SKILL.md 正文按需加载。Skill 只补充当前任务需要的领域知识，不改变授权、安全边界或证据标准。

## 编写契约

- 每个 Skill 必须以 YAML frontmatter 开始，提供唯一的 name 与 description。name 使用小写字母、数字和连字符，以字母开头且不超过 64 字符，并与目录名和 manifests/skills.json 的 id 完全一致。
- description 是宿主的直接路由真值：用第三人称写明“能力 + 触发场景”，把关键用例和触发词前置，因为宿主在技能较多时会截断或压缩描述；保持单行、单一语言、不超过 300 字符，不写执行步骤、测试流程、交付格式或营销措辞。
- 同一安装包内所有 description 使用同一语言；语言混排会让不同请求面对不一致的路由面。
- 与近邻 Skill 容易混淆时，description 必须写明不适用边界（例如“—不包括已定位到根因的修复”），让宿主能排除误触发；SKILL.md 正文不得承诺 description 之外的能力。
- metadata.json 只承载 triggers、outputs 等辅助信息，不重复定义 name 或 description；其 id 与 manifest 和 frontmatter 的 name 一致。
- name 必须唯一；description 完全相同也视为冲突并阻断审计。语义相近但文本不同的描述由审计提示人工复核，不以相似度自动阻断。
- 渐进披露：SKILL.md 是入口而不是全文，正文保持精简（原生 Skill 入口不超过 300 行），长参考资料、示例和脚本拆到 references/ 或 scripts/ 按需读取；超过 100 行的参考文件在顶部给出目录。
- 新增 Skill 前先确认现有 Skill 无法覆盖该能力；触发重叠优先收敛 description 或合并 Skill，不新增 Router 或转发层。

## 路由判定

宿主依据每个 SKILL.md 的 description 直接选择能力，不使用 Router 或流程 Skill 链；Skill 只补充领域知识，不覆盖项目规则、人工确认或安全边界。

- 判定顺序：授权与安全边界（governance-core）> 用户本轮显式指定或显式调用的 Skill > 职责最窄且匹配的领域 Skill > 按需补充的互补 Skill。
- 命中 Skill 触发场景时，先显式读取该 Skill 的 SKILL.md 再按其内容行动，不凭记忆或印象替代读取；宿主路由漏选时仍可按场景显式读取兜底。
- 一个原子动作只路由一个主 Skill；多个 Skill 同时匹配时取职责最具体者，不叠加流程链掩盖歧义。
- 明确请求提交或推送即授权所请求的 Git 动作；显式调用 `$git-deliver` 或明确指定该 Skill 则授权分组、提交并普通推送当前任务改动；普通完成请求不构成 Git 写入授权。
- 高影响产品决定使用 `clarify-requirements`：仅处理当轮可关闭的解阻或显式需求发现，不持久化目标。
- 用户明确要求编写、优化或激活跨任务持续目标时使用 `define-goal`：产出可激活的 Goal Brief，不处理当轮解阻。
- 用户要求拆分已有计划、建立 Task DAG 或生成节点执行提示词时使用 `task-decomposition`：产出拆分判定、Goal/DAG 和宿主无关的单节点提示词；不自动派发或执行任务。简单单 Agent 任务不创建 DAG。
- 仅在用户显式调用 `$git-deliver` 或明确指定 `git-deliver` Skill 时使用：整理当前任务改动、按逻辑分组提交并安全地普通推送当前分支。
- 出现具体故障、报错或测试失败且根因未知时使用 `systematic-debugging`：先证明根因再修复；根因已知或已有既定修复时不触发；Agent 规则、Skill、提示或 Hook 行为变化使用 `eval-driven-development`。
- 只读审查现有项目的逻辑、流程、状态、一致性与接口缺陷时使用 `bug-finding`：面向没有具体失败症状的存量代码，产出证据化审查报告，不修改源码、配置、依赖或数据；要定位具体失败的根因时改用 `systematic-debugging`。
- 识别或清理死代码、无用引用、过期文档、孤儿资源、陈旧记忆与过期索引时使用 `stale-cleanup`：默认只读并区分已确认项与候选线索，删除只在用户显式要求并逐项确认后执行；它不替代 `bug-finding` 的缺陷根因定位。
- 信任边界使用 `security-and-hardening`；公共契约使用 `api-and-interface-design`；前端体验使用 `frontend-design`；跨仓运行时使用 `runtime-cross-repo-rollout`。
- 页面交互、console、network、性能、响应式、可访问性或视觉验收使用 browser-verification integration Skill；它仅由 playwright 或 chrome-devtools plugin 显式安装，不计入 profile 的原生领域 Skill 数量。未安装时使用项目已有的浏览器验证入口。
- 提及 Linear Issue，或请求委派、执行、审查、核验、解释与状态同步时使用 linear-workflow integration Skill；它仅由 linear-mcp 或 linear-mcp-readonly 显式安装。普通提及、查询、Review 或 Verify 只触发规则选择，不授权登记领取；只有明确执行指令，或已有当前 Delegate 且宿主显式启动，才授权 Writer 的最小身份登记。未安装时只能使用用户提供的 Issue 上下文，不声称已读取或同步 Linear。
- 按需加载最匹配的领域 Skill，确需互补知识时补充加载，不建立固定流程链；能力不可用时使用项目规则和确定性验证，不模拟工具或结果。
- description 或触发边界变化视为路由行为变更：用真实任务或 Eval 观察漏触发与误触发，再回改 description 或收敛边界，不靠新增 Router 解决。

计划、测试、Review、任务记录和普通交付由 Agent 按请求直接完成，不自动创建额外流程、角色或门禁；普通完成请求不得隐式选择 `$git-deliver`、提交或推送。红区、权限、凭据、生产、外部写入和不可逆操作遵循 governance-core 的授权与批准规则；已有覆盖授权不重复确认。
