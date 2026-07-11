# 更新日志

## 0.3.0

- 新增机器可校验的治理能力覆盖矩阵。
- 新增安装到目标项目的零依赖 basic/full 治理校验器和 Packet 校验器。
- core 默认包含 Review 门禁；full 增加 task/backlog、durable memory 和 Pencil 配对检查。
- task schema 增加恢复、阻塞、档位升级、verifier 和结构化跨仓证据字段。
- lint/typecheck 配置改为可选，`validate --project` 静态报告命令可用性且不执行用户命令。
- 深化通用治理规则并移除悬空来源引用。

## 0.2.0

- 新增 `.loopengine/install-state.json` 安装状态记录。
- 新增 `loopengine diff`、`install --upgrade` 和 `loopengine rollback`。
- 新增 MVP 项目模式：`loopengine init --project`、`install --project <path> --target codex --profile minimal|core|full --write`、`validate --project`。
- 新增 `loopengine.config.json`、Codex `AGENTS.md` 模板渲染和 `minimal` / `core` / `full` profiles。
- `validate --project` 现在会检查目标项目已安装文件是否与所选 profile 匹配。
- MVP `AGENTS.md` 安装改为受管块更新：保留目标项目原有内容，不默认修改 Node / pnpm 元文件。
- CLI 运行时错误改为结构化 JSON 输出，避免暴露 Node stack trace。
- Pack validation 接入 JSON Schema 校验，避免 schema 文件仅作为静态摆设。
- 深化 rules / skills：core 增加 coding、frontend、API、AI collaboration 等工程规则与专项 skills；full 增加 memory skills、release、Pencil、task-management 和 troubleshooting。
- 强制覆盖或升级前生成目标项目本地备份。
- 回滚红区文件时要求显式 `--confirm-red-zone`。

## 0.1.0

- 初始化 Codex 优先的内部治理包。
- 新增规则、模板、核心 skills、workflows、manifests、Codex adapter、dry-run 安装器、校验器、测试和示例。
- 收口 CLI 语义：默认 dry-run，真实写入使用 `--apply`，红区写入使用 `--confirm-red-zone`。
- 新增目标项目安装状态校验、manifest/install-map 结构校验和发布前 smoke 检查说明。
