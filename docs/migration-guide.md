# LoopEngine 迁移指南

本指南用于将项目内的 AI coding governance 抽取到 LoopEngine，同时避免带入业务专属状态。

## 1. 盘点源项目

- 将源文件分类为治理内核、专项 rules、templates、skills，或仅用于示例的项目专属内容；独立 workflow 文档应收敛到治理内核或对应 skill。
- 排除当前 task 状态、memory 快照、本地 backlog 数据、具体端口、后端仓库名和业务契约。
- 将项目专属值记录在 `loopengine.config.json` 中，不要硬编码到 core 文件。
- 对照 `docs/inventory/source-rules-mapping.md` 判断每个源规则是通用化、摘要化、仅示例，还是排除业务内容。
- 优先抽取三类可复用协议：会话启动、会话收尾、恢复型 handoff；不要把它们混在一个大型 `AGENTS.md` 中。

## 2. 初始化目标项目

```bash
pnpm loopengine init --project ../target-project
```

检查生成的 `loopengine.config.json`，并按目标项目调整：

- `projectName`
- `packageManager`
- `validationCommands`
- `riskZones`
- 可选的 `crossRepo`

## 3. 选择并预览 Adapter

```bash
pnpm loopengine install --project ../target-project --target codex --profile core --dry-run
```

将 `codex` 替换为 `claude` 或 `gemini` 可安装对应项目级入口。Codex 支持 `minimal/core/full`；Claude/Gemini 支持 `minimal/core/docs-only`，不提供伪兼容 MCP/hooks。Dry-run 默认只输出相对目标、动作、hash、字节数和冲突摘要；需要完整渲染正文时增加 `--verbose`。该命令不得创建入口文件。

## 4. 执行安装

```bash
pnpm loopengine install --project ../target-project --target codex --profile core --write
```

LoopEngine 会在项目根目录管理 adapter 入口：Codex 为 `AGENTS.md`，Claude 为 `CLAUDE.md`，Gemini 为 `GEMINI.md`；Skills 分别写入 `.agents/skills/`、`.claude/skills/`、`.gemini/skills/`。已有入口只追加或更新 `<!-- LOOPENGINE:START -->` / `<!-- LOOPENGINE:END -->` 受管块，块外内容保持不变。其他冲突文件仍需显式 `--force`，覆盖前写入项目内备份。

## 5. 校验

```bash
pnpm loopengine validate --project ../target-project
pnpm test
pnpm run validate
git diff --check
```

如果生成内容缺少必需红线、目标文件尚未安装或已被改动，或包含禁止出现的源项目专属标识，校验会失败。

## Profile 选择

- `minimal`：启动红线、会话开始/结束协议、红区确认、验证证据、Skill 路由 fallback 和交付 Packet 指引。
- `core`：`minimal` 加上中文任务 runtime/schema、工程专项规则、`using-loopengine` 和常规 bundled skills。
- `full`：`core` 加上 release、Pencil、troubleshooting、对抗审查和 loop skills。

## Agentmemory Skills

`full` / `codex-internal` 只安装 `.agents/skills/agentmemory/` 一个 skill。`handoff`、`recall`、`remember`、`forget`、`recap`、`session-history` 已收敛为该目录下按需读取的 references，不再占用顶层 skill ID；提交历史和提交上下文也由同一入口处理。目标项目没有记忆工具时，Agent 必须说明不可用并回退到本地 handoff 或任务 intake。`core` 不包含 agentmemory MCP 安装面。

从旧版 `full` 升级时先 dry-run 审查六个 `retire` 动作。MVP 生命周期使用：

```bash
pnpm loopengine install --project ../target-project --target codex --profile full --dry-run --upgrade
pnpm loopengine install --project ../target-project --target codex --profile full --write --upgrade --confirm-red-zone
```

legacy/internal 生命周期使用：

```bash
pnpm loopengine install --target ../target-project --profile codex-internal --dry-run --upgrade
pnpm loopengine install --target ../target-project --profile codex-internal --apply --upgrade --confirm-red-zone
```

只有旧 `.loopengine/install-state.json` 明确记录且 hash 未变化的入口会被备份和删除。用户修改、未受管或已缺失的旧入口不会被自动删除；真实退役记录写入 `retiredFiles`，可由现有 `rollback` 生命周期恢复。

## v0.3 升级

- Profile 文件集合有意调整：`core` 不再包含 `rules-full`、`skills-full` 或 memory/full 专属组；`manifests/profiles.json` 成为唯一能力真值。升级前应 dry-run 并审查移除项。
- install/validate/doctor 采用统一健康状态：ready 退出 0、invalid 退出 1、degraded 退出 2；自动化若接受能力降级需显式增加 `--allow-degraded`，但仍应读取 `status` 与 warnings。
- install state 新增 `adapter`。旧 schemaVersion 1 状态缺少该字段时迁移为 Codex，不重写未变化文件；upgrade/uninstall 的 adapter 必须与原安装一致。
- Claude/Gemini adapter 只提供项目级原生 instructions/skills，并支持 `minimal/core/docs-only`；请求 full 会明确失败。legacy/internal 仍只接受 Codex 路径语义。

- 所有 profile 从 `minimal` 起新增受管文件 `docs/rules/AGENT_SKILL_ROUTING.md`；它是 Skill 选择与降级政策真值，`using-loopengine` 仍是安装 Skills 后的执行入口。升级前使用 `diff` 检查目标项目是否已有同名文件；默认拒绝覆盖，确认替换时使用 `--force` 生成备份，失败后沿用现有 `rollback`。
- `core` 新增中文 Markdown 任务校验器、完整流程控制 schema 与 `.agents/skills/using-loopengine/`。
- `full` 新增 `docs/memory/` 六类 durable governance 模板、task/backlog 语义校验和 Pencil `.pen/.png` 配对检查。
- `validationCommands.lint` 与 `typecheck` 可为 `null`；未检测到真实脚本时不会生成虚假的 pnpm 命令。已有非空字符串配置继续兼容。
- `governance.mode` 可为 `basic`、`full` 或 `off`；未配置的 v0.2 项目按 profile 推导。
- `hooks.mode` 可为 `off`、`observe`、`guarded` 或 `strict`，默认 `guarded`；`hooks.completionGate` 可为 `off`、`advisory` 或 `blocking`，默认 `advisory`。
- v0.2 snake_case hook 占位配置已替换为 Codex 官方 PascalCase 事件。升级前用 `diff` 审查 `.codex/hooks.json` 和 `.agents/loopengine/hooks/`，真实写入仍需红区确认。
- `.githooks/` 只提供版本化脚本；LoopEngine 不自动修改 `core.hooksPath`。需要启用时人工执行 `git config --local core.hooksPath .githooks`。
- 升级前使用 `diff` 审查新增文件，再运行 `install --upgrade`。用户修改过的 managed 文件仍默认拒绝覆盖；需要强制更新时先备份，失败可使用 `rollback`。
- `.agents/memory/` 是会话辅助记忆；`docs/memory/` 是 durable 项目治理真值，两者不得互相替代。
- Agentmemory 的六个薄入口已合并为单一 skill；`install --upgrade` 通过显式 `retiredEntries` 安全退役未修改的旧顶层入口，并允许 rollback 恢复。

## Skills 闭包升级

- Skill manifest 新增 `kind`、`requiresSkills`、`optionalSkills`、`requiresTools` 和可选 `canonicalId`。自定义 manifest 条目必须补齐这些字段。
- core 新增 `executing-plans`、结构化追问、UI、安全、精简、文档、Git 交付及调试/浏览器兼容入口；full 新增三类设计入口、对抗审查和跨仓 rollout。
- 薄包装和兼容 ID 已删除；调试使用 `systematic-debugging`，浏览器验证使用 `browser-verification`，规则类检查使用对应 `docs/rules/*.md` 或 canonical skill。
- `full` / `codex-internal` 现在捆绑固定版本的 codebase-memory、Playwright CLI、Open Code Review 和 Agentmemory stdio MCP runtime，并在真实安装后初始化。`core` 仍只安装懒加载 Playwright bootstrap。
- 新增 `.codex/config.toml` LoopEngine MCP 受管块；它与 `.codex/hooks.json` 一样属于红区，真实写入需要确认。同名非受管 MCP 表不会被覆盖，而是报告 degraded。
- OCR 凭据只从进程环境读取；缺失时状态为 `pending-config`。升级前先 dry-run 审查新增下载与项目磁盘占用。
- 升级前运行 `loopengine diff`；使用 `install --upgrade` 安装新增受管文件。用户修改过的文件仍需 `--force` 才会备份并替换，失败时使用现有 `rollback` 生命周期恢复。
- 使用 `pnpm skills:audit` 查看实时 inventory；pack validation 会阻止未知依赖、profile 越层、别名环、无回退 integration 和过长入口。
