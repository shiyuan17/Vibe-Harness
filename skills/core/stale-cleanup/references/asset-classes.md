# 六类过期资产判定细则

目录：死代码 / 过期引用 / 过期文档 / 过期资源 / 过期记忆 / 过期索引 / 确认与恢复

## 死代码

- 确定性证据：扫描器报出的 `CLEANUP_REFERENCE_MISSING` 指向源码模块被删除、调用方仍在引用的情形；以编译、类型检查或导入解析失败为准。
- 候选证据：`CLEANUP_UNREFERENCED_FILE`、`CLEANUP_UNUSED_EXPORT`。删除前必须确认动态导入、反射、字符串拼装路径、外部消费者（发布包、CI、脚本入口）和测试夹具都不再使用。
- 常见误报：CLI 入口脚本、CI 直接调用的脚本、被 `node --test` 显式列出的测试文件、按约定加载的适配器模板、被文档而非代码引用的资产。
- 保留边界：与本次任务无关的既有死代码只报告，不擅自删除。

## 过期引用

- 确定性证据：`CLEANUP_REFERENCE_MISSING`，来源是生产源码、规则或文档中指向仓库内相对路径的链接与引用。
- 处理顺序：先判断引用方是否应更新（路径改名、文档搬迁），再判断目标是否应恢复；两者都不成立时才考虑删除引用方描述的内容。
- 忽略面：`docs/archive/`、`audit-reports/`、`docs/inventory/`、`CHANGELOG.md` 等历史记录，测试夹具路径，以及 `<...>`、`*`、`${}` 等未解析占位符。

## 过期文档

- 确定性证据：`CLEANUP_DOC_ORPHAN`（文档 catalog 记录了不存在的文件）、`CLEANUP_DOC_UNCATALOGED`（受治理文档未进 catalog）、`CLEANUP_INDEX_STALE`（渲染副本或镜像与权威源漂移）。
- 候选证据：`CLEANUP_DOC_STALE`，文档内最后验证日期超过半年。它只是复核触发信号，不代表内容失效。
- 处理：内容过期时先修内容，再更新复核日期；确认废弃时按项目归档约定移动，不用删除代替归档。

## 过期资源

- 定义：无引用、无目录约定、无生成来源的静态资产（模板、示例、schema 副本、fixture、脚本附件）。
- 证据：`CLEANUP_UNREFERENCED_FILE`（候选项）与 `CLEANUP_ORPHAN_ASSET`（已确认的孤儿镜像）。
- 删除前确认：构建与打包清单（`package.json` files、install-map）、目录约定（`index.*`、`README.md`）、外部下载地址与文档引用。
- 生成物优先重新生成而不是手工删除；无法重新生成时报告并请求 owner 判断。

## 过期记忆

- 证据来自 `vibe-harness audit --project <path> --kind memory`：空模板、日期无效、最后验证过期、引用的文件缺失或在其之后被修改。
- 判定：把「需要复核」与「应当遗忘」分开；只有内容已被新事实取代或长期不成立时才建议遗忘。
- 遗忘走显式确认流程，删除前确认作用域（单条、主题、整个会话摘要），不要批量删除以图省事。

## 过期索引

- 仓库内索引：文档 catalog、归档与 ADR 索引、`.agents/evals/` 镜像、install-state 登记。由 `audit --kind cleanup` 与 `pnpm docs:audit`、`pnpm eval:sync` 核对。
- 代码索引：`.codebase-memory/artifact.json` 记录构建时的 commit 与时间，扫描器据此报出 `CLEANUP_INDEX_STALE`（含 commit 漂移与超过半年的索引）；产物缺失或不可读时报 `CLEANUP_INDEX_UNAVAILABLE`，不推断索引状态。
- codebase-memory-mcp 语义查询：`list_projects`、`index_status`、`index_repository` 由 Agent 在工具可用时使用，用来确认项目归属与新鲜度；CLI 扫描器只读磁盘产物，因此 `CLEANUP_INDEX_UNAVAILABLE` 表示本次未覆盖这一类判定，不代表索引过期。
- 重建优先于删除：索引重建成本低、收益明确；删除索引只在确认项目已迁移或索引归属其他项目时考虑。

## 确认与恢复

- 每一项清理都要先给出：目标路径或符号、证据来源、影响范围、删除后需要重跑的命令、恢复方式。
- 优先可恢复路径：保持 Git 可恢复状态，或先备份到 `.vibe-harness/backups/`；不使用破坏性 Git 命令替代确认。
- 删除后按影响跑聚焦验证（构建、类型检查、相关测试、catalog 与 skills 审计），失败时立即恢复并重新评估。
