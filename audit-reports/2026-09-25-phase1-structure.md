# Phase 1：结构与规则审查

## 范围与结论

共同输入：`2026-09-25-facts-baseline.md` v2 与 `2026-09-25-file-inventory.md`。正式审查仅覆盖角色/规则投影、规则与 Skill 路由、普通工程规则；不评价调度、恢复、验证收据或 Hook 执行逻辑。未读取其他 Phase 1 产物。产品文件未修改。

本域不能单独回答整个 Harness 是否稳定支撑长期开发。可以确认，角色投影具有确定性实现，基础职责与退出边界明确；但权限诊断把宿主原生 sandbox 与精确角色权限混为一谈，普通工程规则也存在可避免的冲突。不能由规则存在推断 Agent 一定遵守。

## 正式发现

### STR-F01：角色权限的“native”诊断掩盖了验证角色的粗粒度写权限

- **问题**：Codex 的 verification/release-readiness 预设不包含 `workspace-write`，投影却与实现角色一样使用 `workspace-write` sandbox；安装诊断仍统一标注 `native`，无法表达“sandbox 原生生效，但角色级禁止修改实现仅靠其他机制”的差别。
- **证据**：
  - `manifests/roles.json:16`：`{ "id": "verification", "capabilities": ["read", "search", "reason", "validation-command", "browser-verification"] }`。
  - `scripts/lib/role-projection.js:92`：`export const EXECUTE_PRESETS = new Set(['implementation', 'verification', 'release-readiness']);`。
  - `scripts/lib/role-projection.js:434`：`sandbox_mode: isExecutablePreset(role.permissionPreset) ? 'workspace-write' : 'read-only',`。
  - `.codex/agents/test-lead.toml:3`：`sandbox_mode = "workspace-write"`；`:49`：`默认不修改被测实现`。
  - `manifests/adapters.json:13`：`"permissionEnforcement": "native"`。
  - `scripts/lib/role-projection.js:603`：`permissionMapping: adapter.roleProjection.permissionEnforcement === 'native' ? 'native' : 'degraded-permission-mapping',`。
  - `scripts/lib/roles-audit.js:260`：`const expectedSandbox = executable ? 'workspace-write' : 'read-only';`。当前审计正是把这一宽映射作为通过条件。
- **实现状态**：部分实现。sandbox 投影和诊断代码已实现；“禁止测试者修改被测源码”不是该投影自身保证的能力。其他运行时防护是否补足交给可靠性域，本条不声称已发现可利用越权。
- **根因**：一个 adapter 级 `native` 标签承载了两种不同命题：宿主认得 sandbox 字段，以及全部角色能力得到精确限制。
- **影响**：在多 Agent 独立验证场景，父 Agent 不能依据当前权限诊断确认被测源码不可被测试者改写；机器审计通过仍不证明这一隔离性质。尚无本轮实际误写事件证据。
- **改进方案**：优先做减法，取消精确权限未保证时的无条件 `native` 表述；按预设报告“原生 sandbox + 粗粒度写权限”，沿用现有降级机制。只有用户确需独立验证时才检查宿主/Hook 是否确实限制被测路径，不能补足则使用只读预设并由父 Agent 执行验证。不要新增角色或通用调度器。
- **优先级**：P1（诊断/隔离可信性问题，不是已经证实的权限绕过）。
- **验证方式**：角色投影测试应断言 verification 的限制精度不会被标为完整原生强制；若主张源码隔离，再提供宿主层拒绝写入被测源码的行为证据。

### STR-F02：API 规则同时要求配置语言和固定中文断言

- **问题**：非中文目标项目无法同时满足同一规则文件的语言契约和测试条款。
- **证据**：
  - `docs/rules/api-rules.md:17`：``面向用户展示的提示文案（错误、校验、业务提示）使用项目配置 `language` 声明的语言，默认 `zh-CN` 即中文``。
  - `docs/rules/api-rules.md:29`：``面向用户展示的 message 与项目 `language` 一致（默认中文）``。
  - `docs/rules/api-rules.md:30`：`用户可见提示断言中文文案，机器可读字段断言稳定英文取值。`
- **实现状态**：仅规范定义；已确认的是文本冲突，不是已发生的错误实现。
- **根因**：把默认值“中文”写成了无条件验收要求，而不是引用项目契约。
- **影响**：配置非中文语言时，按清单执行的 Agent 可能改坏文案或编写错误断言；实际触发频率无法确认。
- **改进方案**：删除“中文”这一固定要求，改为断言项目配置/既有 i18n 契约对应的文案；不新增本地化规则或检测框架。
- **优先级**：P2。
- **验证方式**：以 `language=en` 的只读规则审阅样例确认测试要求与项目语言一致；保留默认中文样例即可。

## 关键机制五问

| 机制及证据 | ①解决什么 | ②删除会怎样 | ③更简单替代 | ④能否稳定理解执行 | ⑤能否自动验证 |
|---|---|---|---|---|---|
| 单一角色清单与生成投影：`scripts/lib/role-projection.js:568` 开始依次生成 `.agents/roles/` 与宿主角色；`:582` 调用 `projectRole(role, adapter, capabilities)` | 避免跨宿主手工维护人格与权限字段 | 删除生成器会把一致性责任交还给人工 | 保留；不要增加第二份手写宿主人格真值 | 文件生成确定；宿主是否加载及行为遵从无法确认 | 投影结构可机械审计；本轮 `node scripts/roles-audit.js` 为 ok、7 roles、0 errors、0 warnings；不等于权限行为全通过 |
| 单动作角色路由：`docs/rules/role-routing.md:15`“先判断当前原子动作”；`:22`“无适配角色时由主 Agent（中性主 Agent）在其授权范围内完成工作” | 避免用主题代替动作而派错只读/执行角色 | 全删会失去明确职责与安全上限提示 | 保留短索引和 fallback，不把每次内部思考都变成显式角色切换仪式 | 规则清楚，但每次路由的行为可靠性无法由文本确认 | 结构/字段可审计；真实任务路由要行为证据，不能用描述存在替代 |
| 子 Agent 接单、退出和回传合同：`roles/base.md:18`“确认目标与非目标、代码基线或输入证据、允许写入范围、工具限制、验收和停止条件”；`:24`“达到当前请求的终止条件后停止” | 约束越界与无效交接 | 全删会失去共享的最小职责边界 | 保留这一份 base；各角色不重复字段定义 | 人类可理解，宿主执行强制无法确认 | 可校验产物字段；是否真实满足授权/停止条件必须观察行为 |
| description 直接路由：`docs/rules/agent-skill-routing.md:18`“不使用 Router 或流程 Skill 链”；`:22`“一个原子动作只路由一个主 Skill” | 按需加载领域知识，避免额外路由层 | 删除边界可能使流程 Skill 叠加 | 保留宿主直接选择和明确排除边界，不新增统一 Router | 边界可理解；实际漏选/误选率无法确认 | description 结构可审计，语义路由需要样例，不能只做文本快照 |
| 普通编码规则与检查清单：`docs/rules/coding-rules.md:8`“优先复用本仓库既有模式”；`:23`“优先复用已有工具、目录结构、命名和错误处理方式”；`:17`与`:32`重复关系链要求 | 提醒范围、错误处理和兼容风险 | 全删会损失判断准则；删重复段不会损失独有约束 | 合并“规则/检查清单”的重复句，保留独有停止条件 | 当前可理解，但重复没有新增执行能力 | 可检查链接/重复文本；判断质量不能靠文字条数验证 |
| API/目录等专项规则：`docs/rules/api-rules.md:9`“私有内部实现…按 coding-rules 处理”；`docs/rules/project-directory.md:8`“单文件可逆改动…不触发目录与 ADR 判定” | 限定公共边界和结构变化的额外证据 | 全删易遗漏消费者、归属与兼容影响 | 保留适用边界，删除固定中文等无关普适假设 | 适用边界明确；语言冲突见 STR-F02 | 可针对配置/场景检查规范一致性；不能证明每次 Agent 均遵守 |

## 可删除/可简化项

- 合并 `docs/rules/coding-rules.md:8`/`:23`、`:14`/`:22`、`:17`/`:32` 的重复表述；影响仅是减少重复读取，保留各自独有约束，不增加替代规则。这是低优先级编辑建议，不当作显著成本问题。
- 保留 `roles/base.md` 的共同职责合同和生成器；源、通用投影、宿主投影用途不同，不能仅因内容相似就删除其中一个。
- 没有证据支持新增角色、Router 或强制多 Agent 门禁。

## 无法确认与跨域边界

- 未验证宿主实际加载角色、精确工具限制或 Hook 是否覆盖角色级写入；STR-F01 仅判定投影诊断不够精确，不直接判定整体安全边界失守。
- 没有真实 session/token 对照实验，不能断言 7 个角色或 27 份规则本身造成成本失控。
- 单有规则、目录与测试文件不足以证明长期稳定遵从；本轮静态审查不提供总体成功率。
- v2 所有权生效前读到的 workflow/test/index 规则不进入本域正式发现，交相应领域判断。

## 本轮验证与变更

- `node scripts/roles-audit.js`：退出码 0；`Role audit: ok`，`Built-in roles: 7`，`Errors: 0`，`Warnings: 0`。这说明结构审计通过，不能反证 STR-F01。
- `git diff --check`：退出码 0；报告为未跟踪文件，该命令不构成报告内容校验，引用另经源码核对。
- 仅新增本报告；未修改产品、规则、代码、配置、依赖或测试。
