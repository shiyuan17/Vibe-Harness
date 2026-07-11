# LoopEngine 迁移指南

本指南用于将项目内的 AI coding governance 抽取到 LoopEngine，同时避免带入业务专属状态。

## 1. 盘点源项目

- 将源文件分类为可复用 rules、templates、skills、workflows，或仅用于示例的项目专属内容。
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

## 3. 预览 Codex 安装

```bash
pnpm loopengine install --project ../target-project --target codex --profile core --dry-run
```

Dry-run 输出会包含目标路径、动作列表和渲染后的预览内容。该命令不得创建 `AGENTS.md`。

## 4. 执行安装

```bash
pnpm loopengine install --project ../target-project --target codex --profile core --write
```

LoopEngine 会在项目根目录管理最小入口 `AGENTS.md`，其余治理资产写入 `docs/`、`.agents/skills/` 等命名空间目录，默认不会改 `package.json`、`.npmrc`、`pnpm-workspace.yaml` 等 Node / pnpm 元文件。如果目标项目已经存在 `AGENTS.md`，LoopEngine 默认只追加或更新 `<!-- LOOPENGINE:START -->` / `<!-- LOOPENGINE:END -->` 包围的受管块，并保留其余本地内容；其他受管理文件如已存在，确认需要替换时显式添加 `--force`，LoopEngine 会先在 `.loopengine/backups/` 下写入备份，再替换目标文件。

## 5. 校验

```bash
pnpm loopengine validate --project ../target-project
pnpm test
pnpm run validate
git diff --check
```

如果生成内容缺少必需红线、目标文件尚未安装或已被改动，或包含禁止出现的源项目专属标识，校验会失败。

## Profile 选择

- `minimal`：启动红线、会话开始/结束协议、红区确认、验证证据和交付 Packet 指引。
- `core`：`minimal` 加上生命周期、coding、frontend、API、AI collaboration、project directory、workflows、templates 和完整 bundled skills。
- `full`：`core` 加上 release、Pencil、task-management、troubleshooting、review 和 loop opt-in 相关规则。

## Agentmemory Skills

源项目中的 `handoff`、`recall`、`remember`、`forget`、`recap`、`session-history`、`commit-history`、`commit-context` 会作为 bundled memory 安装面进入 `core` / `full` / `codex-internal`。这些 skill 只描述通用 agentmemory 行为；目标项目没有记忆工具时，Agent 必须说明不可用并回退到本地 handoff 或任务 intake。

## v0.3 升级

- `core` 新增 Review 规则、Review Packet、task-intake 规则与 `.agents/loopengine/governance/` 基础校验器。
- `full` 新增 `docs/memory/` 六类 durable governance 模板、task/backlog 语义校验和 Pencil `.pen/.png` 配对检查。
- `validationCommands.lint` 与 `typecheck` 可为 `null`；未检测到真实脚本时不会生成虚假的 pnpm 命令。已有非空字符串配置继续兼容。
- `governance.mode` 可为 `basic`、`full` 或 `off`；未配置的 v0.2 项目按 profile 推导。
- 升级前使用 `diff` 审查新增文件，再运行 `install --upgrade`。用户修改过的 managed 文件仍默认拒绝覆盖；需要强制更新时先备份，失败可使用 `rollback`。
- `.agents/memory/` 是会话辅助记忆；`docs/memory/` 是 durable 项目治理真值，两者不得互相替代。
