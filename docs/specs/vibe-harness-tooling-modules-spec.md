# Vibe-Harness 显式工具插件规格

## 状态

状态：Implemented

6 个工具插件均为项目内、可选且相互独立的能力。`minimal`、`core`、`full` 和 `docs-only` 的默认安装均不包含外部工具；`full` 表示完整治理能力，不表示自动下载工具。

## 选择合同

| 公开插件名 | 内部模块 | 用途 | 支持级别 |
| --- | --- | --- | --- |
| `rtk` | `rtk` | 高输出命令压缩 | stable |
| `ast-grep` | `ast-grep` | 结构化代码搜索 | stable |
| `codebase-memory-mcp` | `codebase-memory` | 项目代码图谱与索引 | stable |
| `chrome-devtools-mcp` | `chrome-devtools` | Chrome console、network 与性能诊断 | stable |
| `playwright-cli` | `playwright` | 浏览器自动化与回归证据 | stable |
| `open-code-review` | `open-code-review` | 项目内 AI code review | stable |

`--plugin -all` 或 `--plugin all` 展开为全部 6 个；`--plugin -rtk` 启用一个；`--plugin -rtk ast-grep` 启用多个。支持逗号分隔和重复 `--plugin`，规范化后拒绝未知值、重复值以及 `all`/`none` 与其他值混用。`--plugin none` 显式清空已持久化选择。Agentmemory runtime 因上游依赖树仍含 High 漏洞而暂停提供，不通过降低 audit 门禁重新开放。

插件选择是 profile 的增量集合：先解析 profile 或高级 `--modules` 替换集合，再加入插件及依赖闭包。因此 `full --plugin -rtk` 仍保留 full 的 governance、skills 与 hooks；memory 仅在显式选择 `memory` module 时加入。`--modules` 继续作为完整模块替换接口，不等同于插件选择。

选择优先级为 CLI `--plugin`、`vibe-harness.config.json` 的 `plugins`、install-state 的 `requestedPlugins`、空集合。install-state 同时保存 `requestedPlugins` 与 `resolvedModules`；validate、doctor、baseline、diff、reinstall 和 provision 复用该状态。卸载与 rollback 仅处理状态拥有的插件文件、runtime、缓存与 MCP 受管块。

## 固定版本与入口

| 插件 | 固定版本 | 项目内入口 |
| --- | --- | --- |
| RTK | `rtk-ai/rtk v0.43.0` | `node .agents/runtime/tools/rtk/run.mjs <command> ...`；原始输出使用 `node .agents/runtime/tools/rtk/run.mjs proxy <command> ...` |
| ast-grep | `@ast-grep/cli@0.44.1` | `node .agents/runtime/tools/ast-grep/run.mjs <sg\|ast-grep> ...` |
| codebase-memory-mcp | `0.9.0` | `.agents/runtime/tools/codebase-memory-mcp/run.mjs` |
| Chrome DevTools MCP | `1.6.0` | `.agents/runtime/tools/chrome-devtools-mcp/run.mjs` |
| Playwright CLI | `0.1.17` | `.agents/runtime/tools/playwright-cli/run.mjs` |
| Open Code Review | `1.7.7` | `.agents/runtime/tools/open-code-review/run.mjs` |

Wrapper 原样或按各工具安全合同转发参数，只调用已校验的项目内 runtime，不依赖全局安装，不修改 PATH、shell profile、用户级 Agent/MCP 配置或业务依赖。

## Provisioning 与状态

- npm 工具使用提交的 lockfile 与受审查安装阶段；ast-grep 在 `npm ci --ignore-scripts` 后显式运行 native binary postinstall。RTK 使用官方 release 平台/架构映射和固定 SHA-256，未提供资产的平台报告 `unsupported`。
- 工具状态为 `pending`、`ready`、`degraded` 或 `unsupported`；Open Code Review 还可在凭据缺失时报告 `pending-config`。错误使用稳定 code、脱敏诊断、限长输出和恢复或 fallback 建议。
- 显式 provision 执行所需的版本、binary、索引、MCP 或 browser smoke；install、validate、doctor 和 baseline 的只读路径不执行目标项目二进制。
- codebase-memory-mcp 的受管 MCP 环境固定设置 `CBM_MEM_BUDGET_MB=2048` 与 `CBM_WORKERS=2`。provisioning 在首次索引前将 `auto_index`、`auto_watch` 设为 `false`，后台不会在没有显式调用时重复索引。
- 选择 codebase-memory-mcp 时，安装器在项目根维护 `# VIBE_HARNESS:CBM:START` / `# VIBE_HARNESS:CBM:END` 包围的 `.cbmignore` 块，排除 Vibe-Harness 状态、Agent 配置、构建输出、工具缓存、日志和压缩包。既有用户规则保留；无受管块的既有文件在未使用 `--force` 时报告冲突。
- runtime、下载缓存、索引与工具状态均位于目标项目。未使用 `--force` 时不覆盖用户文件；真实 install、provision、rollback 和 uninstall 使用 `--write`，红区仍需显式确认。
- `pnpm runtime:audit` 审计 npm runtime 的实际依赖面并对 High/Critical fail-closed；RTK 使用 release checksum 供应链校验。存在未修复 High 风险的 runtime 不进入可安装清单。

## 使用与回退规则

- RTK 只用于低风险、可重复且输出量大的命令；敏感、交互式、破坏性或需要原始证据的命令直接使用原命令。
- ast-grep 只提供结构化定位线索；结果必须用源码、类型信息和测试核验。解析器不支持或纯文本场景回退 `rg`。
- codebase-memory-mcp 不可用时记录索引状态并回退仓库搜索；Chrome DevTools MCP 与 Playwright CLI 不可用时记录缺失能力并使用项目允许的浏览器或人工验证路径。
- Open Code Review 不可用时保留本地 review 流程和独立核验；长期记忆使用项目内 `memory` 模板与交接记录。
- 所有 fallback 都记录工具名、状态、原命令或替代命令、原因和覆盖限制；缺失、失败或降级不得静默处理。
