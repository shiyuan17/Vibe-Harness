# Cognis 架构说明

Cognis 是跨平台的项目级 AI coding 资产包。运行时使用 Node.js ESM、JSON manifests、Markdown 规则和事务性安装器。

## 组件

- `rules/`：执行内核、安全边界和工程专项规则的模板源（部分含 `{{}}` 占位符）。安装器按 `adapters/*/install-map.json` 将其渲染为目标项目的 `docs/rules/`；本仓库 `docs/rules/` 即 Cognis 安装到自身时的渲染产物。无占位符的规则两处字节相同；含占位符的 `project-specific-rules.md` 等仅模板在 `rules/`。
- `templates/`：可选的人读任务与交付简表，以及 memory 文档模板。
- `skills/`：八个由宿主按 description 直接选择的领域 Skills；不包含流程 Router。
- `runtime/hooks/`：Codex `PreToolUse` 与 `PermissionRequest` 安全策略，以及可选 RTK 路由。
- `runtime/evals/`：离线 Eval runtime 和 full profile 的在线 runner。
- `runtime/tools/`：仅由显式 `--plugin` 安装的项目内工具入口。
- `scripts/`：CLI、安装器、安装一致性校验、项目验证、baseline、Eval 和工具 provisioning。
- `adapters/`：Codex、Claude Code、Gemini CLI 的项目入口和目标路径转换。
- `manifests/`、`schemas/`：profiles、能力目录、安装映射和数据合同。

运行时仅保留安装、项目验证、Eval、显式工具和安全 Hook 能力。

## 执行路径

Agent 使用 `获取事实 -> 直接执行 -> 聚焦验证 -> 简洁交付`。快速、轻量、完整只影响安全审批和验证范围，不形成机器状态。

`cognis validate --project <path>` 只比较安装计划、受管文件和 install-state。`cognis verify --project <path>` 按 `lint -> typecheck -> test -> eval` 执行已配置命令。`doctor` 只报告安装、工具、Git Hook 和事务健康。

## 安装生命周期

1. `init --project` 创建配置，不覆盖已有配置。
2. `install --dry-run` 生成计划；`--write` 才事务性写入。
3. Codex full 写入 `.codex/hooks.json` 需要 `--confirm-red-zone`。
4. `--upgrade --write` 退役旧 state 中存在但新计划不再包含的未修改受管文件；已修改文件保留并报告冲突。
5. 升级精确清理过期运行时状态，不删除整个 `.cognis`。
6. `rollback`、`recover`、`uninstall` 的真实修改同样需要 `--write`。

安装器使用项目内锁、preimage 和原子 state commit；路径通过 realpath 与逐段检查阻止 symlink、junction 或 reparse-point 越界。

## Profiles

- `minimal`：平台说明、安全边界、Git/Test 规则和可选模板。
- `core`：增加通用工程规则、五个领域 Skills 和离线 Eval。
- `full`：增加三个领域 Skills、在线 Eval 和 Codex 安全 Hook。
- `docs-only`：规则、模板和 schemas，不安装可执行 runtime、Skills、MCP 或 Hook。

工具和 memory 不由 profile 默认安装，只通过显式插件选择。

## Adapter

- Codex：`AGENTS.md`、`.agents/skills/` 和项目 `.codex/` 安全面。
- Claude Code：`CLAUDE.md`、`.claude/skills/`；preview 能力需 `--allow-preview`。
- Gemini CLI：`GEMINI.md`、`.gemini/skills/`；preview 能力需 `--allow-preview`。

adapter capability 使用 `unsupported/preview/stable` 描述 instructions、skills、hooks、policy、MCP、sandbox、memory、plugin 和 goals。

## 安全模型

- 不写全局 Agent 配置或 `.git/config`。
- 未使用 `--force` 时不覆盖已有文件。
- 共享说明文件和 MCP 配置只更新 Cognis 受管块。
- Hook 先执行安全策略；红区、生产、权限、凭据、外部写入和不可逆操作仍由宿主进行人工审批。
- 项目状态不保存源码、凭据、完整命令输出或用户绝对路径。
