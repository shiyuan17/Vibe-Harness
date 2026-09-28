# Micro Verification 规则

## 定位

Micro Verification 是验证阶梯的 L1：用于对已声明的模块入口、规则输入输出或纯计算 probe 提供快速、局部、可重复的证据。普通交互式 REPL、临时 `node -e`、未登记脚本和人工观察只用于探索，不能写入正式完成收据。

## 声明契约

项目配置中的 `validationCommands.micro` 必须使用结构化声明：`id`、`kind`、项目相对 `entry`、结构化 `args`、`costTier`、`scopes`、`maxDurationMs`、`maxOutputBytes`、`deterministic`、`network`、`workspaceWrite`、`allowedEnv`、`expectedExitCodes` 和 `promotableTo`。默认拒绝网络、凭据和工作区写入。

旧 `command` 只作为源仓库 `verify:micro --run` 迁移兼容层；已安装项目的受管 `verify --micro` 拒绝它，不得复用缓存、进入异步队列或作为新项目配置格式。

## 执行边界

- module runner 只加载声明的项目相对入口并传入 JSON 参数；rule runner 使用声明 fixture；pure runner 只能执行纯计算。
- 禁止 inline eval、任意 shell、管道、网络请求、包安装、凭据读取、工作区写入和动态模块路径。
- 子进程必须 `shell: false`；超时、输出超限、执行异常、快照变化和环境不满足均为 `blocked`。
- 预期业务断言失败为 `failed`；只有达到预期退出码、快照匹配且输入输出摘要可审计时才为 `passed`。
- stdout/stderr 必须脱敏并受字节上限约束；收据不得保存原始敏感输入。
- 已安装运行时要求 Node 22+ 的权限模型，只授权读取声明的入口与 fixture，拒绝子进程和文件写入；入口必须是经项目维护者审阅的可信 probe。Node 权限模型不隔离网络，源码静态拒绝也不是恶意代码沙箱；不得将对不可信入口的执行当成“已证明无网络访问”。需要对不可信代码强制断网时应使用外部隔离环境并将本入口标为 blocked。
- `verify --micro <id>` 必须显式指定已声明的 ID，可用 `--plan` 先查看；它与 `--tier`、`--only`、`--async`、`--reuse` 互斥，不因项目安装而自动扫描业务或生成 probe。非 Git 工作树无法比对快照，不产生 passed 收据。

## 证据和升级

Micro 通过只关闭对应局部观察，不降低风险等级，也不能支撑公共契约、集成、权限、安全、发布、E2E 或整体完成。Micro 失败自动升级到声明的正式测试层；`unknown` 或 `lower-bound` 影响映射不得使用 Micro-only 计划。稳定场景只能生成 `promotableTo` 候选，人工确认后再固化为 unit/probe。

## 复用和状态

受管 Micro 当前不支持 `--reuse`，每次执行重新比较工作树快照；以后若启用缓存，仅确定性检查允许复用，缓存键必须绑定工作树、入口、参数、fixture、配置、锁文件、工具链、环境和 runner 版本。上述任一输入变化、warm provider 失效或快照变化都将阻止旧 receipt 复用。`queued`、`running`、`stale`、`blocked` 和 `unverified` 均不得作为通过证据。
