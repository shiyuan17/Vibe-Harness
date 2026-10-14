# 工具模块与外部能力规范

状态：Implemented。

## 当前安装面

受管 runtime 插件只有 chrome-devtools-mcp、playwright-cli 和 open-code-review，各自保留独立版本、安装阶段和诊断合同。Linear 读写与只读集成仍按既有互斥规则选择。默认 profile 不自动安装外部工具；`--plugin all` 选择三个 runtime 插件，`--preset everything` 额外选择 full、Linear 读写、memory 和既有预览能力。

codebase-memory-mcp 使用规范属于 rules-core，随 core/full/docs-only 和显式 rules 模块分发；minimal 不增加该规则。工具由用户或宿主管理，Vibe-Harness 不写 MCP 配置、不锁版本、不提供 wrapper、status/refresh 或索引缓存管理。规则存在不等于工具存在。

## 参数与安全

所有项目命令使用 `--project <path>`，`--target` 只选择 adapter；真实修改须 `--write`，红区须 `--confirm-red-zone`。插件支持逗号分隔和重复 `--plugin`；未知值、重复值以及 all/none 与其他值混用均拒绝。`--plugin none` 清空插件选择，`--modules` 仍是完整模块替换接口。

受管工具使用提交的依赖清单、lockfile 和经过审查的安装阶段；诊断脱敏，子进程环境使用白名单，取消与超时终止受管子进程。不得修改全局 Agent、MCP 或 Git 配置。缺失凭据、工具失败和 MCP 冲突不得报告 ready。

## 退役兼容

RTK、ast-grep、CodeGraph、Serena 和 Probe 不再提供规范或安装支持；codebase-memory 的旧插件入口同样退役。新请求中的旧插件、模块或 RTK 参数须报错；历史配置通过 `install --upgrade` 迁移，先预览，再在明确写入及红区确认后备份更新。

退役依赖旧安装台账和内容哈希。未修改的受管文件及配置块可移除；用户修改、未受管内容、外部安装、索引和缓存数据保留。共享配置仅移除旧受管条目，不删除其他 MCP 或安全 Hook。支持 dry-run、重复升级、preserve-retired、事务回滚和路径逃逸拒绝。

## 验收

覆盖各 profile、all 与 everything 的新安装；旧插件配置、旧模块和 RTK 字段的迁移；共享 TOML/JSON 配置、忽略文件、用户修改、未受管内容、红区和路径边界；其余工具 provisioning、环境隔离、超时、取消和失败诊断保持原合同。
