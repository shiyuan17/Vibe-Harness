# ast-grep 结构化搜索规则

ast-grep 是项目内可选的结构化代码搜索工具。它用于按语法树匹配代码，而不是把文本相似误当作语义等价。

本规则仅在 ast-grep 插件或项目内等价工具已存在时生效；工具不存在时使用仓库搜索和直接文件阅读，不为普通定位任务停机。

## 工具选择

- 阅读大文件或目录前，先用 `node .agents/runtime/tools/ast-grep/run.mjs outline <path>` 获取本地结构，再读取候选源码范围。`outline` 只描述局部语法，不解析类型、引用或调用图。
- 精确语法节点、调用表达式、导入形式和条件结构使用 `run --lang ... -p ...`；复杂或重复查询使用 YAML rule、`scan` 和 `test`。
- 跨文件符号关系、实际调用链、架构和影响分析交给可用的 codebase-memory-mcp；纯文本、配置、日志和未知语言使用 `rg`。
- RTK 仅压缩 Shell 输出，不改变 ast-grep 参数，也不得包装项目内 ast-grep 入口。

## 使用顺序

项目内入口原样透传 ast-grep 参数；兼容并剥离开头的 `sg` 或 `ast-grep` 前缀，但不推断或补写子命令。`run` 是上游默认命令。

1. 需要查找函数、调用、导入、条件或结构模式时，使用项目内入口并显式提供语言、pattern 和最小路径。旧的 `sg` 或 `ast-grep` 前缀继续兼容。
2. 显式选择语言解析器和最小路径，默认尊重 ignore；扩大范围时使用明确的 `--globs`，结果必须回到源码、类型信息和测试核验。
3. 纯文本、日志、配置值或解析器不支持的文件使用 `rg` 或项目既有搜索命令。
4. 结构化搜索只提供定位线索，不替代行为证据、测试或人工审查。
5. 使用当前 shell 对应的 quoting，确保 \$A、\$\$\$ARGS 等 metavariable 原样传递；单节点使用 \$A，零到多节点使用 \$\$\$ARGS。
6. pattern 必须是解析器可解析的代码；歧义或复合条件改用 object-style rule。零匹配或异常匹配时使用 `--debug-query` 和 `--inspect` 检查解析结果。
7. 机器消费使用 `--json=stream` 或 `--json=compact`；持久化规则必须包含 valid/invalid case、snapshot，并运行 `ast-grep test`。

canonical 查询形式为：`node .agents/runtime/tools/ast-grep/run.mjs --lang typescript -p PATTERN src`。

## 规范依据

- https://ast-grep.github.io/advanced/prompting.html
- https://ast-grep.github.io/guide/outline-code.html

## 降级与证据

- 工具状态为 `pending`、`degraded` 或 `unsupported` 时，明确记录 `tool: ast-grep`、状态、回退到的 `rg` 命令和覆盖限制。
- 不因 ast-grep 无法安装而修改全局 npm、PATH 或目标项目的业务依赖；缺失时使用可复现的文本搜索继续工作。
- 搜索结果必须说明语言、模式、范围和后续核验方式，避免只交付匹配数量。
