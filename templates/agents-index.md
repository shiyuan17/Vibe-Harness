# .agents/ 目录说明

Cognis 将项目级 AI coding 资产安装到本目录。子目录按职责划分；除特别注明外，文件由安装器管理，升级时会覆盖手动改动（受管文件）。

## 子目录

- `skills/`：领域 Skills，宿主按 SKILL.md 的 description 原生选择，不使用 Router。codex 装到这里；claude/gemini 分别装到 `.claude/skills/`、`.gemini/skills/`，见项目根的 `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`。
- `evals/`：评测数据——`suites/` 是用例集，`references/` 是人工批准的基线。安装器写入，升级覆盖。
- `memory/`：运行态项目记忆（README、observations、decisions、sessions），可手动读写；路径由 `cognis.config.json` 的 `memory.path` 决定，默认即此处。
- `runtime/`：Cognis 运行时脚本——`hooks/`（安全策略与 RTK 路由）、`evals/`（离线/在线 eval runner）、`tools/`（仅 `--plugin` 显式启用的项目内工具入口）。安装器写入，升级覆盖。

## 编辑策略

- 受管文件（`skills/`、`evals/`、`runtime/` 下的安装产物）：不要手动编辑；改动应回到 Cognis 源仓库，升级时重新安装。
- `memory/`：可自由读写，是项目自身的运行记忆，不被安装器覆盖（除非 `memory.enabled` 为 false 时不安装）。

## 命令

- `cognis validate --project <path>`：检查安装计划与受管文件是否一致。
- `cognis doctor --project <path>`：报告安装、工具、Git Hook 与事务健康。
