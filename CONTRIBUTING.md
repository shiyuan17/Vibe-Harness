# LoopEngine 贡献指南

本文件是仓库贡献流程的中文真值。`AGENTS.md` 保存 Agent 必须常驻读取的硬边界和命令速查；README 面向使用者；`docs/` 解释系统与历史。不要在多个位置复制同一套流程。

## 开始前

1. 阅读 `AGENTS.md`，确认安全边界与命令生命周期。
2. 运行 `git status --short`，识别并保护不属于本次工作的改动。
3. 通过 [`docs/README.md`](docs/README.md) 找到对应真值，先修正现有内容，不追加平行说明。
4. 先确定变更范围、成功标准和验证计划；涉及安全、发布、公开接口、跨层或多 Agent 时使用完整档位。

## 文档职责

| 位置 | 受众 | 唯一职责 |
| --- | --- | --- |
| `AGENTS.md` | 仓库内 Agent | 硬边界、必跑命令、工具降级和文档路由 |
| `CONTRIBUTING.md` | 贡献者 | 变更流程、影响矩阵、PR 与发布要求 |
| `README.md` / `README.zh-CN.md` | 使用者 | 当前能力、安装和使用方式 |
| `docs/architecture.md` | 维护者 | 当前组件、数据流、profile 与安全模型 |
| `docs/specs/` | 实现者、审查者 | 当前已接受或已实现的行为合同 |
| `docs/inventory/` | 审计者 | 来源、脱敏与能力收敛依据 |
| `docs/archive/` | 审计者 | 已完成或被取代的历史，不作为当前规范 |
| `CHANGELOG.md` | 使用者、发布者 | 每个版本最终可观察的净变化 |

`docs/catalog.json` 记录上述知识文档的角色、状态和替代关系。新增、移动或改变文档状态时必须同步 catalog 和索引。

## 变更影响矩阵

| 变更 | 必须同步 |
| --- | --- |
| CLI、profile 或安装行为 | README 中英文版、架构、迁移指南、相关规格与测试 |
| 规则、模板或 Skill | 对应 manifest、能力矩阵、评测场景和使用文档 |
| Adapter 或运行时 | 架构、目标平台说明、安装/卸载测试和诊断文档 |
| 环境变量、凭据或工具状态 | README、架构、运维或故障恢复说明 |
| 退役或重命名 | 当前文档、catalog、索引、记忆载荷和所有非历史引用 |
| 发布 | 版本号、Unreleased、迁移影响、验证、回滚和监控证据 |

历史文档可以保留当时的接口和文件名，但必须位于 `docs/archive/` 并标明状态。当前文档不得借历史文件维持现行规范。

## 命令生命周期

- 所有项目命令使用 `--project <path>`；adapter 由 `--target <codex|claude|gemini>` 指定；真实写入使用 `--write`。
- `--apply`、路径型 `--target`、`codex-internal` 和 `codex-minimal` 已移除；旧 install-state 只在标准升级时归一。
- `validate --project` 只检查安装一致性；执行目标项目命令使用 `verify --project`。

## 验证矩阵

所有变更都运行：

```bash
pnpm check
git diff --check
```

按变更范围追加：

| 变更范围 | 追加验证 |
| --- | --- |
| 文档、catalog 或 schema | `pnpm docs:audit` |
| `rules/`、`templates/`、`skills/`、`adapters/`、`manifests/`、`schemas/`、`evals/` | `pnpm eval:check`、`pnpm eval:offline` |
| `skills/` | `pnpm skills:audit` |
| installer、profile、runtime 或内置工具 | `pnpm test:integration`、`pnpm smoke:lifecycle`，以及 `AGENTS.md` 中 core/full 两套显式临时项目命令 |
| runtime tool lockfile 或 provision 参数 | `pnpm runtime:audit` |

失败、跳过、degraded 和人工检查都必须如实记录。没有本轮输出时，不得复用旧结果声称完成。

## Pull Request

PR 使用仓库模板并至少说明：

- 目标、非目标和影响范围。
- 使用的安装生命周期；不涉及时明确写“不涉及”。
- 文档影响和 catalog 处理。
- 实际验证命令、退出码和关键观察。
- 未验证项、剩余风险和回滚路径。
- 高风险变更的独立审查与批准状态。

一个 commit 只表达一个逻辑目的。格式化、依赖升级、重构和行为变化默认拆分，避免用大提交隐藏无关变更。

## 发布

发布规则以 `rules/release-rules.md` 为通用行为真值，本节只说明 LoopEngine 仓库的执行面：

1. 确认 `package.json`、adapter/plugin 元数据和计划 tag 的版本一致。
2. 将 Unreleased 收敛为最终用户可观察变化，删除开发过程中的中间态叙事。
3. 运行 `pnpm pack:preview`、完整验证矩阵和两套独立生命周期 smoke。
4. 记录兼容影响、迁移步骤、回滚路径、监控信号和未验证项。
5. 获得批准后再创建 tag；本地命令通过不等于发布成功。

## 停止条件

发现规则冲突、范围扩大、红区未确认、测试反复失败、历史与当前真值无法判断，或需要覆盖用户改动时停止。先保留证据和工作区状态，再请求明确决策。
