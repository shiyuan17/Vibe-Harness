# probe 轻量代码检索规则

probe 是项目内可选的轻量代码检索工具（Tier 1 Lightweight Context）。它用本地索引加重排序，把自然语言意图查询转成紧凑的相关代码片段，适合跨文件的意图式定位与摘要；不依赖共享仓库索引，允许 Worktree 独立使用。

本规则仅在 probe 插件或项目内等价工具已存在时生效；工具不存在时使用仓库搜索和直接文件阅读，不为普通定位任务停机。

## 工具选择

- probe 不是 Tier 0（`rg`、`fd`、`git grep`、ast-grep，见 `ast-grep.md`）的替代：确定性文本匹配用 `rg`，结构化语法模式用 ast-grep，意图式「找做某事的代码」用 probe。
- 深度语义（符号引用、定义、类型解析）不是 probe 的职责，交给 serena（见 `serena.md`）；架构与多跳调用链交给 Tier 3 仓库索引。

## 使用顺序

1. 主入口：`probe search <PATTERN> [PATH]`，PATTERN 用自然语言描述意图，优先给出 PATH 限定目录。
2. 用 in-query 提示词收窄范围：`dir:`、`lang:`、`ext:`、`file:`；用 `--reranker`（bm25/tfidf/hybrid/hybrid2）调整排序，用 `--format` 控制输出，`--allow-tests` 仅在确需测试代码时使用。
3. 结果是相关性排序，不是语义证明；必须打开命中文件核对后才引用，引用时给出文件与行号。

## 资源预算（Tier 1）

- parser workers ≤ 2~4：上游 CLI 没有 worker 旗标（内部为 rayon 并行），用 `RAYON_NUM_THREADS` 环境变量约束在 2~4。
- `--max-results` ≤ 50，`--max-tokens` ≤ 10000；优先限定目录和语言，禁止无目的全仓扫描。
- 一次性排查查询用完即弃，不在会话内对同一范围反复重扫。

## 降级与证据

- probe 不可用或结果与源码冲突时，退回 `rg` 与直接文件阅读，并记录 `tool: probe`、替代命令和覆盖限制。
- 检索结果只是候选线索；行为主张必须由源码、测试、命令输出或实际产物支持。

## 规范依据

- https://github.com/probelabs/probe
