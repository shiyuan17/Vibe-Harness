# Cognis 迁移指南

Cognis（智序）是 LoopEngine 的新名称。本指南同时覆盖新项目接入和旧安装升级；历史文档、审计报告及发布记录中的旧名称保持原样。

## 1. 盘点源项目

- 将源文件分类为治理内核、专项 rules、templates、skills，或仅用于示例的项目专属内容。
- 排除当前 task 状态、memory 快照、本地 backlog、具体端口、仓库名和业务契约。
- 将项目专属值记录在 `cognis.config.json`，不要硬编码到通用核心资产。
- 对照 `docs/inventory/source-rules-mapping.md` 判断每个源规则应通用化、摘要化、仅作示例或排除。

## 2. 新项目接入

初始化只创建 Cognis 配置：

```bash
pnpm cognis init --project ../target-project
```

检查 `cognis.config.json` 中的 `projectName`、`validationCommands`、`riskZones` 和可选 `crossRepo`，然后先预览安装：

```bash
pnpm cognis install --project ../target-project --target codex --profile core --dry-run
```

将 `codex` 替换为 `claude` 或 `gemini` 可选择对应 adapter。Codex full 为 stable；Claude/Gemini full 为 preview，必须增加 `--allow-preview` 并审查缺失能力。确认计划后真实写入：

```bash
pnpm cognis install --project ../target-project --target codex --profile core --write
pnpm cognis validate --project ../target-project
pnpm cognis doctor --project ../target-project
```

新安装只生成 `cognis.config.json`、`.cognis/`、`.agents/cognis/`、`using-cognis` 和 `COGNIS:*` 受管标记。

## 3. 从 LoopEngine 升级

旧安装继续被识别，但普通 install 不会静默迁移。必须显式使用 `--upgrade`，并先检查 dry-run：

```bash
pnpm cognis install --project ../target-project --target codex --profile core --upgrade --dry-run
pnpm cognis install --project ../target-project --target codex --profile core --upgrade --write
```

Codex full 涉及 `.codex/` 红区，真实写入还需要 `--confirm-red-zone`：

```bash
pnpm cognis install --project ../target-project --target codex --profile full --upgrade --write --confirm-red-zone
```

升级事务会：

- 将 `loopengine.config.json` 迁移为 `cognis.config.json`。
- 仅改写完全匹配旧默认值的 `.agents/loopengine/` governance 命令。
- 备份并退休旧 install-state 明确追踪且 hash 未变化的品牌资产。
- 写入 `.agents/cognis/`、`using-cognis` 和 `COGNIS:*` 活动资产。
- 将状态升级为 `stateVersion: 4`，记录 `product: "cognis"` 与实际 `storageNamespace`。

旧安装升级后保留 `.loopengine/` 状态根，以避免在事务期间搬移日志和备份；活动治理资产使用 Cognis 命名。rollback 和 uninstall 继续从该状态根工作。

以下冲突会阻止执行：

- `cognis.config.json` 与 `loopengine.config.json` 并存：`COGNIS_CONFIG_CONFLICT`。
- `.cognis/install-state.json` 与 `.loopengine/install-state.json` 并存：`COGNIS_STATE_CONFLICT`。
- 同一文件同时存在 `COGNIS:*` 与 `LOOPENGINE:*` 块：拒绝读写。
- 自定义 governance 命令仍引用 `.agents/loopengine/`：`COGNIS_CONFIG_MIGRATION_REQUIRED`。

用户修改、未受管或已缺失的旧资产不会被自动删除。升级后需要撤销时先 dry-run，再执行：

```bash
pnpm cognis rollback --project ../target-project
pnpm cognis rollback --project ../target-project --write
```

rollback 会恢复旧配置和已退休资产；若 canonical 配置已被用户修改，则保留修改并报告跳过。uninstall 只删除未修改的受管资产，并保留用户配置。

## 4. 兼容接口

- `loopengine` CLI shim 在整个 `0.x` 保留，弃用提示只写 stderr，stdout JSON 保持机器可读。
- `LOOPENGINE_*` 环境变量作为 fallback 保留；对应 `COGNIS_*` 变量优先，并报告旧变量弃用。
- 读取器长期接受旧配置、旧状态、旧 marker 和旧 eval 证据路径。
- fresh run 只写 `cognis-*` 评测和产物路径。
- 第三方工具 ID `codebase-memory-mcp`、`open-code-review` 和 `agentmemory` 不重命名。

兼容层最早只能在独立的 `1.0` breaking release 中移除。

## 5. Profile 与工具

- `minimal`：平台入口、治理内核、Git/Test 规则和中文 task/delivery 模板。
- `core`：minimal 加工程专项规则、任务 runtime/schema、`using-cognis`、常规 skills 和 Red Team 门禁。
- `full`：core 加 durable memory、在线评测、项目内工具、MCP 注册和 Codex hooks。
- `docs-only`：只安装文档治理资产。

精确文件集合以 `manifests/profiles.json` 为真值。`install` 不隐式下载第三方工具；需要工具时单独执行：

```bash
pnpm cognis provision --project ../target-project --target codex --profile full --dry-run
pnpm cognis provision --project ../target-project --target codex --profile full --write
```

Agentmemory 因已知依赖风险保持 preview，显式选择时还需 `--allow-preview`。

## 6. 中断恢复与验证

被中断的事务先查看恢复计划，确认后再写入：

```bash
pnpm cognis recover --project ../target-project
pnpm cognis recover --project ../target-project --write
```

迁移完成后运行：

```bash
pnpm cognis validate --project ../target-project
pnpm cognis doctor --project ../target-project
pnpm cognis verify --project ../target-project
```

`validate` 只检查安装一致性；`verify` 才执行目标项目在配置中声明的验证命令。manual 命令必须检查内容后显式增加 `--allow-manual`。

## 7. 仓库与发布切换

`v0.5.0` 本地验证和独立审查通过后，再将 GitHub 仓库改名为 Cognis，并更新 badge、artifact 名和仓库 URL。本地目录名与 `origin` URL 属于仓库外人工步骤，不由安装器修改。
