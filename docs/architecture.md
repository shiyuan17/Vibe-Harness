# Vibe-Harness 架构说明

Vibe-Harness 是跨平台、项目级的 AI coding 资产包。它使用 Node.js ESM、JSON manifests、Markdown 规则和事务性安装器，并把一个项目视为唯一的运行时与状态边界。

## 组件

- rules 和 templates 提供共享规则、模板及 memory 文档源。
- skills 提供由宿主按 description 直接选择的领域 Skills。
- runtime 提供 Hooks、Eval 和显式选择的项目内工具。
- adapters 提供 Codex、Claude Code、Gemini CLI、Cursor、Qoder、ZCode、Antigravity 和 OpenCode 的项目入口与路径投影。
- scripts 提供 CLI、planner、事务、状态迁移、验证、doctor、diff 和 provisioning。
- manifests 和 schemas 定义 profiles、adapter capability、项目配置与 install-state 契约。

## 多宿主安装模型

项目配置使用唯一、非空的 targets 数组。profile、modules、plugins、runtime、memory、Eval 和索引均为项目级设置，不提供宿主级覆盖。

安装计划由一份 shared plan 和多份 adapter projection plan 组成：

1. shared plan 只生成一次公共规则、runtime、memory、Eval 和工具 provisioning。
2. 每个 projection plan 只生成该宿主的指令、原生 Skills、MCP 与 Hook 配置。
3. 相同路径和相同内容合并 owners；不同内容竞争同一路径时在 dry-run 阶段确定性报 conflict。
4. Codex、Cursor、Qoder、ZCode 和 OpenCode 合并到 AGENTS.md 的唯一宿主中立受管块；Claude、Gemini 和 Antigravity 使用各自入口。
5. 工具 probe、provisioning 和 codebase-memory 根索引按项目根去重一次。

install-state stateVersion 5 使用 targets 取代 adapter。files、generatedFiles、generatedDirectories 和 retiredFiles 记录 owners，取值为 shared 或 adapter:id。旧 state v4 可读，并在标准升级事务中迁移。

## 生命周期与事务

- init 创建配置且不覆盖已有配置。
- install、upgrade、validate、doctor 和 diff 默认处理配置中的全部 targets。
- --target 只选择配置或状态中仍存在的一个宿主，不追加目标。
- 目标级 uninstall 删除一个投影并更新配置和状态；最后一个目标与共享资产必须通过 --all-targets 删除。
- 从配置手工删除 target 只产生 stale projection，upgrade 不隐式卸载。
- install 和 upgrade 是跨宿主事务；任何投影失败都不提交文件、配置迁移或新 state。
- rollback 恢复上一次完整事务，不保留半迁移状态。

安装器使用项目内锁、preimage 和原子 state commit。路径通过 realpath 与逐段检查阻止 symlink、junction 或 reparse-point 越界。

## Adapter 投影

- Codex：AGENTS.md、.agents/skills 和 .codex 配置。
- Claude Code：CLAUDE.md 与 .claude/skills；执行类能力为 preview。
- Gemini CLI：GEMINI.md 与 .gemini/skills；执行类能力为 preview。
- Cursor：AGENTS.md、.cursor/skills、.cursor/hooks.json 和 .cursor/mcp.json。
- Qoder：AGENTS.md、.qoder/skills、.qoder/settings.json 和 .mcp.json。
- ZCode：AGENTS.md 与 .zcode/config.json；不猜测项目 Skill 路径，也不写全局目录。
- Antigravity：.agents/rules/vibe-harness.md、.agents/skills 和 .agents/mcp_config.json 为 stable；Hooks、sandbox 和 memory 集成为 preview。
- OpenCode：AGENTS.md、.opencode/skills 和项目根 opencode.json 或 opencode.jsonc；instructions、Skills、policy 和 MCP 为 stable，sandbox 和 memory 为 preview，Hooks、plugin 和 goals 为 unsupported。

adapter capability 使用 stable、preview 和 unsupported 描述各产品表面。validate、doctor 和 diff 提供项目汇总及逐宿主结果；未选宿主标为 skipped，内容漂移标为 conflict，配置删除但仍安装的宿主标为 stale projection。

## 结构化配置与安全

MCP 和 Hook JSON 通过结构化路径合并。未冲突的用户项原样保留；同名用户项默认阻止写入，只有 --force 可以接管。所有宿主配置仍是 red zone，真实写入额外要求 --confirm-red-zone。

OpenCode 配置使用 jsonc-parser 的结构化 edits，只管理 mcp.vibe-harness-*。已有 JSONC 的注释、尾逗号、格式和用户键保持不变；opencode.json 与 opencode.jsonc 同时存在、语法错误或 mcp 非对象时确定性拒绝，--force 不绕过这些错误。OpenCode 本次不安装 .opencode/plugins，因此运行时安全姿态明确降级，不描述为与 Codex Hook 等价。

Antigravity Hook adapter 解析 toolCall.name、toolCall.args、workspacePaths 等 camelCase 字段，归一为内部 policy context，再映射为 allow、deny、ask 或 force_ask。无效输入、异常和无法判定的高风险操作 fail-closed。达到稳定前，preview 能力不描述为与 Codex 等价。

doctor 会搜索项目中的其他 .vibe-harness/install-state.json，并排除依赖、VCS、缓存和生成目录。发现嵌套旧安装时仅报告根路径、版本、重复 runtime 或索引及迁移命令，不自动删除目录或用户文件。
