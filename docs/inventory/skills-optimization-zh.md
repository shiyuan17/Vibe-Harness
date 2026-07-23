# 原生 Skills 极简化审计

本审计以 `manifests/skills.json` 和各 `SKILL.md` description 为运行时真值。`pnpm skills:audit` 校验清单、安装映射、无依赖链、静态预算、Codex metadata 与 profile 闭包。

## 默认集合

| Profile | 原生 Skill | 用途 |
| --- | --- | --- |
| core | `clarify-requirements` | 只处理仓库事实无法消除且改变结果的产品决定 |
| core | `systematic-debugging` | 未知根因的复现、定位与回归证明 |
| core | `eval-driven-development` | 规则、Skill、Prompt、Hook 和 adapter 等非确定性行为 |
| core | `security-and-hardening` | 信任边界、认证授权、敏感数据和外部动作 |
| full | `api-and-interface-design` | 有真实消费者的公共契约 |
| full | `frontend-design` | 视觉方向、响应式与交互体验 |
| full | `runtime-cross-repo-rollout` | 跨仓契约、顺序、集成证据与回滚 |

`browser-verification` 和 `agentmemory` 是显式集成能力，不计入七个原生 Skill，也不由默认 profile 安装。宿主按 description 原生选择，同一阶段默认只加载一个；Skill 不声明其他流程 Skill 为依赖。

## 下沉与退休

计划、测试原则、完成证据、普通 Review、多 Agent 和 Red Team 下沉到治理规则、宿主能力及 Runtime。Router、通用流程 Skill 和兼容别名全部退休；upgrade 只删除 install-state 跟踪且未修改的旧文件，用户修改版本保留并报告 `retained-user-modified`。

每个原生 `SKILL.md` 不超过 35 行，description 不超过 300 字符；七个正文合计不超过 250 行，名称与 description 合计不超过 900 字符。每个 Skill 默认只有入口与精简 `agents/openai.yaml`，最多两个一层按需资源；当前调试 Skill 仅保留 `find-polluter.sh`。

## 评测门禁

每个原生 Skill 配置八个触发、八个近邻不触发查询并重复三次。澄清另有二十个案例，记录关键决定覆盖率、无关问题、依赖顺序、阻塞轮次和实现问题违规；明确本地任务、安全审批和纯实现选择是关键负例。

`evals/skill-set-baseline.json` 将旧集合冻结到明确 Git revision，并固定 old/new/no-Skill 三组比较。当前初始名称与 description 从 1698 字符降至 852 字符（约 49.8%）；实际加载 Token、成功率和成本仍必须由同环境在线配对运行决定，静态预算不能替代发布门禁。
