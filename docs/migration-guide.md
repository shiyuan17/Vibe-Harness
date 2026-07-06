# LoopEngine 迁移指南

本指南用于将项目内的 AI coding governance 抽取到 LoopEngine，同时避免带入业务专属状态。

## 1. 盘点源项目

- 将源文件分类为可复用 rules、templates、skills、workflows，或仅用于示例的项目专属内容。
- 排除当前 task 状态、memory 快照、本地 backlog 数据、具体端口、后端仓库名和业务契约。
- 将项目专属值记录在 `loopengine.config.json` 中，不要硬编码到 core 文件。

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

如果 `AGENTS.md` 或其他受管理文件已经存在，LoopEngine 会先在 `.loopengine/backups/` 下写入备份，再替换目标文件。

## 5. 校验

```bash
pnpm loopengine validate --project ../target-project
pnpm test
pnpm run validate
git diff --check
```

如果生成内容缺少必需红线，或包含禁止出现的源项目专属标识，校验会失败。

## Profile 选择

- `minimal`：启动红线、红区确认、验证证据和交付 Packet 指引。
- `core`：`minimal` 加上生命周期规则、workflows、templates 和核心 skills。
- `full`：`core` 加上 memory、review 和 loop opt-in 相关指引，这些内容通过可复用规则包提供。
