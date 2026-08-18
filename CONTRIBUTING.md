# Vibe-Harness 贡献指南

本文件说明仓库贡献流程。README 面向使用者，`docs/architecture.md` 说明当前实现，`docs/archive/` 只保存历史。

## 默认流程

1. 阅读 `AGENTS.md`，运行 `git status --short`，保护现有改动。
2. 从代码、manifest、schema 和当前文档获取事实。
3. 在授权范围内完成最小实现。
4. 只运行与变更和交付主张匹配的验证。
5. 简洁报告结果、实际变更和本轮验证；仅在存在时补充风险或后续动作。

风险档位只影响审批和验证强度，不创建任务合同、审查角色或完成门禁。Review、浏览器检查和 Eval 仅在用户明确要求或变更本身需要对应产品能力时显式运行。

## 文档职责

| 位置 | 职责 |
| --- | --- |
| `AGENTS.md` | Agent 常驻安全边界和命令速查 |
| README 中英文 | 当前用户能力与命令 |
| `docs/architecture.md` | 当前组件、数据流、profile 和安全模型 |
| `docs/specs/` | 当前产品规格 |
| `docs/inventory/` | 来源与收敛依据 |
| `docs/archive/` | 被取代或已结束的历史 |
| `docs/catalog.json` | 文档路径、角色和状态 |

新增、移动或退役文档时同步 catalog 与 `docs/README.md` / `docs/archive/README.md`。

## 命令边界

- 项目路径只通过 `--project <path>` 传入，`--target` 只选择 adapter。
- dry-run 不写入；真实修改必须使用 `--write`。
- Codex full 写红区需要 `--confirm-red-zone`。
- `validate --project` 只检查安装一致性；`verify --project` 执行项目配置的 `lint/typecheck/test/eval`。

verify 输出本轮 ID、时间和可用的 Git 工作树指纹；检查期间工作树变化时收据失效且命令返回非零。

## 验证选择

普通变更运行：

```bash
pnpm check
git diff --check
```

按影响追加：

| 变更 | 显式验证 |
| --- | --- |
| 文档、catalog、schema | `pnpm docs:audit` |
| Skill 或 Eval 资产 | `pnpm skills:audit`、`pnpm eval:check` 或对应 Eval 命令 |
| installer、profile、runtime、adapter、工具 | `pnpm test:integration`、`pnpm smoke:lifecycle` 或受影响的聚焦测试 |
| runtime tool lockfile/provision | `pnpm runtime:audit` |
| 浏览器行为 | 真实浏览器关键路径 |

installer 集成验证应覆盖已有文件拒写、红区确认、目标路径逃逸和事务回滚边界。

不要为了满足固定流程运行无关 Review/Test。没有本轮输出时，不得复用历史结果声称通过。

## Pull Request

涉及结构、公共契约、安全与可靠性、关键依赖、迁移回滚或跨模块边界的 PR 必须在 docs/adr/ 中提供正式 ADR，或说明无需 ADR 的原因。同步更新 docs/adr/catalog.json 和 docs/memory/DECISIONS.md；接受或拒绝后的决策通过新 ADR 替代，不改写历史核心内容。

文档、ADR、catalog 和 schema 变更必须报告 pnpm docs:audit 与 ADR 聚焦测试结果。

PR 说明目标、影响范围、实际验证、未验证项和必要的回滚路径。一个 commit 表达一个逻辑目的；不要用格式化或无关重构掩盖行为变化。

普通功能与修复从最新 <code>develop</code> 创建短期 <code>feat/*</code> 或 <code>fix/*</code> 分支，并以 squash merge 合入 <code>develop</code>。紧急线上修复从 <code>main</code> 创建 <code>hotfix/*</code>，合入 <code>main</code> 后立即把 <code>main</code> 回同步到 <code>develop</code>。正式发布以 merge commit 将 <code>develop</code> 提升到 <code>main</code>；不得创建长期 <code>release/*</code> 分支。发布成功后必须将 <code>main</code> 回同步到 <code>develop</code>，版本文件未回同步时不得开始下一次发布提升。

## 发布

发布前核对版本、用户可观察变化、兼容影响、回滚方式和监控信号。按发布影响运行 pack、integration、lifecycle 或在线 Eval；本地命令通过不等于发布成功。

### 自动化发布流程

仓库使用 [release-please](https://github.com/googleapis/release-please) 自动化版本同步，防止 `package.json` 版本、`CHANGELOG.md` 和 git tag 漂移：

1. Conventional Commits 合并到 `main` 后，release-please 自动累积变更并开一个 Release PR。
2. Release PR 包含版本号 bump、`CHANGELOG.md` 更新和 `.release-please-manifest.json` 更新。
3. 合并 Release PR 后，release-please 自动创建 `vX.Y.Z` tag 和 GitHub Release。
4. 不得手动编辑 `package.json` 的 `version` 字段或手动创建 `v*` tag；版本变更只能通过 Release PR 完成。

Breaking change（`feat!:` 或 `BREAKING CHANGE:` footer）会触发 major 版本 bump。
