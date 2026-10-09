# Phase 0 逐文件事实基线 v2

基线 HEAD: 98a9d52585e8cfe4692e8f81810b075cd8643dc6。

## 覆盖与判定边界

- 从 Git 实际跟踪文件及未忽略未跟踪文件枚举，并逐项 stat；不是从预设目录猜清单。共 866 个磁盘文件，7951696 字节。
- 包含源资产、安装投影、测试、工作流、配置、规范、示例与历史参考；第三方依赖、Git内部、索引、缓存和生成会话不是项目源资产，不计入执行能力。
- 逐文件状态不是整个功能状态：规则/JSON/提示文本存在只能证明定义；JS 即使含函数也不凭函数名认定能力，未确认语义列“无法确认”。代码存在不等于本轮测试通过。
- Memory body 不读，只有存在/大小；历史报告与旧评测产物不得作为当前行为通过证据。
- 先前摘要中“已实现（有测试）”统一解释为源级实现存在，未运行验证；测试文件存在不证明被测实现完整。
- 状态计数：{"仅规范定义":502,"无法确认":355,"部分实现":6,"已实现":3}。

| 实际文件路径 | 五级状态 | 内容依据/能力边界 | 原文锚点与元数据 |
|---|---|---|---|
| .agents/README.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # .agents/ 目录说明; 1855B; 8d89a58aa729 |
| .agents/evals/references/vibe-harness-core.offline.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 2,; 3616B; 3bf4e3debae3 |
| .agents/evals/suites/vibe-harness-core.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 79210B; a6b2dbf38142 |
| .agents/evals/suites/vibe-harness-online-autonomy.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 40510B; 50918138ade2 |
| .agents/evals/suites/vibe-harness-online-canary.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 99456B; 88fcee39dc0f |
| .agents/evals/suites/vibe-harness-online-execution.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 42812B; df330181a903 |
| .agents/evals/suites/vibe-harness-response-modes.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 11240B; 29dbb17f19b7 |
| .agents/evals/suites/vibe-harness-role-routing.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 14816B; b481a3277193 |
| .agents/memory/CURRENT.md | 无法确认 | Memory body 按边界不读；仅记录存在和字节数 | 2276B; metadata-only |
| .agents/memory/README.md | 无法确认 | Memory body 按边界不读；仅记录存在和字节数 | 2245B; metadata-only |
| .agents/memory/decisions.md | 无法确认 | Memory body 按边界不读；仅记录存在和字节数 | 394B; metadata-only |
| .agents/memory/observations.md | 无法确认 | Memory body 按边界不读；仅记录存在和字节数 | 255B; metadata-only |
| .agents/memory/sessions/README.md | 无法确认 | Memory body 按边界不读；仅记录存在和字节数 | 309B; metadata-only |
| .agents/roles/adversarial-security-reviewer.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Vibe-Harness 角色契约; 2833B; 90e1eb08ddeb |
| .agents/roles/chief-architect.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Vibe-Harness 角色契约; 2798B; 14bad17ba4aa |
| .agents/roles/index.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 可用角色; 2732B; 952d94c16bf4 |
| .agents/roles/product-manager.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Vibe-Harness 角色契约; 2734B; 40dea5ee9145 |
| .agents/roles/senior-engineer.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Vibe-Harness 角色契约; 2750B; e49448ff867f |
| .agents/roles/technical-project-manager.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Vibe-Harness 角色契约; 2743B; 447997837038 |
| .agents/roles/technical-release-manager.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Vibe-Harness 角色契约; 2797B; 428893b39fea |
| .agents/roles/test-lead.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Vibe-Harness 角色契约; 2783B; 114d3fa72930 |
| .agents/runtime/commands/run.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L3: import { execFile, spawn } from 'node:child_process';; 199032B; 309cc0207362 |
| .agents/runtime/evals/codex-runner.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import { spawn } from 'node:child_process';; 73468B; 53477fe0b4d5 |
| .agents/runtime/evals/lib/hidden-tests.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { spawn } from 'node:child_process';; 3724B; d304b9582fe4 |
| .agents/runtime/evals/lib/knowledge-coverage.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L3: function ownerKey(owner) {; 9026B; 48b03c889435 |
| .agents/runtime/evals/lib/protected-config.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { createHash } from 'node:crypto';; 1503B; bf3e26cde2de |
| .agents/runtime/evals/run.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import { createHash } from 'node:crypto';; 6651B; 21d935c27f62 |
| .agents/runtime/hooks/README.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Project safety hooks; 6761B; 4fe4841374bb |
| .agents/runtime/hooks/codex-hook.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import { stat } from 'node:fs/promises';; 9691B; 6970d5c9a4fb |
| .agents/runtime/hooks/git-hook.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import { execFile, spawn } from 'node:child_process';; 6920B; d0f1346ff512 |
| .agents/runtime/hooks/lib/context.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { execFile } from 'node:child_process';; 6597B; a3dc6bf53961 |
| .agents/runtime/hooks/lib/execution-envelope.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { execFileSync } from 'node:child_process';; 44875B; 3e68d32de52a |
| .agents/runtime/hooks/lib/frozen-test-writes.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { readFile, readdir, realpath } from 'node:fs/promises';; 13616B; c7258b624200 |
| .agents/runtime/hooks/lib/policy.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import path from 'node:path';; 31490B; 617a00009af0 |
| .agents/runtime/hooks/lib/read-only-commands.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L162: export function shellSegments(command) {; 20780B; 10cf285479bc |
| .agents/runtime/hooks/lib/role-permissions.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { isWorkspaceToolName } from './read-only-commands.mjs';; 2776B; c6c0dcf85e68 |
| .agents/runtime/hooks/lib/rtk.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { spawn } from 'node:child_process';; 6842B; c09c9e6e4020 |
| .agents/runtime/hooks/red-zone.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 1096B; 33dc03092f1f |
| .agents/runtime/lib/micro-runner.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { spawn } from 'node:child_process';; 8233B; fff333d6ac0c |
| .agents/runtime/lib/worktree-audit.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L18: import path from 'node:path';; 21653B; 0465a208c0a7 |
| .agents/runtime/lib/worktree-ports.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L14: import { existsSync, readFileSync, readdirSync } from 'node:fs';; 16258B; e57a00df80af |
| .agents/skills/agentmemory/SKILL.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 2617B; b419c874a3a3 |
| .agents/skills/agentmemory/references/audit.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Agentmemory 审计; 1670B; 6cc4b443c531 |
| .agents/skills/agentmemory/references/forget.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Agentmemory 遗忘; 588B; 34724233cc4e |
| .agents/skills/agentmemory/references/handoff.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Agentmemory 恢复; 1708B; 908b41393689 |
| .agents/skills/agentmemory/references/recall.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Agentmemory 检索; 448B; d2eff75b75e9 |
| .agents/skills/agentmemory/references/recap.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Agentmemory 汇总; 519B; e094d00e89b5 |
| .agents/skills/agentmemory/references/remember.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Agentmemory 保存; 535B; b04cfc3842e4 |
| .agents/skills/agentmemory/references/session-history.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Agentmemory Session 历史; 403B; 9a67f2487e4a |
| .agents/skills/api-and-interface-design/SKILL.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 1019B; ef795e31737d |
| .agents/skills/api-and-interface-design/agents/openai.yaml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: interface:; 307B; e95bcc10d41b |
| .agents/skills/api-and-interface-design/metadata.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {"id":"api-and-interface-design","kind":"core","entry":"SKILL.md","triggers":["api","接口","契约","模块边界","schema"],"outputs":["接口; 168B; bb24b1cca2b5 |
| .agents/skills/bug-finding/SKILL.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 1389B; 85d57d138bf7 |
| .agents/skills/bug-finding/agents/openai.yaml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: interface:; 302B; 0bfc7d4efa62 |
| .agents/skills/bug-finding/metadata.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {"id":"bug-finding","kind":"core","entry":"SKILL.md","triggers":["bug 审查","缺陷","业务逻辑","流程审查","状态机","数据一致性","接口请求","需求不符","功能缺; 265B; 700beadcbfb5 |
| .agents/skills/clarify-requirements/SKILL.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 2692B; a4031024ab4c |
| .agents/skills/clarify-requirements/agents/openai.yaml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: interface:; 306B; dac08072d17f |
| .agents/skills/clarify-requirements/metadata.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {"id":"clarify-requirements","kind":"core","entry":"SKILL.md","triggers":["产品决定","需求澄清","需求探索","需求采访","需求规格"],"outputs":["关键决; 215B; 61b044820b56 |
| .agents/skills/clarify-requirements/references/examples.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 澄清示例; 1397B; 4483d90d18b3 |
| .agents/skills/define-goal/SKILL.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 2074B; 08c7a117b9f1 |
| .agents/skills/define-goal/agents/openai.yaml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: interface:; 283B; d27409c716ee |
| .agents/skills/define-goal/metadata.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {"id":"define-goal","kind":"core","entry":"SKILL.md","triggers":["/goal","目标模式","目标书","自主目标","探索目标"],"outputs":["Goal Brief",; 191B; 5e1b4ef7289a |
| .agents/skills/define-goal/references/goal-contract.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Goal Brief 合同; 5113B; c1d0b024085f |
| .agents/skills/eval-driven-development/SKILL.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 3495B; edab78b0637d |
| .agents/skills/eval-driven-development/agents/openai.yaml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: interface:; 292B; 71ef4cc60baf |
| .agents/skills/eval-driven-development/metadata.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "id": "eval-driven-development",; 216B; ccf95c2e9fb5 |
| .agents/skills/frontend-design/SKILL.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 2885B; b253565ed68c |
| .agents/skills/frontend-design/agents/openai.yaml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: interface:; 283B; bcaff149752d |
| .agents/skills/frontend-design/metadata.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {"id":"frontend-design","kind":"full","entry":"SKILL.md","triggers":["frontend design","视觉方向","设计感","landing","brand","portfo; 255B; b7e4b480ee7f |
| .agents/skills/frontend-design/references/component-states.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 组件状态变体与契约; 3055B; 73d053ddeb15 |
| .agents/skills/frontend-design/references/content-a11y.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 内容与可访问性; 3776B; 1b82bd4939f9 |
| .agents/skills/frontend-design/references/design-modes.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 设计模式与共同门槛; 2219B; 371166a382c4 |
| .agents/skills/frontend-design/references/design-tokens.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 设计令牌骨架; 5769B; 401006de0ecb |
| .agents/skills/frontend-design/references/forms.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 表单工艺; 3921B; f33ee47d7018 |
| .agents/skills/frontend-design/references/interactions.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 交互工艺; 5266B; b83ff6d0e300 |
| .agents/skills/frontend-design/references/motion.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 动效工艺; 2969B; 811773014ebd |
| .agents/skills/frontend-design/references/performance.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 性能工艺; 2814B; 4b10f186b5ed |
| .agents/skills/frontend-design/references/visual-craft.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 视觉工艺; 3055B; 39fad47b0453 |
| .agents/skills/git-deliver/SKILL.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 2145B; 22e900f60c52 |
| .agents/skills/git-deliver/agents/openai.yaml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: interface:; 323B; 2e95744ec13b |
| .agents/skills/git-deliver/metadata.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {"id":"git-deliver","kind":"core","entry":"SKILL.md","triggers":["$git-deliver","使用 git-deliver Skill","use git-deliver Skill; 187B; 6b283a816978 |
| .agents/skills/runtime-cross-repo-rollout/SKILL.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 854B; f247ca1577e5 |
| .agents/skills/runtime-cross-repo-rollout/agents/openai.yaml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: interface:; 316B; a156833b9578 |
| .agents/skills/runtime-cross-repo-rollout/metadata.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {"id":"runtime-cross-repo-rollout","kind":"full","entry":"SKILL.md","triggers":["cross repo","end-to-end","真实接口"],"outputs":[; 160B; 88b5b1d23bb7 |
| .agents/skills/security-and-hardening/SKILL.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 837B; f34c4cdc167d |
| .agents/skills/security-and-hardening/agents/openai.yaml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: interface:; 293B; bd13a4180a8b |
| .agents/skills/security-and-hardening/metadata.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {"id":"security-and-hardening","kind":"core","entry":"SKILL.md","triggers":["security","auth","untrusted input","敏感数据"],"outp; 166B; 4ed37df04175 |
| .agents/skills/stale-cleanup/SKILL.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 2268B; 05e35328664e |
| .agents/skills/stale-cleanup/agents/openai.yaml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: interface:; 351B; 9962d1ee3a6b |
| .agents/skills/stale-cleanup/metadata.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {"id":"stale-cleanup","kind":"core","entry":"SKILL.md","triggers":["死代码","无用引用","过期文档","过期资源","孤儿资产","陈旧记忆","过期索引","清理死代码"],"; 264B; 984493fd8b01 |
| .agents/skills/stale-cleanup/references/asset-classes.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 六类过期资产判定细则; 4242B; 44098284863d |
| .agents/skills/systematic-debugging/SKILL.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 1083B; ba026c6a9d1c |
| .agents/skills/systematic-debugging/agents/openai.yaml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: interface:; 302B; 951e312d316a |
| .agents/skills/systematic-debugging/find-polluter.sh | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: #!/usr/bin/env bash; 2259B; 9862ee21b609 |
| .agents/skills/systematic-debugging/metadata.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {"id":"systematic-debugging","kind":"core","entry":"SKILL.md","triggers":["测试失败","非预期行为","构建失败","报错","根因未知","复现失败"],"outputs"; 191B; b2d21d358c3e |
| .agents/skills/task-decomposition/SKILL.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 888B; 468729cb9437 |
| .agents/skills/task-decomposition/agents/openai.yaml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: interface:; 316B; 9f62b389dd0e |
| .agents/skills/task-decomposition/metadata.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {"id":"task-decomposition","kind":"core","entry":"SKILL.md","triggers":["任务拆分","任务拆解","拆分计划","Task DAG","子任务规划","节点执行提示词"],"o; 250B; 19ed7231b484 |
| .agents/skills/task-decomposition/references/task-decomposition-guide.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Task Decomposition Guide; 13227B; 72966d8cc090 |
| .cbmignore | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: # Vibe-Harness project-wide cbmignore.; 862B; 645dc06c755b |
| .codex-plugin/plugin.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "id": "vibe-harness-codex",; 146B; d9aa9474f3cd |
| .codex/agents/adversarial-security-reviewer.toml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: name = "adversarial-security-reviewer"; 3238B; 7e54cdb59e2d |
| .codex/agents/chief-architect.toml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: name = "chief-architect"; 3173B; f34d4552c18a |
| .codex/agents/product-manager.toml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: name = "product-manager"; 3135B; 9c47b1b12da4 |
| .codex/agents/senior-engineer.toml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: name = "senior-engineer"; 3137B; 255a7064c59b |
| .codex/agents/technical-project-manager.toml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: name = "technical-project-manager"; 3154B; 49ecb7630f3a |
| .codex/agents/technical-release-manager.toml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: name = "technical-release-manager"; 3174B; 330c8ac70c09 |
| .codex/agents/test-lead.toml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: name = "test-lead"; 3148B; a93ebe297a19 |
| .codex/better-harness/2026-07-31-codex-normal-post-fix/findings.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L10:         "id": "task-understanding",; 13165B; 2aa4e008ff55 |
| .codex/better-harness/2026-07-31-codex-normal-post-fix/report.html | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L232:   function report(message, state) {; 47523B; 023d7dfbc85f |
| .codex/better-harness/2026-07-31-codex-normal-post-fix/report.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Better Harness Task-Loop Report; 3001B; 9bb29de2b90e |
| .codex/better-harness/2026-07-31-codex-normal/findings.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L10:         "id": "task-understanding",; 14823B; a887ff41ccf7 |
| .codex/better-harness/2026-07-31-codex-normal/report.html | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L259:   function report(message, state) {; 55995B; 1199b26a3642 |
| .codex/better-harness/2026-07-31-codex-normal/report.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Better Harness Task-Loop Report; 3752B; 112573507166 |
| .codex/hooks.json | 部分实现 | 真实配置 PreToolUse/PermissionRequest 命令；宿主启用无法确认 | L17: "PreToolUse": [; 4989B; 2ee290e31aa4 |
| .codex/workflow-asset-scan-blindspot-result.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L18:     "status": "verified",; 2476B; 2b758ec219c3 |
| .editorconfig | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: root = true; 123B; 9d2322b65a41 |
| .gitattributes | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: * text=auto eol=lf; 131B; aca115519546 |
| .githooks/pre-commit | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L3: exec node "$root/.agents/runtime/hooks/git-hook.mjs" pre-commit; 127B; 089735859830 |
| .githooks/pre-push | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L3: exec node "$root/.agents/runtime/hooks/git-hook.mjs" pre-push; 125B; 648f407b298f |
| .github/CODEOWNERS | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: .github/workflows/** @shiyuan17; 207B; 0b94444141c2 |
| .github/ISSUE_TEMPLATE/bug_report.yml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: name: Bug 报告; 1444B; 1f0538f1fc40 |
| .github/ISSUE_TEMPLATE/feature_request.yml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: name: 功能请求; 1245B; a3b158755ffa |
| .github/SECURITY.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 安全策略; 1496B; 476e5ecbfd97 |
| .github/dependabot.yml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: version: 2; 525B; 1ef77bcc6cbd |
| .github/pull_request_template.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ## 影响范围; 711B; b5537d2063ee |
| .github/workflows/ci.yml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: name: CI; 12570B; 9903535071a0 |
| .github/workflows/evals.yml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: name: Online evaluation canaries; 5636B; 3762419aa7c5 |
| .github/workflows/release-please.yml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: name: Release; 6290B; b3dcf025af2c |
| .gitignore | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: node_modules/; 345B; 45df0e0407f3 |
| .husky/commit-msg | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: pnpm exec commitlint --edit $1; 31B; 3002699c6705 |
| .husky/pre-commit | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: node .agents/runtime/hooks/git-hook.mjs pre-commit; 99B; 5ad17de5761f |
| .husky/pre-push | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: exec node .agents/runtime/hooks/git-hook.mjs pre-push; 54B; 20175cfb1159 |
| .lintstagedrc.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {; 44B; 2ed1ec2de58a |
| .release-please-manifest.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "version": "0.3.0"; 25B; 03eada1f990a |
| .zcodeignore | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: node_modules/; 928B; 30b4a6ef342c |
| AGENTS.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # AGENTS.md - Vibe-Harness 贡献指南; 8993B; 9f53d5f8b411 |
| CHANGELOG.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 更新日志; 132772B; b41fa0823283 |
| CONTRIBUTING.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Vibe-Harness 贡献指南; 21237B; 1623c51c5b13 |
| LICENSE | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: MIT License; 1103B; 4c8d78dfaf71 |
| README.en.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Vibe-Harness; 24871B; ed87f611a6b4 |
| README.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Vibe-Harness; 23056B; 0e444d9b0b05 |
| adapters/antigravity/RULES.template.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Vibe-Harness 工作区规则; 1035B; 4d0408298070 |
| adapters/antigravity/hooks.template.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L5:       "hooks": [; 312B; 14efe825307d |
| adapters/antigravity/mcp.template.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {}; 3B; ca3d163bab05 |
| adapters/claude/CLAUDE.template.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # CLAUDE.md; 860B; 0d75ffe18cfc |
| adapters/claude/hooks.template.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L5:       "hooks": [; 602B; 742d4aa8a332 |
| adapters/codex/AGENTS.template.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # AGENTS.md; 765B; 3922ce6c8aad |
| adapters/codex/codex-plugin.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "name": "vibe-harness-codex-adapter",; 236B; 6840a69716d4 |
| adapters/codex/hooks.template.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "hooks": {; 659B; 34f34bee152a |
| adapters/codex/mcp.template.toml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: # This file is rendered as a Vibe-Harness-managed MCP block by the installer.; 79B; 0b7ca3543c30 |
| adapters/cursor/hooks.template.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L5:       "hooks": [; 307B; 8b5b74271f61 |
| adapters/cursor/mcp.template.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {}; 4B; e3566b3a0643 |
| adapters/gemini/GEMINI.template.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # GEMINI.md; 803B; 80c3d4e27abd |
| adapters/git/pre-commit | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L3: exec node "$root/.agents/runtime/hooks/git-hook.mjs" pre-commit; 127B; 089735859830 |
| adapters/git/pre-push | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L3: exec node "$root/.agents/runtime/hooks/git-hook.mjs" pre-push; 125B; 648f407b298f |
| adapters/install-map.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {; 44031B; 3a41bab5e039 |
| adapters/opencode/AGENTS.template.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # AGENTS.md; 765B; 3922ce6c8aad |
| adapters/opencode/mcp.template.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {}; 3B; ca3d163bab05 |
| adapters/qoder/hooks.template.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L5:       "hooks": [; 600B; d48ebcde546d |
| adapters/qoder/mcp.template.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {}; 4B; e3566b3a0643 |
| adapters/zcode/hooks.template.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L5:       "hooks": [; 600B; 3b2ba126d17c |
| adapters/zcode/mcp.template.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {}; 4B; e3566b3a0643 |
| audit-reports/2026-07-15-loopengine-governance-audit.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # LoopEngine 全项目 AI 规范中立审查报告; 34142B; 3e3f0cfae14f |
| audit-reports/2026-07-16-loopengine-comprehensive-review.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # LoopEngine 全面审查与 AI Coding 治理最佳实践优化报告; 39125B; 8b21d4a7d322 |
| audit-reports/2026-07-18-cognis-v0.5.0-red-team.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # COGNIS-RENAME-050 Red Team 审查包; 3000B; e1c453b273d1 |
| audit-reports/2026-07-30-online-eval-report.html | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: <!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale; 35632B; 0b51c01d3c4e |
| audit-reports/2026-08-11-vibe-harness-agent-workflow-review.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Vibe-Harness Agent 工作流第一性原理审查; 27188B; 3e0ff4fc52ac |
| audit-reports/2026-09-01-governance-workflow-review.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Vibe-Harness 规范与工作流全面审查（P0/P1 落地 + P2 路线图）; 20262B; 0c50a511ff6e |
| audit-reports/2026-09-02-focused-verification-workflow-review.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Vibe-Harness 工作流审查与聚焦验证可执行化（2026-09-02 批次）; 10358B; 758c7824b795 |
| audit-reports/2026-09-05-agent-capability-design-review.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Harness Agent / Subagent 能力设计全面审查; 56088B; f5f53a903ae8 |
| audit-reports/2026-09-08-astra-autonomy/README.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Harness 自主性与完成规则优化; 4483B; 4315a60f6f26 |
| audit-reports/2026-09-08-astra-autonomy/judge-probe.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L5:   "status": "ready",; 212B; 6738036b2f63 |
| audit-reports/2026-09-08-astra-autonomy/online-after-codex.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L24:       "status": "ready",; 10933B; 8245c34e953c |
| audit-reports/2026-09-08-astra-autonomy/online-after.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L18:   "status": "degraded",; 795B; 1ae6067f8cff |
| audit-reports/2026-09-08-astra-autonomy/online-before-codex.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L24:       "status": "ready",; 10881B; 6147cd258198 |
| audit-reports/2026-09-08-astra-autonomy/online-before.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L18:   "status": "degraded",; 796B; 2dd092cf18ca |
| audit-reports/2026-09-08-astra-autonomy/reference-candidate.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 2,; 3513B; c5b403d7c998 |
| audit-reports/2026-09-08-astra-autonomy/reference-review.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "status": "approved-and-applied",; 642B; 88bc5c783246 |
| audit-reports/2026-09-08-astra-autonomy/reference-update.patch | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: --- evals/results/vibe-harness-core.offline.json; 4632B; a522927e2568 |
| audit-reports/2026-09-08-astra-autonomy/result-candidate.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 2,; 74102B; 67f31b64f098 |
| audit-reports/2026-09-11-rules-optimization-plan.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Vibe-Harness rules 规范优化 · 详细执行计划; 13753B; 751e1aec459c |
| audit-reports/2026-09-15-agent-config-review.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Vibe-Harness Agent 配置全面审查与优化调整计划; 122681B; fcdb5859e549 |
| audit-reports/2026-09-18-architecture-audit-synthesis.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Vibe-Harness 架构级审查三方综合 · 结论与分阶段改进路线; 28490B; d6ad8dab3cf3 |
| audit-reports/2026-09-22-architecture-review.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Vibe-Harness 架构审查报告（第一性原理 × 8 视角）; 13898B; b0927e801f36 |
| audit-reports/2026-09-22-optimization-plan.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Vibe-Harness 优化执行方案（P0+P1 全 8 项）; 9192B; cc01352f5d2b |
| audit-reports/governance-metrics-report.html | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: <!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale; 41966B; be1435c16978 |
| commitlint.config.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: export default {; 327B; b6722d17ae5c |
| docs/README.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Vibe-Harness 文档索引; 6375B; 9c6f69c77ea1 |
| docs/adr/ADR-0001-linear-explicit-execution-and-dag.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 5585B; ae937ca1d89c |
| docs/adr/ADR-0002-linear-execution-envelope-and-recovery.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 9519B; 5dc51912e36e |
| docs/adr/ADR-0003-lightweight-gitflow.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 6743B; ea7e22c8b4b2 |
| docs/adr/ADR-0004-task-decomposition-governance.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 3943B; 399e6f05570a |
| docs/adr/ADR-0005-rules-governance.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 3722B; 39e0f24feaa7 |
| docs/adr/ADR-0006-release-gated-ci-writer-landed-merges.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 4736B; 2a9fe805e287 |
| docs/adr/ADR-0007-dag-result-unverified.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 4080B; a1ab2e800f45 |
| docs/adr/README.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 架构决策记录（ADR）; 1558B; e6b8405803bc |
| docs/adr/catalog.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 760B; b0c33821f71c |
| docs/architecture.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Vibe-Harness 架构说明; 11534B; 64b56fd5d4c4 |
| docs/archive/README.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 历史归档; 2294B; 279b3783774d |
| docs/archive/plans/loopengine-v0.4-governance-closure-plan.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # LoopEngine v0.4 Governance Closure Implementation Plan; 4180B; f2a432898ef2 |
| docs/archive/plans/loopengine-v1-extraction-plan.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # LoopEngine v1 抽取计划; 901B; 07b4b1e40e73 |
| docs/archive/releases/release-v0.1.0.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 发布检查清单; 850B; eb64dc2525c2 |
| docs/archive/releases/release-v0.2.0.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # v0.2.0 发布检查清单; 1275B; e5f4ae72ff69 |
| docs/archive/reviews/COGNIS-AO-001-POLICY-red-team.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: 状态：Completed; 1445B; 58c5a34ca3d0 |
| docs/archive/reviews/COGNIS-AO-001-TESTS-red-team.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: 状态：Completed; 1422B; a95a5729ec86 |
| docs/archive/reviews/COGNIS-AO-001-red-team.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: 状态：Completed; 5446B; 58b0f23a7321 |
| docs/archive/reviews/COGNIS-FULL-TOOL-001-red-team.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: 状态：Completed; 1938B; 558bc91323d7 |
| docs/archive/reviews/COGNIS-GOAL-001-red-team.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: 状态：Completed; 3980B; 6b79c7a42ca5 |
| docs/archive/reviews/COGNIS-HANDOFF-001-red-team.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: 状态：Completed; 2670B; 33a6b9ac4cc6 |
| docs/archive/reviews/COGNIS-HOOK-001-red-team.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: 状态：Completed; 1662B; eb617064120c |
| docs/archive/reviews/COGNIS-MA-001-red-team.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: 状态：Completed; 5033B; 7a463f7bc2fc |
| docs/archive/specs/cognis-v0.5-simplified-governance-spec.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Cognis v0.5 中文精简治理规格; 3703B; 8b3c3083ce53 |
| docs/archive/specs/cognis-v0.6-multi-agent-governance-spec.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Cognis v0.6 父子任务多 Agent 治理规格; 5642B; 79cc4ffc63cf |
| docs/archive/specs/cognis-v0.7-adaptive-orchestration-spec.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: 状态：Superseded; 4994B; 80107779fd65 |
| docs/archive/specs/cognis-v0.8-outcome-first-adaptive-spec.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Cognis v0.8 结果优先自适应执行路径; 1316B; 5403e5dc17b5 |
| docs/archive/specs/cognis-v0.9-handoff-independent-verification-spec.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: 状态：Superseded; 5545B; b2a1e2337950 |
| docs/archive/specs/loopengine-v0.2-installer-spec.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # LoopEngine v0.2 安装器增强规格; 2660B; 2178062f0505 |
| docs/archive/specs/loopengine-v0.4-governance-closure-spec.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # LoopEngine v0.4 治理闭环规格; 4808B; eb6f730301ad |
| docs/archive/specs/loopengine-v1-spec.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # LoopEngine v1 规格; 1837B; 1d8ff71cfc21 |
| docs/archive/tasks/CBM-RESOURCE-001.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: 状态：Completed; 4618B; cf769034248f |
| docs/archive/tasks/COGNIS-ADAPTIVE-002.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: 状态：Completed; 3538B; 4056c2ea2bb9 |
| docs/archive/tasks/COGNIS-AO-001-POLICY.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: 状态：Completed; 3348B; 18964243e9e0 |
| docs/archive/tasks/COGNIS-AO-001-TESTS.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: 状态：Completed; 3119B; 2f347fe16b7f |
| docs/archive/tasks/COGNIS-AO-001.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: 状态：Completed; 6375B; 957f8ffd12d2 |
| docs/archive/tasks/COGNIS-GOAL-001.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: 状态：Completed; 13153B; cdfefaefe82a |
| docs/archive/tasks/COGNIS-HANDOFF-001.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: 状态：Completed; 20887B; 2820e552db10 |
| docs/archive/tasks/COGNIS-HOOK-001.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: 状态：Completed; 4048B; 8375f027db32 |
| docs/archive/tasks/COGNIS-MA-001.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: 状态：Completed; 4875B; ea6cfe6e67f6 |
| docs/audits.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 项目审计; 4917B; 79ae66c1234a |
| docs/catalog.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 28698B; 7529997a664d |
| docs/evals.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 评测驱动开发; 22532B; e2ecf8c396f8 |
| docs/github-delivery.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # GitHub 三层分支与可靠交付配置; 6845B; 88cafb62733e |
| docs/hooks.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Hook 安全策略; 23148B; fba973e1314c |
| docs/inventory/ai-eval-investigation.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # AI 专属 Eval 体系调查报告; 23208B; f354e13fc772 |
| docs/inventory/governance-audit-2026-09.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 治理规范与工作流审计（2026-09）; 14391B; 91b23d2c38d3 |
| docs/inventory/governance-reference-analysis.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 执行模型收敛记录; 617B; 00b322e10e72 |
| docs/inventory/harness-superpowers-comparison.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Vibe-Harness 与 Superpowers 系统审查; 32135B; adfad002c37c |
| docs/inventory/preexisting-test-failures-remediation.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Pre-existing 测试失败处理方案; 7212B; 74f965c55926 |
| docs/inventory/redaction-map.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 脱敏映射; 481B; fa492a350e07 |
| docs/inventory/response-mode-investigation.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 表达模式（Response Mode）业界机制调查; 7828B; 4a0693499a74 |
| docs/inventory/skills-optimization-zh.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Skills 精简记录; 1371B; 038f7a14bf28 |
| docs/inventory/source-assets.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 源资产盘点; 730B; f1646bdd9b44 |
| docs/inventory/source-rules-mapping.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Source Rules Mapping; 2595B; 35d073f054d7 |
| docs/inventory/workflow-clarification-review.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 工作流与需求澄清能力审查; 5032B; 725885001c94 |
| docs/memory/ARCHITECTURE.md | 无法确认 | Memory body 按边界不读；仅记录存在和字节数 | 83B; metadata-only |
| docs/memory/DECISIONS.md | 无法确认 | Memory body 按边界不读；仅记录存在和字节数 | 2478B; metadata-only |
| docs/memory/FAILURE_LEARNINGS.md | 无法确认 | Memory body 按边界不读；仅记录存在和字节数 | 164B; metadata-only |
| docs/memory/IMPROVEMENTS.json | 无法确认 | Memory body 按边界不读；仅记录存在和字节数 | 117B; metadata-only |
| docs/memory/KNOWN_BUGS.md | 无法确认 | Memory body 按边界不读；仅记录存在和字节数 | 98B; metadata-only |
| docs/memory/PROJECT_STATE.md | 无法确认 | Memory body 按边界不读；仅记录存在和字节数 | 1462B; metadata-only |
| docs/memory/TECH_DEBT.md | 无法确认 | Memory body 按边界不读；仅记录存在和字节数 | 32536B; metadata-only |
| docs/migration-guide.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Vibe-Harness 迁移指南; 6228B; fc8e98ded279 |
| docs/plans/governance-evidence.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # governance-evidence：可交接计划与增量证据; 30565B; 756adf94da1a |
| docs/roles.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 多角色 Agent; 7614B; e7492040fc73 |
| docs/rules/agent-skill-routing.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Skill 编写与路由规则; 6142B; cec96456e703 |
| docs/rules/ai-collab-rules.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # AI 协作规则; 17181B; 2959f77693d5 |
| docs/rules/api-rules.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # API 规则; 4237B; 506358749cf1 |
| docs/rules/ast-grep.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # ast-grep 结构化搜索规则; 2919B; 02e2d70b0634 |
| docs/rules/chrome-devtools-mcp.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Chrome DevTools MCP; 1802B; dc3f475382ad |
| docs/rules/codebase-memory-mcp.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # codebase-memory-mcp; 5454B; 8038ce1ec1d3 |
| docs/rules/codegraph.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # codegraph 仓库索引探索规则; 4054B; ad2c8a0b8dea |
| docs/rules/coding-rules.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 编码规则; 4006B; d51310289eb1 |
| docs/rules/db-rules.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # DB 规则; 3875B; 37756bf0a547 |
| docs/rules/eval-driven-development.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 评测驱动开发; 7472B; 72fb27c20c74 |
| docs/rules/frontend-rules.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 前端规则; 7534B; 1c621be21351 |
| docs/rules/git-rules.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Git 规则; 19032B; 9181a78c5f27 |
| docs/rules/governance-core.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Vibe-Harness 执行内核; 24302B; b51cc847af12 |
| docs/rules/linear-workflow.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Linear 多 Agent 工作流; 23742B; a9e4788fbc6e |
| docs/rules/log-management.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 可观测性与日志管理规则; 5135B; 0ea006d35ee4 |
| docs/rules/micro-verification.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Micro Verification 规则; 3116B; 2faa794deaf2 |
| docs/rules/probe.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # probe 轻量代码检索规则; 2082B; b7bdb866e49e |
| docs/rules/project-directory.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 项目目录规则; 5047B; df39f6fd03ab |
| docs/rules/project-specific-rules.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 项目专属规则; 4255B; 0df0b52efcd1 |
| docs/rules/release-rules.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 发布规则; 2770B; 654d402feb1e |
| docs/rules/response-modes.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 表达模式规则; 7665B; b90a20d7749e |
| docs/rules/review-report.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 审查报告规则; 5491B; a4289a201fba |
| docs/rules/role-routing.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 多角色路由规则; 5354B; 1175f89a264c |
| docs/rules/rtk.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # RTK 命令输出压缩规则; 2278B; e991ff700d43 |
| docs/rules/serena.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # serena 语义符号导航规则; 2803B; ae22aff87fb9 |
| docs/rules/test-rules.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 测试规则; 24785B; 707fbecef4eb |
| docs/rules/troubleshooting.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 排障规则; 7947B; d05f1a2c16ef |
| docs/schemas/adr.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L8:     "id": { "type": "string", "pattern": "^ADR-[0-9]{4}$" },; 1370B; 98803c1f1b95 |
| docs/schemas/audit-report.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "type": "integer", "enum": [1] },; 3038B; 850060b5c9ff |
| docs/schemas/eval-reference.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "type": "integer", "enum": [1, 2] },; 2248B; c0c4f8f9a9d5 |
| docs/schemas/eval-run.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "type": "integer", "enum": [1, 2] },; 22939B; 32451b4d3d2a |
| docs/schemas/eval-suite.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "type": "integer", "enum": [1] },; 15457B; adce30ff5b4e |
| docs/schemas/execution-envelope-v2.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L64:               "id": { "type": "string", "minLength": 1, "maxLength": 256 },; 5830B; a24733a0637e |
| docs/schemas/execution-envelope.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {; 2839B; 47fb08dea50f |
| docs/schemas/harness-eval-fixture.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "const": 1 },; 2736B; 5da62af34afb |
| docs/schemas/harness-eval-result.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "const": 3 },; 3876B; 3f0a45f69584 |
| docs/schemas/harness-eval-scenario.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "const": 3 },; 5260B; 6adbc9285a26 |
| docs/schemas/improvements-queue.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "type": "integer", "enum": [1] },; 1576B; fdaa776005a5 |
| docs/schemas/micro-verification.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "const": 1 },; 1365B; ab0cbf7f5d92 |
| docs/schemas/project-config.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L57:               "id": { "type": "string", "minLength": 1 },; 15236B; 23db7447c1df |
| docs/schemas/project-verification.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L8:     "status": { "enum": ["ready", "invalid"] },; 2180B; 8eed7c5d8b33 |
| docs/schemas/release-evidence.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "type": "integer", "const": 2 },; 1900B; cb288484cb71 |
| docs/schemas/review-receipt.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "type": "integer", "enum": [1, 2] },; 3480B; cadeb6244137 |
| docs/schemas/role-pack.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "type": "integer", "const": 1 },; 2495B; c152710f9a60 |
| docs/specs/adaptive-verification-engine.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Adaptive Verification Engine; 2829B; 8ba748041094 |
| docs/specs/agentmemory-skill-consolidation-spec.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Agentmemory Skill 收敛规格; 1472B; 15f21d808288 |
| docs/specs/harness-evals-framework.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Harness Evals Framework; 11350B; fa8cb8bdc5c6 |
| docs/specs/hook-runtime-diagnostics-spec.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Hook 运行时诊断规格; 1724B; 634c9162f775 |
| docs/specs/linear-multi-agent-workflow-spec.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Linear 多 Agent 工作流规格; 18209B; 49fda94eb66c |
| docs/specs/vibe-harness-tooling-modules-spec.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Vibe-Harness 显式工具插件规格; 14494B; b75f416a1f60 |
| docs/templates/delivery.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 交付记录; 1196B; 37d67215bf53 |
| docs/templates/evidence.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 证据附件：<任务 / 单元 ID>; 2185B; e3ee9646cbc9 |
| docs/templates/find-question.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 跨层一致性审查（find-question）; 11059B; b91dd4b2547a |
| docs/templates/finding-report.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # <主题> 审查报告; 2304B; bdba975fecbe |
| docs/templates/less_harness_token.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Improve this agent harness's token efficiency; 15248B; b13ddb44c92f |
| docs/templates/micro-check.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Micro Check; 390B; fca2dbf7beb0 |
| docs/templates/plan.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # <任务编号> <标题>; 2980B; c830b58b3cb6 |
| docs/templates/review-brief.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 复审简报：<单元 / 变更 ID>; 1614B; 5f661cc75bce |
| docs/templates/task.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # <任务编号> <标题>; 3287B; 82fcfe78db3a |
| docs/templates/verification-plan.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Verification Plan; 308B; ca8c90210a18 |
| docs/templates/verification-receipt.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Verification Receipt; 365B; fc615a42e643 |
| docs/templates/workflow.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 全生命周期工作流; 5061B; 93b5ea00a50f |
| eslint.config.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L8: import eslint from '@eslint/js';; 1565B; eccc7530f722 |
| evals/clarification-cases.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 2,; 10776B; 39c490020ecf |
| evals/goal-definition-cases.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 4825B; e4a9bd4ab7bd |
| evals/goal-definition-trials.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 8256B; 503743d03f89 |
| evals/references/vibe-harness-core.offline.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 2,; 3616B; 3bf4e3debae3 |
| evals/results/vibe-harness-behavioral.stub.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 2,; 13848B; a34e63f86bfa |
| evals/results/vibe-harness-core.offline.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 2,; 77723B; 60e5670d80fc |
| evals/suites/linear-workflow-online.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 43529B; e4caa43c7fd5 |
| evals/suites/vibe-harness-behavioral.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 11232B; 6d31207b4162 |
| evals/suites/vibe-harness-core.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 79210B; a6b2dbf38142 |
| evals/suites/vibe-harness-online-autonomy.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 40510B; 50918138ade2 |
| evals/suites/vibe-harness-online-canary.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 99456B; 88fcee39dc0f |
| evals/suites/vibe-harness-online-execution.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 42812B; df330181a903 |
| evals/suites/vibe-harness-response-modes.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 11240B; 29dbb17f19b7 |
| evals/suites/vibe-harness-role-routing.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 14816B; b481a3277193 |
| evals/suites/vibe-harness-tool-routing.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 16416B; 6235b8bd1086 |
| examples/minimal-project/README.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 最小项目示例; 240B; 46e0c6207973 |
| examples/minimal-project/vibe-harness.config.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {; 444B; c0ea8717488c |
| examples/sybaseprojectweb-redacted/README.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 脱敏源项目示例; 233B; 0c2bb0110e57 |
| examples/sybaseprojectweb-redacted/vibe-harness.config.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {; 463B; 1080f5f44d55 |
| harness-evals/adapters/legacy-run.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { buildResultV3 } from '../lib/result.js';; 3086B; 235e7b9a1af3 |
| harness-evals/baselines/baseline.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { createHash } from 'node:crypto';; 1189B; cb0f97259a0e |
| harness-evals/docs/pressure-catalog.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Pressure catalog; 2935B; 780d095c1670 |
| harness-evals/docs/scenario-authoring.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Scenario authoring; 4579B; f5c30b688700 |
| harness-evals/external/README.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # External benchmark adapters; 1653B; e03b1faa1e26 |
| harness-evals/external/adapter-contract.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { createHash } from 'node:crypto';; 5100B; da532688b0ac |
| harness-evals/external/cooperbench/README.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # CooperBench adapter; 574B; 530a97f27543 |
| harness-evals/external/cooperbench/adapter.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import {; 2916B; fb944b8149a0 |
| harness-evals/external/cooperbench/official-result.fixture.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {; 277B; 5974698a54aa |
| harness-evals/external/cooperbench/sample-manifest.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 530B; 005d1e6dbda5 |
| harness-evals/external/index.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: export { cooperBenchAdapter } from './cooperbench/adapter.js';; 413B; 078968970531 |
| harness-evals/external/runner.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { spawn } from 'node:child_process';; 1967B; 07ea8ee50f16 |
| harness-evals/external/swe-bench/README.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # SWE-bench adapters; 815B; f1886b465422 |
| harness-evals/external/swe-bench/adapter.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import path from 'node:path';; 3351B; 3e26e7b4cc5c |
| harness-evals/external/swe-bench/live-official-result.fixture.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {; 194B; c8dc19eb2285 |
| harness-evals/external/swe-bench/live-sample-manifest.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 607B; ad167195154a |
| harness-evals/external/swe-bench/official-result.fixture.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {; 115B; bd30bb200c57 |
| harness-evals/external/swe-bench/sample-manifest.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 546B; 5fe85538beec |
| harness-evals/external/terminal-bench/README.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Terminal-Bench through Harbor; 527B; 7080747e6faa |
| harness-evals/external/terminal-bench/adapter.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import path from 'node:path';; 2649B; a55ac14f091d |
| harness-evals/external/terminal-bench/official-result.fixture.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {; 121B; 73b86eb5095f |
| harness-evals/external/terminal-bench/sample-manifest.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 527B; 6b3c6f0af558 |
| harness-evals/fixtures/H01-rule-conflict-fixture.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 1042B; 48c2a545650e |
| harness-evals/fixtures/H02-rule-omission-fixture.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 1186B; f3eae09bc804 |
| harness-evals/fixtures/H03-tdd-fixture.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 1226B; a39bd91e9233 |
| harness-evals/fixtures/H04-verification-fixture.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 832B; 47dfddf193af |
| harness-evals/fixtures/H05-premature-completion-fixture.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 1179B; 021c1ae0055f |
| harness-evals/fixtures/H06-false-completion-fixture.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 1106B; 32852c96c98f |
| harness-evals/fixtures/H07-broken-plan-fixture.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 1000B; 46a108814b5a |
| harness-evals/fixtures/H08-replan-fixture.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 1153B; 12dd59287616 |
| harness-evals/fixtures/H09-tool-failure-fixture.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 1174B; e43550811a6b |
| harness-evals/fixtures/H10-build-failure-fixture.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 940B; e2df21d470df |
| harness-evals/fixtures/H11-test-failure-fixture.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 1114B; 862ee83ad205 |
| harness-evals/fixtures/H12-context-loss-fixture.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 939B; 12d6a5a7ca9b |
| harness-evals/fixtures/H13-stale-context-fixture.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 849B; a637b138cd2a |
| harness-evals/fixtures/H14-agent-handoff-fixture.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 1087B; 0bfabb1e893a |
| harness-evals/fixtures/H15-subagent-failure-fixture.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 969B; fee5c6157382 |
| harness-evals/fixtures/H16-multi-agent-dependency-fixture.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 1258B; c53211a65547 |
| harness-evals/fixtures/H17-duplicate-work-fixture.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 1053B; 8d245e40fc6b |
| harness-evals/fixtures/H18-worktree-conflict-fixture.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 1092B; b19a30616cde |
| harness-evals/fixtures/H19-merge-conflict-fixture.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 1641B; 8594fc099bbd |
| harness-evals/fixtures/H20-interrupted-resume-fixture.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 1042B; 260a94f79a99 |
| harness-evals/fixtures/README.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Fixture manifests; 434B; bec0a6087bda |
| harness-evals/fixtures/materializer.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { spawn } from 'node:child_process';; 7475B; 4ea6992f22b0 |
| harness-evals/lib/catalog.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { readFile } from 'node:fs/promises';; 1994B; 28eb246c4e22 |
| harness-evals/lib/index.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: export { adaptLegacyRun } from '../adapters/legacy-run.js';; 1360B; cf2218fba489 |
| harness-evals/lib/result.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { createHash } from 'node:crypto';; 5251B; 092ff415aa64 |
| harness-evals/metrics/metrics.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L20: function round(value) {; 14370B; ace9ed97cecf |
| harness-evals/readme.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Harness Evals; 10507B; 2f3aabb85ac8 |
| harness-evals/regressions/collaboration.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: function metric(result, group, name) {; 3011B; 083fa129aed0 |
| harness-evals/regressions/compare.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L3: function key(result) {; 5428B; bb98e0e15930 |
| harness-evals/regressions/impact-map.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 879B; 543c27ffa835 |
| harness-evals/regressions/select.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L4: export function selectScenariosForChanges({ changedPaths = [], impactMap, allScenarioIds = [] } = /** @type {{impactMap: {rul; 1391B; b5b8feaede2e |
| harness-evals/reports/report.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { redactTraceValue } from '../traces/atif.js';; 4088B; 3561555e05e2 |
| harness-evals/runners/codex-cli.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { spawn } from 'node:child_process';; 26559B; 00d4e9a4ef3b |
| harness-evals/runners/planner.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L4: function repetitions(scenario, tier) {; 3120B; 31cd2250953e |
| harness-evals/runners/runner.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { buildResultV3 } from '../lib/result.js';; 9630B; bdfbe81eafb2 |
| harness-evals/scenarios/H01-rule-conflict.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 3,; 2155B; 9d6684727f60 |
| harness-evals/scenarios/H02-rule-omission.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 3,; 2243B; 75f6e487e6ae |
| harness-evals/scenarios/H03-tdd-skip.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 3,; 2395B; 3cfcbf4ff03f |
| harness-evals/scenarios/H04-verification-skip.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 3,; 2192B; 1be391914a03 |
| harness-evals/scenarios/H05-premature-completion.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 3,; 2313B; ec8d83192d71 |
| harness-evals/scenarios/H06-false-completion.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 3,; 2254B; f8476afeb986 |
| harness-evals/scenarios/H07-broken-plan.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 3,; 2259B; 8ca4ce2a1e88 |
| harness-evals/scenarios/H08-replan.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 3,; 2254B; e288480242e8 |
| harness-evals/scenarios/H09-tool-failure.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 3,; 2340B; f9c9eb76286d |
| harness-evals/scenarios/H10-build-failure.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 3,; 2245B; 9082c1a53556 |
| harness-evals/scenarios/H11-test-failure.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 3,; 2194B; 909e280a533e |
| harness-evals/scenarios/H12-context-loss.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 3,; 2494B; 3255d43d7f47 |
| harness-evals/scenarios/H13-stale-context.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 3,; 2200B; 9e0edf05c05c |
| harness-evals/scenarios/H14-agent-handoff.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 3,; 2434B; f5b4916fe554 |
| harness-evals/scenarios/H15-subagent-failure.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 3,; 2339B; 221acf8787ff |
| harness-evals/scenarios/H16-multi-agent-dependency.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 3,; 2424B; 38f1a5490b12 |
| harness-evals/scenarios/H17-duplicate-work.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 3,; 2219B; 0e2ad30a454b |
| harness-evals/scenarios/H18-worktree-conflict.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 3,; 2374B; 756f8b40d354 |
| harness-evals/scenarios/H19-merge-conflict.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 3,; 2380B; 0852d41d446e |
| harness-evals/scenarios/H20-interrupted-resume.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 3,; 2464B; 0f0118d4448a |
| harness-evals/scenarios/README.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Internal Harness scenarios; 468B; 8a3e763fe4d6 |
| harness-evals/scenarios/index.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 5655B; 1b5836398f83 |
| harness-evals/traces/atif.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { createHash } from 'node:crypto';; 8800B; 78cd91614cba |
| harness-evals/traces/store.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import path from 'node:path';; 940B; 637af88537f9 |
| harness-evals/verifiers/deterministic.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { redactTraceValue } from '../traces/atif.js';; 2799B; e2cc4fc53b76 |
| harness-evals/verifiers/scenario.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { spawn } from 'node:child_process';; 15454B; 3d15884e873a |
| jsconfig.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {; 533B; 90b6212700ed |
| manifests/adapters.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 5,; 11587B; cd7e882656c3 |
| manifests/capabilities.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 2,; 25807B; c4463f55b4b5 |
| manifests/install-presets.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 517B; edd857215eb8 |
| manifests/plugin-providers.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 5089B; 39341154c925 |
| manifests/profiles.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 1481B; e2c499d15e6a |
| manifests/red-zone.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 1096B; 33dc03092f1f |
| manifests/roles.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 4473B; 21fe072b993e |
| manifests/rules.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 1996B; e7d077d8fe00 |
| manifests/skills.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 3681B; 6d87aac8881f |
| memory/CURRENT.md | 无法确认 | Memory body 按边界不读；仅记录存在和字节数 | 1101B; metadata-only |
| memory/README.md | 无法确认 | Memory body 按边界不读；仅记录存在和字节数 | 2245B; metadata-only |
| memory/decisions.md | 无法确认 | Memory body 按边界不读；仅记录存在和字节数 | 394B; metadata-only |
| memory/observations.md | 无法确认 | Memory body 按边界不读；仅记录存在和字节数 | 255B; metadata-only |
| memory/sessions/README.md | 无法确认 | Memory body 按边界不读；仅记录存在和字节数 | 309B; metadata-only |
| package.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "name": "@jw/vibe-harness",; 9757B; dff87fe87c3d |
| pnpm-lock.yaml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: lockfileVersion: '9.0'; 48097B; 7e40b304ffe8 |
| roles/base.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Vibe-Harness 角色契约; 2025B; 5469d029b6e7 |
| roles/prompts/adversarial-security-reviewer.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 黑客审查者; 725B; d8644701bcc4 |
| roles/prompts/chief-architect.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 首席架构师; 718B; 8bc8dcc802bc |
| roles/prompts/product-manager.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 产品经理; 654B; 7c623212f7ac |
| roles/prompts/senior-engineer.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 高级工程师; 627B; c1e7e05e584c |
| roles/prompts/technical-project-manager.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 技术项目经理; 663B; 02579bc73e4e |
| roles/prompts/technical-release-manager.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 发布就绪审查者; 671B; a019b3a65d10 |
| roles/prompts/test-lead.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 测试负责人; 657B; 3ae914c6217a |
| runtime/commands/run.mjs | 部分实现 | task init 可持久化；运行时其他能力交深读 | L3362: if (args.write) writeTaskAnchor(read.filePath, anchor);; 199032B; 309cc0207362 |
| runtime/evals/codex-runner.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import { spawn } from 'node:child_process';; 73468B; 53477fe0b4d5 |
| runtime/evals/lib/hidden-tests.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { spawn } from 'node:child_process';; 3724B; d304b9582fe4 |
| runtime/evals/lib/knowledge-coverage.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L3: function ownerKey(owner) {; 9026B; 48b03c889435 |
| runtime/evals/lib/protected-config.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { createHash } from 'node:crypto';; 1503B; bf3e26cde2de |
| runtime/evals/observers.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 4329B; c011d6210f43 |
| runtime/evals/run.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import { createHash } from 'node:crypto';; 6651B; 21d935c27f62 |
| runtime/hooks/README.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Project safety hooks; 6761B; 4fe4841374bb |
| runtime/hooks/codex-hook.mjs | 已实现 | 源级 Hook 只读快速路径存在；不证明宿主启用 | L126: if (isReadOnlyToolName(String(input.toolName ?? '')) && commandFrom(input) === '') {; 9691B; 6970d5c9a4fb |
| runtime/hooks/git-hook.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import { execFile, spawn } from 'node:child_process';; 6920B; d0f1346ff512 |
| runtime/hooks/lib/context.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { execFile } from 'node:child_process';; 6597B; a3dc6bf53961 |
| runtime/hooks/lib/execution-envelope.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { execFileSync } from 'node:child_process';; 44875B; 3e68d32de52a |
| runtime/hooks/lib/frozen-test-writes.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { readFile, readdir, realpath } from 'node:fs/promises';; 13616B; c7258b624200 |
| runtime/hooks/lib/policy.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import path from 'node:path';; 31490B; 617a00009af0 |
| runtime/hooks/lib/read-only-commands.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L162: export function shellSegments(command) {; 20780B; 10cf285479bc |
| runtime/hooks/lib/role-permissions.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { isWorkspaceToolName } from './read-only-commands.mjs';; 2776B; c6c0dcf85e68 |
| runtime/hooks/lib/rtk.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { spawn } from 'node:child_process';; 6842B; c09c9e6e4020 |
| runtime/lib/micro-runner.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { spawn } from 'node:child_process';; 8233B; fff333d6ac0c |
| runtime/lib/rtk-environment.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { mkdir } from 'node:fs/promises';; 939B; a618e4817d4b |
| runtime/lib/worktree-audit.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L18: import path from 'node:path';; 21653B; 0465a208c0a7 |
| runtime/lib/worktree-ports.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L14: import { existsSync, readFileSync, readdirSync } from 'node:fs';; 16258B; e57a00df80af |
| runtime/tools/ast-grep/args.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: export function normalizeAstGrepArgs(input) {; 159B; e181937e32b2 |
| runtime/tools/ast-grep/package-lock.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "name": "@vibe-harness/ast-grep-runtime",; 5043B; 30cdccaf7c45 |
| runtime/tools/ast-grep/package.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "name": "@vibe-harness/ast-grep-runtime",; 220B; 380a8da3cc1c |
| runtime/tools/ast-grep/run.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { spawn } from 'node:child_process';; 780B; a3f8f17d5e09 |
| runtime/tools/chrome-devtools-mcp/package-lock.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "name": "@vibe-harness/chrome-devtools-mcp-runtime",; 1277B; f0f05ed8c7fe |
| runtime/tools/chrome-devtools-mcp/package.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "name": "@vibe-harness/chrome-devtools-mcp-runtime",; 302B; 9e0559c39b4c |
| runtime/tools/chrome-devtools-mcp/run.mjs | 部分实现 | 包装器启动子进程；依赖包与浏览器可用性未验证 | L27: const child = spawn(process.execPath, [entry, ...args], {; 1580B; fa9a96773d9e |
| runtime/tools/codebase-memory-mcp/cache-path.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L14: import { createHash } from 'node:crypto';; 3660B; 2537af9be97b |
| runtime/tools/codebase-memory-mcp/cbmignore.template | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: /.agents/; 186B; 2f958fdb07c4 |
| runtime/tools/codebase-memory-mcp/index-state.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L10: import { readFile, writeFile } from 'node:fs/promises';; 3739B; a6e62bb50ad9 |
| runtime/tools/codebase-memory-mcp/package-lock.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "name": "@vibe-harness/codebase-memory-mcp-runtime",; 967B; b61434c23187 |
| runtime/tools/codebase-memory-mcp/package.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "name": "@vibe-harness/codebase-memory-mcp-runtime",; 286B; e2f9ff29bbb9 |
| runtime/tools/codebase-memory-mcp/path-alias.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { createHash } from 'node:crypto';; 783B; 10bc94018bd4 |
| runtime/tools/codebase-memory-mcp/pnpm-lock.yaml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: lockfileVersion: '9.0'; 517B; 083e380aadbd |
| runtime/tools/codebase-memory-mcp/pnpm-workspace.yaml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: allowBuilds:; 62B; c0bdbd86be96 |
| runtime/tools/codebase-memory-mcp/project-root.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L7: import { spawnSync } from 'node:child_process';; 2049B; 873160d5da64 |
| runtime/tools/codebase-memory-mcp/run.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L22: import { spawn } from 'node:child_process';; 9433B; e34b2efebfa8 |
| runtime/tools/open-code-review/ocr-config.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { readFile } from 'node:fs/promises';; 9041B; 2d5e33f79d86 |
| runtime/tools/open-code-review/package-lock.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "name": "@vibe-harness/open-code-review-runtime",; 4316B; 936421047d13 |
| runtime/tools/open-code-review/package.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "name": "@vibe-harness/open-code-review-runtime",; 332B; 2552e50e728c |
| runtime/tools/open-code-review/run.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import { spawn } from 'node:child_process';; 1837B; ebce86523569 |
| runtime/tools/playwright-cli/package-lock.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "name": "@vibe-harness/playwright-cli-runtime",; 2601B; c6c4578953af |
| runtime/tools/playwright-cli/package.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "name": "@vibe-harness/playwright-cli-runtime",; 287B; 066330c03384 |
| runtime/tools/playwright-cli/run.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import { createHash } from 'node:crypto';; 13688B; 459ea066f1b8 |
| runtime/tools/rtk/package-lock.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "name": "@vibe-harness/rtk-runtime",; 610B; ae175b0ea304 |
| runtime/tools/rtk/package.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "name": "@vibe-harness/rtk-runtime",; 203B; ac1c0ed995c4 |
| runtime/tools/rtk/run.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { createHash } from 'node:crypto';; 13268B; 1c28debfa433 |
| schemas/adapter-pack.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "type": "integer", "const": 5 },; 7140B; 3df23656aec3 |
| schemas/adr.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L8:     "id": { "type": "string", "pattern": "^ADR-[0-9]{4}$" },; 1370B; 98803c1f1b95 |
| schemas/audit-report.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "type": "integer", "enum": [1] },; 3038B; 850060b5c9ff |
| schemas/capability-catalog.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "type": "integer", "enum": [2] },; 1726B; 8810fe9ebac0 |
| schemas/docs-catalog.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "type": "integer", "enum": [1] },; 1355B; 6ca72140d895 |
| schemas/eval-reference.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "type": "integer", "enum": [1, 2] },; 2248B; c0c4f8f9a9d5 |
| schemas/eval-run.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "type": "integer", "enum": [1, 2] },; 22939B; 32451b4d3d2a |
| schemas/eval-suite.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "type": "integer", "enum": [1] },; 15457B; adce30ff5b4e |
| schemas/execution-envelope-v2.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L64:               "id": { "type": "string", "minLength": 1, "maxLength": 256 },; 5830B; a24733a0637e |
| schemas/execution-envelope.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {; 2839B; 47fb08dea50f |
| schemas/harness-eval-fixture.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "const": 1 },; 2736B; 5da62af34afb |
| schemas/harness-eval-result.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "const": 3 },; 3876B; 3f0a45f69584 |
| schemas/harness-eval-scenario.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "const": 3 },; 5260B; 6adbc9285a26 |
| schemas/improvements-queue.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "type": "integer", "enum": [1] },; 1576B; fdaa776005a5 |
| schemas/install-map.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {; 1378B; d9dac63da896 |
| schemas/install-preset.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "type": "integer", "const": 1 },; 1501B; c564b54a25a5 |
| schemas/install-state.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L4:   "description": "校验 install-state.json。旧状态在迁移期间仍可读取。规范 stateVersion 5 写入 targets 而不是 adapter，并为托管与生成资产记录共享或 adapter 作用域的 own; 5971B; b80e73f4463a |
| schemas/micro-verification.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "const": 1 },; 1365B; ab0cbf7f5d92 |
| schemas/plugin-provider-catalog.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "type": "integer", "const": 1 },; 2301B; 0d6347636f1b |
| schemas/profile-pack.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "type": "integer", "minimum": 1 },; 806B; e39a31c3321a |
| schemas/project-baseline.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "type": "integer", "enum": [2] },; 11404B; a98c7f7f2f1e |
| schemas/project-config.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L57:               "id": { "type": "string", "minLength": 1 },; 15236B; 23db7447c1df |
| schemas/project-verification.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L8:     "status": { "enum": ["ready", "invalid"] },; 2180B; 8eed7c5d8b33 |
| schemas/red-zone.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "type": "integer", "const": 1 },; 610B; 1c4ba723f612 |
| schemas/release-evidence.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "type": "integer", "const": 2 },; 1900B; cb288484cb71 |
| schemas/review-receipt.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "type": "integer", "enum": [1, 2] },; 3480B; cadeb6244137 |
| schemas/role-pack.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "type": "integer", "const": 1 },; 2495B; c152710f9a60 |
| schemas/rule-pack.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "type": "integer", "minimum": 1 },; 601B; 54a08de70f2a |
| schemas/skill-pack.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L7:     "schemaVersion": { "type": "integer", "minimum": 1 },; 1142B; 522189901eec |
| scripts/adr-new.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L8: import { pathToFileURL } from 'node:url';; 5904B; f373ad617391 |
| scripts/branch-policy.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import { readFile } from 'node:fs/promises';; 1817B; fd5b43ea158b |
| scripts/check-pull-request-approval.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L8: import { readFile } from 'node:fs/promises';; 3325B; e47ed93d7964 |
| scripts/docs-audit.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import { validateDocumentation } from './lib/docs-validation.js';; 757B; 90c907f80d83 |
| scripts/docs-sync.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L9: import { pathToFileURL } from 'node:url';; 2380B; 5ced9064cc02 |
| scripts/envelope.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L10: import { readFileSync } from 'node:fs';; 11138B; b741b6bc7f2a |
| scripts/eval-behavioral.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import path from 'node:path';; 4097B; 60be7e9d688a |
| scripts/eval-check.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import path from 'node:path';; 6856B; f449f8b30179 |
| scripts/eval-clarification-check.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import { readFile } from 'node:fs/promises';; 705B; 5beea6e86638 |
| scripts/eval-compare.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import { readdir, readFile } from 'node:fs/promises';; 1777B; 128293ded95b |
| scripts/eval-goal-check.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import { readFile } from 'node:fs/promises';; 1197B; a17c0c170ad2 |
| scripts/eval-governance-smoke.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L5: import { readJson } from './lib/manifest.js';; 6055B; 7519fe934c73 |
| scripts/eval-health.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import { appendFile } from 'node:fs/promises';; 1333B; a9f8641c222c |
| scripts/eval-online.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import path from 'node:path';; 4067B; 6f3c91161618 |
| scripts/eval-replay.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import path from 'node:path';; 4709B; 61956e8f25c9 |
| scripts/eval-report.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import { access, mkdir, writeFile } from 'node:fs/promises';; 6838B; 9e17fe2a83c8 |
| scripts/eval-sync.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L7: import { pathToFileURL } from 'node:url';; 2050B; ab23bf5d7127 |
| scripts/harness-evals.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import { spawn } from 'node:child_process';; 19037B; 7aec494eb182 |
| scripts/independent-review.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import { appendFile, readFile } from 'node:fs/promises';; 3098B; 65b203e274b3 |
| scripts/lib/adapter.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import path from 'node:path';; 6045B; 92a014173bc1 |
| scripts/lib/adr-scaffold.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L7: import { readFile, readdir, writeFile } from 'node:fs/promises';; 6438B; 4b2df3436508 |
| scripts/lib/adr-validation.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import path from 'node:path';; 9752B; 20aea668b93f |
| scripts/lib/change-impact.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L6: import { execFile } from 'node:child_process';; 6439B; ba08aff41354 |
| scripts/lib/clarification-metrics.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L9: export function validateClarificationCatalog(catalog) {; 5061B; 64d58fff708c |
| scripts/lib/cleanup-audit.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L14: import { execFile } from 'node:child_process';; 27806B; 3d5db13fb3a2 |
| scripts/lib/codebase-memory-cache.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L14: import { access, rm } from 'node:fs/promises';; 5243B; 42119428b381 |
| scripts/lib/command-status.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { readFile } from 'node:fs/promises';; 1540B; a0bcebc089b9 |
| scripts/lib/docs-projection.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L11: import { readFile, readdir, writeFile } from 'node:fs/promises';; 19714B; 888b2e3bbf33 |
| scripts/lib/docs-validation.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import path from 'node:path';; 24584B; 75e926834a12 |
| scripts/lib/envelope-records.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L10: import { execFileSync } from 'node:child_process';; 20439B; 7b002fb39672 |
| scripts/lib/eval-assets.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { createHash } from 'node:crypto';; 3390B; 388cbb9bac18 |
| scripts/lib/eval-behavioral.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';; 11554B; b8c39a9ee8ff |
| scripts/lib/eval-compare.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: function round(value) {; 5449B; 59e18e460c56 |
| scripts/lib/eval-contract.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import path from 'node:path';; 10131B; cc812d1cd6a2 |
| scripts/lib/eval-health.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { readdir, readFile } from 'node:fs/promises';; 2748B; 2369b4de833d |
| scripts/lib/eval-judge.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L10: import { fileURLToPath } from 'node:url';; 6690B; 0f026e81df5d |
| scripts/lib/eval-projection.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L8: import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';; 4431B; f4678a5d7c45 |
| scripts/lib/eval-replay.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { createHash } from 'node:crypto';; 5336B; b535b226e74f |
| scripts/lib/eval-report.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L3: function round(value, digits = 6) {; 47156B; efa6535d25f4 |
| scripts/lib/eval-runner.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { execFile, spawn } from 'node:child_process';; 20845B; 1dbf916c40f3 |
| scripts/lib/eval-runtime-config.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { createHash } from 'node:crypto';; 10767B; d3067045df66 |
| scripts/lib/eval-scoring.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { EVAL_ASSET_GROUP_NAMES } from './eval-assets.js';; 9720B; c02517853b76 |
| scripts/lib/eval-trials.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L6: import { sanitizeEvalValue } from './eval-scoring.js';; 3893B; b5ad8784bc28 |
| scripts/lib/executable-discovery.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { readdir } from 'node:fs/promises';; 1029B; c19aa4eeedd8 |
| scripts/lib/file-transaction.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { randomUUID } from 'node:crypto';; 13154B; edc782111a2b |
| scripts/lib/git-hooks.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { execFile } from 'node:child_process';; 2179B; 407d1c70cc25 |
| scripts/lib/goal-definition-metrics.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L8: export function validateGoalDefinitionCatalog(catalog) {; 4160B; b34776bba37c |
| scripts/lib/hook-bootstrap.cjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: const{spawnSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');const argv=process.argv.slice(; 2175B; 2e4259d6ae47 |
| scripts/lib/host-hook-state.js | 部分实现 | 读取宿主配置；不证明实际加载或拦截 | L87: content = await readFile(configPath, 'utf8');; 4790B; 207d96c2409a |
| scripts/lib/improvements-audit.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { createHash } from 'node:crypto';; 7230B; 96321373001a |
| scripts/lib/install-planner.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { createHash } from 'node:crypto';; 86035B; 175fe97fedd1 |
| scripts/lib/install-preset.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { readFileSync } from 'node:fs';; 8363B; 9e4216a902c4 |
| scripts/lib/install-state.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { createHash, randomUUID } from 'node:crypto';; 40073B; 10efe6774ca8 |
| scripts/lib/installation-baseline.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';; 3854B; f4d5d20769bb |
| scripts/lib/managed-block.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L15: import { createHash } from 'node:crypto';; 4463B; f32fcd840846 |
| scripts/lib/managed-json-config.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { applyEdits, modify, parse, printParseErrorCode } from 'jsonc-parser';; 7864B; a667feebe55c |
| scripts/lib/manifest.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { access, lstat, readFile, realpath } from 'node:fs/promises';; 15638B; aee38b1ec269 |
| scripts/lib/memory-audit.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { lstat, readFile, readdir } from 'node:fs/promises';; 5768B; 86c4cfade75f |
| scripts/lib/micro-runner.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { spawn } from 'node:child_process';; 4998B; 649d22e81b5f |
| scripts/lib/module-selection.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import {; 8460B; dddd0365a0ed |
| scripts/lib/nested-install.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { readdir, readFile } from 'node:fs/promises';; 2620B; e4b978a256dc |
| scripts/lib/ocr-config.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: export { resolveOcrEndpoint } from '../../runtime/tools/open-code-review/ocr-config.mjs';; 91B; de51ce7a6894 |
| scripts/lib/pack-contract.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L37: function isForbiddenPath(item) {; 1730B; 4dc72934c10a |
| scripts/lib/pack-validation.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import path from 'node:path';; 105649B; ef7b93a78425 |
| scripts/lib/plugin-provider-catalog.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { readFileSync } from 'node:fs';; 5344B; f3ffa48f5c7b |
| scripts/lib/process-tree.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L11: import { spawn } from 'node:child_process';; 1925B; 58c51dbb01ca |
| scripts/lib/product-identity.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L12: export function readProductEnv(env, suffix) {; 485B; d3d49b1e51ad |
| scripts/lib/project-audit.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import path from 'node:path';; 2542B; 662a722340da |
| scripts/lib/project-baseline.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { execFile } from 'node:child_process';; 16808B; c587d8d9aa84 |
| scripts/lib/project-config.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { mkdir, readFile, writeFile } from 'node:fs/promises';; 32284B; 9114ef65bf28 |
| scripts/lib/project-evaluation.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { createHash } from 'node:crypto';; 25337B; 5dbe48b22662 |
| scripts/lib/project-layout.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import path from 'node:path';; 2205B; 47580173bfbe |
| scripts/lib/project-profile.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { readdir, readFile } from 'node:fs/promises';; 20299B; 3788a12c14f8 |
| scripts/lib/project-verification.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { execFile, spawn } from 'node:child_process';; 30511B; 576aed8858cb |
| scripts/lib/receipt-records.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L10: import { randomUUID } from 'node:crypto';; 28933B; d2c1e799cc0b |
| scripts/lib/red-zone.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { readFileSync } from 'node:fs';; 5411B; 62be12f11c6c |
| scripts/lib/redaction.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { readdir, readFile, stat } from 'node:fs/promises';; 2170B; 35ecb944688c |
| scripts/lib/release-evidence.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { createHash } from 'node:crypto';; 1088B; d66c25401028 |
| scripts/lib/release-readiness.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L9: import { execFile } from 'node:child_process';; 5514B; 9dd42ea1cd4c |
| scripts/lib/review-audit.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { execFile } from 'node:child_process';; 8252B; a9893859b99f |
| scripts/lib/risk-evidence.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L15: function sectionContent(body, headingPattern) {; 2538B; fd5c0fae75aa |
| scripts/lib/role-projection.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { readFile } from 'node:fs/promises';; 26398B; 7af9f8e8810f |
| scripts/lib/roles-audit.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { readFile } from 'node:fs/promises';; 19901B; 437022dcaae2 |
| scripts/lib/rules-index.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { readFile } from 'node:fs/promises';; 9217B; d6c7c5591073 |
| scripts/lib/runtime-audit.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { spawn } from 'node:child_process';; 4772B; cea2070d2206 |
| scripts/lib/runtime-diagnostics.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { execFile } from 'node:child_process';; 20742B; 11f61196d78f |
| scripts/lib/safe-json.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L14: function sanitize(value) {; 1308B; 3d968a65307b |
| scripts/lib/safety-posture.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L5: export function adapterSafetyPosture(adapter) {; 1088B; e10259592042 |
| scripts/lib/schema-validation.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L8: function assertSchemaObject(schema, schemaPath) {; 10825B; 01f84678b3f8 |
| scripts/lib/self-install-check.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { createMultiTargetInstallPlan, diffMultiTargetInstall } from './install-planner.js';; 4466B; f0fe65f9f1c6 |
| scripts/lib/shell-command.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L37: export function splitCommand(command, emptyMessage = 'Command is empty.') {; 3476B; 703e7b062a88 |
| scripts/lib/skills-audit.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { readFile } from 'node:fs/promises';; 2558B; 824779b68ed5 |
| scripts/lib/task-dag.js | 已实现 | 存在结构、依赖与 scope 校验函数；非自动派发 | L214: export function validateTaskDag(value) {; 16787B; b80a1e72b8fa |
| scripts/lib/temp-cleanup.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { rm } from 'node:fs/promises';; 217B; 1f5db72f2e97 |
| scripts/lib/template-renderer.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { readFileSync } from 'node:fs';; 14597B; e07aacfcdab4 |
| scripts/lib/test-case-reporter.mjs | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L8: import path from 'node:path';; 2674B; 98f1f950f481 |
| scripts/lib/test-coverage-map.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { readFile } from 'node:fs/promises';; 3895B; 31e5536c4c96 |
| scripts/lib/test-enumeration.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { readdir, readFile } from 'node:fs/promises';; 4034B; c1c51d98b179 |
| scripts/lib/tool-provisioning.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { mkdir } from 'node:fs/promises';; 10506B; 0660e674dac8 |
| scripts/lib/tool-provisioning/environment.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import path from 'node:path';; 12715B; e8964b4ab4cc |
| scripts/lib/tool-provisioning/managed-blocks.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { parse as parseToml, stringify as stringifyToml } from '@iarna/toml';; 5354B; f0d3db46822e |
| scripts/lib/tool-provisioning/runtime-probe.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { createHash } from 'node:crypto';; 29043B; 90035f580b97 |
| scripts/lib/tool-provisioning/subprocess.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { execFile, spawn } from 'node:child_process';; 13849B; 0a40585564a7 |
| scripts/lib/tool-provisioning/tool-state.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';; 2480B; 2ef62712059f |
| scripts/lib/validation-tiers.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L10: import { readdir, readFile } from 'node:fs/promises';; 16172B; 2d4829b1a84c |
| scripts/lib/verification-contract.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L6: export function normalizeVerificationScope(value) {; 8541B; 67e68530ca8e |
| scripts/lib/verification-plan.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { readFile } from 'node:fs/promises';; 28603B; 93c885785543 |
| scripts/lib/workflow-assets.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { readdir, readFile } from 'node:fs/promises';; 1159B; d25f73de52e0 |
| scripts/lib/worktree-audit.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: // Worktree isolation audit — source-repository entry point.; 456B; 80a7a10e9b8b |
| scripts/lib/worktree-ports.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: // Worktree port segmentation — source-repository entry point.; 474B; 7596857838c0 |
| scripts/lint.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import { spawnSync } from 'node:child_process';; 1499B; 1a71eca73251 |
| scripts/merge-gate.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: #!/usr/bin/env node; 1195B; 8b1d7c55bb5c |
| scripts/micro-verify.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import { spawn } from 'node:child_process';; 6759B; c3264bb83a8c |
| scripts/pack-contract.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import path from 'node:path';; 1731B; c65d9ba120ac |
| scripts/pack-preview.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import { loadAllManifests } from './lib/manifest.js';; 357B; f81d941bd021 |
| scripts/receipt.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L10: import { randomUUID } from 'node:crypto';; 12798B; bdeff71bf5e1 |
| scripts/release-evidence.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import { readdir, writeFile } from 'node:fs/promises';; 1865B; 812d3ef66291 |
| scripts/release-readiness.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L7: import { pathToFileURL } from 'node:url';; 2710B; a8adaf9474b7 |
| scripts/release-verification-metadata.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import { execFile } from 'node:child_process';; 1511B; 7b35a1d02fb9 |
| scripts/risk-evidence.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import { appendFile, readFile } from 'node:fs/promises';; 1345B; f0bb8ee27835 |
| scripts/roles-audit.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import path from 'node:path';; 365B; 8a2a97a9e00e |
| scripts/runtime-audit.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import path from 'node:path';; 263B; 2c206e82234b |
| scripts/skills-audit.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import path from 'node:path';; 506B; 9363c12ae731 |
| scripts/smoke-lifecycles.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import { execFile } from 'node:child_process';; 2724B; 4f03891aeaa4 |
| scripts/task-dag.js | 已实现 | DAG 校验 CLI 真实调用；不等同调度器 | L84: const analysis = validateTaskDag(await readDag(options));; 5057B; 9110f520de70 |
| scripts/tests-catalog.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L11: import { readFile, writeFile } from 'node:fs/promises';; 20162B; 8d5230d0e4f7 |
| scripts/validate.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import { validatePack } from './lib/pack-validation.js';; 1193B; d59287bfdfae |
| scripts/verification-plan.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import { appendFile } from 'node:fs/promises';; 3422B; d6c4091f3a17 |
| scripts/verification-queue.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import { execFile } from 'node:child_process';; 5520B; 1aea87c0958c |
| scripts/verify-focused.js | 部分实现 | 真实收集变更并构造 plan；未证明执行/复用闭环 | L97: const paths = await collectChangedPaths({ base });; 8630B; 27dc4ad70e51 |
| scripts/vibe-harness.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L2: import path from 'node:path';; 74803B; a2ccd9b0b43d |
| scripts/worktree.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L11: import { execFileSync } from 'node:child_process';; 14007B; 3c37351e9f0c |
| skills/core/api-and-interface-design/SKILL.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 1019B; ef795e31737d |
| skills/core/api-and-interface-design/agents/openai.yaml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: interface:; 307B; e95bcc10d41b |
| skills/core/api-and-interface-design/metadata.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {"id":"api-and-interface-design","kind":"core","entry":"SKILL.md","triggers":["api","接口","契约","模块边界","schema"],"outputs":["接口; 168B; bb24b1cca2b5 |
| skills/core/bug-finding/SKILL.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 1389B; 85d57d138bf7 |
| skills/core/bug-finding/agents/openai.yaml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: interface:; 302B; 0bfc7d4efa62 |
| skills/core/bug-finding/metadata.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {"id":"bug-finding","kind":"core","entry":"SKILL.md","triggers":["bug 审查","缺陷","业务逻辑","流程审查","状态机","数据一致性","接口请求","需求不符","功能缺; 265B; 700beadcbfb5 |
| skills/core/clarify-requirements/SKILL.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 2692B; a4031024ab4c |
| skills/core/clarify-requirements/agents/openai.yaml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: interface:; 306B; dac08072d17f |
| skills/core/clarify-requirements/metadata.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {"id":"clarify-requirements","kind":"core","entry":"SKILL.md","triggers":["产品决定","需求澄清","需求探索","需求采访","需求规格"],"outputs":["关键决; 215B; 61b044820b56 |
| skills/core/clarify-requirements/references/examples.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 澄清示例; 1397B; 4483d90d18b3 |
| skills/core/define-goal/SKILL.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 2074B; 08c7a117b9f1 |
| skills/core/define-goal/agents/openai.yaml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: interface:; 283B; d27409c716ee |
| skills/core/define-goal/metadata.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {"id":"define-goal","kind":"core","entry":"SKILL.md","triggers":["/goal","目标模式","目标书","自主目标","探索目标"],"outputs":["Goal Brief",; 191B; 5e1b4ef7289a |
| skills/core/define-goal/references/goal-contract.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Goal Brief 合同; 5113B; c1d0b024085f |
| skills/core/eval-driven-development/SKILL.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 3495B; edab78b0637d |
| skills/core/eval-driven-development/agents/openai.yaml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: interface:; 292B; 71ef4cc60baf |
| skills/core/eval-driven-development/metadata.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "id": "eval-driven-development",; 216B; ccf95c2e9fb5 |
| skills/core/frontend-design/SKILL.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 2885B; b253565ed68c |
| skills/core/frontend-design/agents/openai.yaml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: interface:; 283B; bcaff149752d |
| skills/core/frontend-design/metadata.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {"id":"frontend-design","kind":"full","entry":"SKILL.md","triggers":["frontend design","视觉方向","设计感","landing","brand","portfo; 255B; b7e4b480ee7f |
| skills/core/frontend-design/references/component-states.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 组件状态变体与契约; 3055B; 73d053ddeb15 |
| skills/core/frontend-design/references/content-a11y.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 内容与可访问性; 3776B; 1b82bd4939f9 |
| skills/core/frontend-design/references/design-modes.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 设计模式与共同门槛; 2219B; 371166a382c4 |
| skills/core/frontend-design/references/design-tokens.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 设计令牌骨架; 5769B; 401006de0ecb |
| skills/core/frontend-design/references/forms.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 表单工艺; 3921B; f33ee47d7018 |
| skills/core/frontend-design/references/interactions.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 交互工艺; 5266B; b83ff6d0e300 |
| skills/core/frontend-design/references/motion.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 动效工艺; 2969B; 811773014ebd |
| skills/core/frontend-design/references/performance.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 性能工艺; 2814B; 4b10f186b5ed |
| skills/core/frontend-design/references/visual-craft.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 视觉工艺; 3055B; 39fad47b0453 |
| skills/core/git-deliver/SKILL.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 2145B; 22e900f60c52 |
| skills/core/git-deliver/agents/openai.yaml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: interface:; 323B; 2e95744ec13b |
| skills/core/git-deliver/metadata.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {"id":"git-deliver","kind":"core","entry":"SKILL.md","triggers":["$git-deliver","使用 git-deliver Skill","use git-deliver Skill; 187B; 6b283a816978 |
| skills/core/runtime-cross-repo-rollout/SKILL.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 854B; f247ca1577e5 |
| skills/core/runtime-cross-repo-rollout/agents/openai.yaml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: interface:; 316B; a156833b9578 |
| skills/core/runtime-cross-repo-rollout/metadata.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {"id":"runtime-cross-repo-rollout","kind":"full","entry":"SKILL.md","triggers":["cross repo","end-to-end","真实接口"],"outputs":[; 160B; 88b5b1d23bb7 |
| skills/core/security-and-hardening/SKILL.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 837B; f34c4cdc167d |
| skills/core/security-and-hardening/agents/openai.yaml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: interface:; 293B; bd13a4180a8b |
| skills/core/security-and-hardening/metadata.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {"id":"security-and-hardening","kind":"core","entry":"SKILL.md","triggers":["security","auth","untrusted input","敏感数据"],"outp; 166B; 4ed37df04175 |
| skills/core/stale-cleanup/SKILL.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 2268B; 05e35328664e |
| skills/core/stale-cleanup/agents/openai.yaml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: interface:; 351B; 9962d1ee3a6b |
| skills/core/stale-cleanup/metadata.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {"id":"stale-cleanup","kind":"core","entry":"SKILL.md","triggers":["死代码","无用引用","过期文档","过期资源","孤儿资产","陈旧记忆","过期索引","清理死代码"],"; 264B; 984493fd8b01 |
| skills/core/stale-cleanup/references/asset-classes.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 六类过期资产判定细则; 4242B; 44098284863d |
| skills/core/systematic-debugging/SKILL.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 1083B; ba026c6a9d1c |
| skills/core/systematic-debugging/agents/openai.yaml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: interface:; 302B; 951e312d316a |
| skills/core/systematic-debugging/find-polluter.sh | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: #!/usr/bin/env bash; 2259B; 9862ee21b609 |
| skills/core/systematic-debugging/metadata.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {"id":"systematic-debugging","kind":"core","entry":"SKILL.md","triggers":["测试失败","非预期行为","构建失败","报错","根因未知","复现失败"],"outputs"; 191B; b2d21d358c3e |
| skills/core/task-decomposition/SKILL.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 888B; 468729cb9437 |
| skills/core/task-decomposition/agents/openai.yaml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: interface:; 316B; 9f62b389dd0e |
| skills/core/task-decomposition/metadata.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {"id":"task-decomposition","kind":"core","entry":"SKILL.md","triggers":["任务拆分","任务拆解","拆分计划","Task DAG","子任务规划","节点执行提示词"],"o; 250B; 19ed7231b484 |
| skills/core/task-decomposition/references/task-decomposition-guide.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Task Decomposition Guide; 13227B; 72966d8cc090 |
| skills/integrations/agentmemory/SKILL.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 2617B; b419c874a3a3 |
| skills/integrations/agentmemory/metadata.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {"id":"agentmemory","kind":"integration","optional":true}; 59B; cc6a6c682ccc |
| skills/integrations/agentmemory/references/audit.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Agentmemory 审计; 1670B; 6cc4b443c531 |
| skills/integrations/agentmemory/references/forget.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Agentmemory 遗忘; 588B; 34724233cc4e |
| skills/integrations/agentmemory/references/handoff.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Agentmemory 恢复; 1708B; 908b41393689 |
| skills/integrations/agentmemory/references/recall.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Agentmemory 检索; 448B; d2eff75b75e9 |
| skills/integrations/agentmemory/references/recap.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Agentmemory 汇总; 519B; e094d00e89b5 |
| skills/integrations/agentmemory/references/remember.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Agentmemory 保存; 535B; b04cfc3842e4 |
| skills/integrations/agentmemory/references/session-history.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Agentmemory Session 历史; 403B; 9a67f2487e4a |
| skills/integrations/browser-verification/SKILL.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 3717B; 246f843d820a |
| skills/integrations/browser-verification/metadata.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {"id":"browser-verification","kind":"integration","optional":true}; 68B; b63331d15e5c |
| skills/integrations/browser-verification/references/cli.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Playwright CLI 参考; 2422B; 9305c78cf52d |
| skills/integrations/linear-workflow/SKILL.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 9267B; 18ffd1f6b3e0 |
| skills/integrations/linear-workflow/metadata.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: {"id":"linear-workflow","kind":"integration","optional":true}; 61B; 3b56048df349 |
| skills/integrations/linear-workflow/references/ai-coding-task.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # AI 编码任务（AI Coding Task）; 4945B; cc0a4623e46d |
| skills/integrations/linear-workflow/references/dag-parent.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Linear DAG 聚合根（DAG Parent）; 4509B; ad47d2d2826e |
| skills/integrations/linear-workflow/references/execution-receipt.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Linear 执行回执（Execution Receipt）; 5849B; 5ce03cf32a6b |
| skills/integrations/linear-workflow/references/release-issue.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Linear 发布 Issue（Release Issue）; 2327B; d785ba8a3542 |
| skills/integrations/linear-workflow/references/triage-template.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Linear Triage 录入（Triage Intake）; 2520B; 03c8edfa5c04 |
| skills/integrations/linear-workflow/references/workspace-setup.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Linear Workspace 配置清单; 8803B; 0645ea85d991 |
| templates/adr/adr-template.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: ---; 1216B; c45b7f0657ab |
| templates/agents-index.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # .agents/ 目录说明; 1855B; 8d89a58aa729 |
| templates/delivery.en-US.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Delivery record; 1169B; d576cd351bfa |
| templates/delivery.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 交付记录; 1196B; 37d67215bf53 |
| templates/find-question.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 跨层一致性审查（find-question）; 11059B; b91dd4b2547a |
| templates/finding-report.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # <主题> 审查报告; 2304B; bdba975fecbe |
| templates/memory/ARCHITECTURE.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 架构; 83B; 69471938ac02 |
| templates/memory/DECISIONS.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 决策索引; 1099B; 72b4862d05d9 |
| templates/memory/FAILURE_LEARNINGS.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 失败经验; 164B; 2abe08751026 |
| templates/memory/IMPROVEMENTS.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 120B; 3482983abe8f |
| templates/memory/KNOWN_BUGS.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 已知缺陷; 98B; 94d50bc48b42 |
| templates/memory/PROJECT_STATE.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 项目状态; 505B; 7ad4b5ad7f2d |
| templates/memory/TECH_DEBT.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 技术债; 332B; d38cca70952d |
| templates/plan.en-US.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # <Task ID> <Title>; 3171B; 99f77064184e |
| templates/plan.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # <任务编号> <标题>; 2980B; c830b58b3cb6 |
| templates/task.en-US.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # <Task ID> <Title>; 3458B; 3e300c9e20b7 |
| templates/task.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # <任务编号> <标题>; 3287B; 82fcfe78db3a |
| templates/workflow.en-US.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # Full lifecycle workflow; 6054B; e343a754c1dc |
| templates/workflow.md | 仅规范定义 | 正文为说明/规则/提示/模板/历史记录；不证明执行 | L1: # 全生命周期工作流; 5061B; 93b5ea00a50f |
| tests/cases.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L2:   "schemaVersion": 1,; 569254B; d04c8550e6ee |
| tests/cases.schema.json | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L4:   "description": "本仓库自用的逐用例台账；tests/ 不进入 pack，因此该文件不随安装分发。",; 2298B; 141c0f0094fd |
| tests/component/adr-validation.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 5765B; 13952532ec0e |
| tests/component/backup-retention.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import '../helpers/offline-tools.js';; 5674B; 05fb25d0c9e6 |
| tests/component/check-fast-tier-alignment.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 4189B; 628898f5f81d |
| tests/component/ci-gates.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 4677B; a1ab6b013da9 |
| tests/component/codex-adapter.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 3638B; 820b2bf7df1c |
| tests/component/docs-projection.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 5859B; 349ec4e9f0c8 |
| tests/component/documentation.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 11117B; d8c24178e5d7 |
| tests/component/eval-assets.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 3110B; 13fdce6a2797 |
| tests/component/eval-behavioral.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 10585B; 4033812e6e2a |
| tests/component/eval-contract.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 38535B; b1279de5d005 |
| tests/component/eval-judge.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 11924B; cd9b24e04d5f |
| tests/component/eval-projection.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 4480B; 321cf34726c9 |
| tests/component/eval-topology.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 4698B; 74175bc7e1f1 |
| tests/component/harness-evals-core.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 22165B; f5ce6346506c |
| tests/component/harness-evals-external.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 8969B; 15b7f2531536 |
| tests/component/harness-evals-scenarios.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 13209B; 5482b5e941f7 |
| tests/component/hook-read-only-classification.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 27744B; 902e40adbbb4 |
| tests/component/install-preset.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 7553B; 1197b1c99f91 |
| tests/component/install-state-schema.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import '../helpers/offline-tools.js';; 9461B; 9fb018f773d6 |
| tests/component/manifest-schema.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 26713B; a7a59fffa2e2 |
| tests/component/memory-entry.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 4162B; 24bd04b05b21 |
| tests/component/memory-freshness.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 2875B; 9bf4e16e1ffb |
| tests/component/micro-receipt.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 1428B; b2adb3a302f6 |
| tests/component/pack-contract.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 1749B; 16eb85a431f5 |
| tests/component/product-identity.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 3494B; 2e14d64460b3 |
| tests/component/red-zone-consistency.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 6802B; 5d76cc4fbee2 |
| tests/component/role-preset-consistency.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 9260B; 9aafd6cf70ed |
| tests/component/rule-skill-parity.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 3664B; a54a74a26c6f |
| tests/component/rules-depth.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 13830B; c7ce5f4c2457 |
| tests/component/rules-index.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 13187B; e5f317d2653c |
| tests/component/runtime-audit.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 4793B; a98a7430ccaf |
| tests/component/schema-validation.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 12194B; e83e6fc31163 |
| tests/component/self-install-check.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import '../helpers/offline-tools.js';; 7550B; faffa0dfafd8 |
| tests/component/tests-catalog.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 11913B; a95f7b46e109 |
| tests/e2e/cli-output.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import '../helpers/offline-tools.js';; 6632B; ce67c40e2765 |
| tests/e2e/hook-installation.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import '../helpers/offline-tools.js';; 14906B; f6ec1dec4b94 |
| tests/e2e/installer-lifecycle.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import '../helpers/offline-tools.js';; 22801B; 84adad87edf9 |
| tests/e2e/playwright-cli-integration.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import '../helpers/offline-tools.js';; 12809B; 00abd568c564 |
| tests/e2e/uninstall.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 8300B; 15a6a58d1316 |
| tests/e2e/vibe-harness-cli.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 2397B; fa443ca58356 |
| tests/fixtures/ast-grep/rule-tests/no-console-log-test.yml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: id: no-console-log; 112B; 11637492656d |
| tests/fixtures/ast-grep/rule-tests/snapshots/no-console-log-snapshot.yml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: id: no-console-log; 280B; f7c2f0f82947 |
| tests/fixtures/ast-grep/rules/no-console-log.yml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: id: no-console-log; 132B; 28e78bd1b82d |
| tests/fixtures/ast-grep/sgconfig.yml | 仅规范定义 | 声明、配置、数据或评测工件；消费者/宿主另验 | L1: ruleDirs:; 84B; 1b6f04a49de5 |
| tests/fixtures/ast-grep/src/sample.ts | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: export function greet(name: string) {; 83B; c22843f6a1b6 |
| tests/helpers/docs-fixture.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L5: import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';; 5396B; cb3862d31cd8 |
| tests/helpers/governed-docs.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L14: import assert from 'node:assert/strict';; 2945B; 518685c4ab62 |
| tests/helpers/offline-tools.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import { tmpdir } from 'node:os';; 429B; cc02b06a56a2 |
| tests/integration/adr-scaffold.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 4314B; 7f470d100d28 |
| tests/integration/autonomy-eval.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 4241B; bdab07e10b24 |
| tests/integration/cleanup-audit.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 10742B; 37c622a604ee |
| tests/integration/codebase-memory-mcp.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import '../helpers/offline-tools.js';; 20221B; 5284f6d1be37 |
| tests/integration/enforcement-gate.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import '../helpers/offline-tools.js';; 19757B; 5d115dc198c7 |
| tests/integration/envelope-records.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 17771B; 1478b15382f1 |
| tests/integration/eval-ci.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 14259B; 4d930cda05f2 |
| tests/integration/eval-cli.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 16754B; afdcb8c5f98a |
| tests/integration/eval-execution.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 15121B; 4e012eee0ea3 |
| tests/integration/eval-runner.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 72411B; 7e01fed131ea |
| tests/integration/harness-evals-cli.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 5786B; 98d007f153ae |
| tests/integration/hook-bootstrap.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 9818B; 442977ce0ad4 |
| tests/integration/hook-runtime.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 66375B; f1c406a46561 |
| tests/integration/install-dry-run.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import '../helpers/offline-tools.js';; 14414B; 60e8be292436 |
| tests/integration/installed-micro.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 4785B; 548f27759d8f |
| tests/integration/linear-workflow.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 20513B; c3bdb2bb4ee5 |
| tests/integration/lint-discovery.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 3409B; 679e49eac65b |
| tests/integration/module-selection.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 27518B; 8b4c28baee85 |
| tests/integration/mvp-spec.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import '../helpers/offline-tools.js';; 27242B; ac2270f45cba |
| tests/integration/opencode-adapter.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 11628B; e86a6612168e |
| tests/integration/project-audit.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 13119B; 2e97e7618c75 |
| tests/integration/project-baseline.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import '../helpers/offline-tools.js';; 16755B; d4af55e7e876 |
| tests/integration/project-commands.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 11743B; 33dfba919d27 |
| tests/integration/project-evaluation-online.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 7891B; 78bb9d9376de |
| tests/integration/project-evaluation.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 5163B; 0f581f0d21a7 |
| tests/integration/project-file-edit-command.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 7922B; 4c75f954c317 |
| tests/integration/project-profile.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import '../helpers/offline-tools.js';; 30260B; 094b55c91722 |
| tests/integration/project-task-command.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 58623B; 2cb3bdf3214b |
| tests/integration/project-verification.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 38436B; fe9c9706f31c |
| tests/integration/project-worktree-command.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 50720B; 3e1bbb0782ff |
| tests/integration/receipt-records.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 17224B; 9c015253a1c1 |
| tests/integration/release-readiness.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 6329B; 965c1f8af92c |
| tests/integration/role-permission-enforcement.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 9206B; bf06b5c2fd3e |
| tests/integration/role-projection.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 31183B; 92fe0f4772b0 |
| tests/integration/runtime-diagnostics.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 19002B; 7597b88fd432 |
| tests/integration/safety-posture.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import '../helpers/offline-tools.js';; 5509B; e9f58c48c5b5 |
| tests/integration/skill-closure.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 10307B; e042d110910b |
| tests/integration/task-dag.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 12196B; 9695d96d55d9 |
| tests/integration/tooling-modules.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 49534B; 2ada8d474b67 |
| tests/integration/transaction-recovery.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 5455B; e2aa4bdc1cb9 |
| tests/integration/verify-focused.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 12881B; c202b28e8582 |
| tests/integration/worktree-audit.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 23184B; 0b37bc662a63 |
| tests/matrix/cross-platform-adapters.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import '../helpers/offline-tools.js';; 44584B; 974525f55060 |
| tests/matrix/installation-baseline.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 7608B; 431f3b8970e6 |
| tests/matrix/legacy-unsupported.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 1315B; ef752ad124d0 |
| tests/matrix/target-validation.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import '../helpers/offline-tools.js';; 13701B; c14fa7238e70 |
| tests/matrix/tool-provisioning.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 82048B; 17d2c4dea920 |
| tests/unit/clarification-metrics.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 2956B; e3665ed39b63 |
| tests/unit/eval-compare.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 3977B; ec87764318f6 |
| tests/unit/eval-governance-metrics.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 29776B; 4674c4d65921 |
| tests/unit/eval-health.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 1614B; f09c1fcbe940 |
| tests/unit/eval-report.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 8828B; 13251fe4f0c1 |
| tests/unit/eval-runtime-config.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 10129B; c01e21bb72a4 |
| tests/unit/eval-scoring.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 18038B; ebcf2b8f7a17 |
| tests/unit/eval-split-parity.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 3246B; 7ad184c406fd |
| tests/unit/execution-observer-parity.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 2211B; 1da9d7acce25 |
| tests/unit/execution-simplification.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 8777B; ec506332ac07 |
| tests/unit/goal-definition-metrics.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 2903B; 402778cf19be |
| tests/unit/managed-json-config.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import '../helpers/offline-tools.js';; 3871B; 44af56556e35 |
| tests/unit/micro-verification.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import test from 'node:test';; 1245B; fa014dc02dc4 |
| tests/unit/redaction.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 1870B; 4d1e673241ca |
| tests/unit/release-evidence.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 2206B; f603fa37a559 |
| tests/unit/risk-evidence.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 4409B; aff9cb87da1a |
| tests/unit/safe-json.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 1504B; f358ac2c96d8 |
| tests/unit/temp-cleanup.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 546B; f9db0c4d0160 |
| tests/unit/test-coverage-map.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 3133B; 70466ad214d5 |
| tests/unit/test-enumeration.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 4838B; 04f29e05e133 |
| tests/unit/validation-tiers.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 11095B; 468f82b7042b |
| tests/unit/verification-contract.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 1051B; 5c07f25b119b |
| tests/unit/verification-plan.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 15373B; b0722089a071 |
| tests/unit/verification-queue.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 1838B; 63e866cfc84b |
| tests/unit/worktree-ports.test.js | 无法确认 | 已枚举；未逐函数语义审查，不从文件名推断能力 | L1: import assert from 'node:assert/strict';; 5125B; db78a39b5c14 |
| vibe-harness.config.json | 部分实现 | 配置有验证层及 onlineRunner=null；代码消费者已定位 | L64: "onlineRunner": null,; 2079B; aa954561aaac |
