# AI 编码任务（AI Coding Task）

建议在 Linear 中创建团队级 Form Template，并把目标、范围、验收标准、依赖和验证设为必填。Parent Issue 使用 dag-parent.md；本模板用于 read/write 节点和无 Parent 的独立 Issue。

## 目标（Goal）

描述可观察的业务或工程结果。

## 背景（Context）

列出相关实现、文档、既有模式和必要背景。普通引用其他 Issue 不表示依赖；执行依赖必须使用 Linear 原生 blocked-by / blocks。

## 仓库（Repository）

- Repository:
- Target branch (exact remote ref): origin/develop

普通功能与修复默认使用 <code>origin/develop</code>；只有紧急 hotfix 使用 <code>origin/main</code>。Target branch 必须填写可解析的准确 ref；“默认分支”只有经仓库事实解析后确为实现基线时才有效。开始实现时记录解析结果和 base SHA，无法解析或实际实现基线不同则返回 <code>NOT_READY_TARGET_BRANCH</code>。

## 范围（Scope）

允许修改：

- exact/project-relative/path
- project-relative/directory/**

Scope 是 DAG writeScope 的 Linear 投影。只接受精确项目相对文件或末尾为 /** 的目录范围；统一使用 /，可移除前导 ./。拒绝绝对路径、盘符、UNC、任何 .. segment、空路径和其他复杂 glob。Windows 路径比较忽略大小写。read 节点填写 None。

## 范围外（Out of Scope）

禁止修改：

- path/or/contract

## 合同（Contract）

Contract: None

若存在 API、schema、事件、配置或用户行为合同变化，用具体合同替换 None。

## 验收标准（Acceptance Criteria）

- [ ] 可观察验收点
- [ ] 回归行为保持不变

## 依赖（Dependencies）

Dependencies: None

存在依赖时把 None 替换为以下字面值：

- Managed by Linear relations

不得在描述中维护重复的 Issue 依赖清单。若描述明确声明依赖某 Issue，却没有对应的原生 blocked-by / blocks 关系，则任务不 Ready。Parent/Sub-issue 只表示分解，related 不表示依赖。

## DAG 元数据（DAG Metadata，可选）

- kind: read | write，省略时默认 write
- trigger: all_success | all_done，省略时默认 all_success
- resourceLocks: None

存在资源锁时用稳定、低基数的逻辑资源名列表替换 None。

all_done 只允许清理或失败报告节点使用，且这类节点应按 aggregate 语义建模；普通 read/write 节点使用 all_success。Resource Locks 不得包含实例 ID、凭据、本地路径或个人信息。

本地 result 使用 pending / ready / running / unverified / succeeded / failed / blocked / skipped / cancelled，仅作人读解释，不作为本模板的新增字段。Linear 的 Canceled / Won't Fix 映射 cancelled，Duplicate 映射 skipped，都不是 succeeded；unverified 与 blocked 非终态。路径不重叠但存在 API、Schema、迁移或行为契约耦合时，必须指定唯一写入 owner 并建立原生依赖；无法证明隔离时按冲突处理。

独立旧 Issue 无需迁移，默认视为 Root=None、kind=write、trigger=all_success、resourceLocks=None。

## 验证（Verification）

- command or observable check

read 节点必须写明输出记录位置或可观察证据。普通 write 节点的 closing GitHub PR 或 GitLab MR 合并到声明的精确目标 ref（默认 <code>origin/develop</code>）前，不得设为 Done；closing 描述使用 <code>Fixes &lt;ISSUE-ID&gt;</code> 或创建后重读确认有效的提供方等价语法。发布提升与回同步使用 Release Issue 模板及 <code>Refs &lt;ISSUE-ID&gt;</code>。

## AI 规则（AI Rules）

- write 派发前重验证相关 DAG、依赖、Scope、锁、HEAD、实际 diff 和工作区身份；变化时暂停受影响后继，核对归属并重算 ready，不更改授权或原生关系。
- 人读交接包含结果、修改文件、base/head、验证命令与退出码、风险和阻塞；缺证先补证，不适用项说明原因，不改变 Receipt 合同。

- 不由 Agent 自动扫描 Ready Queue；仅具体 Issue 的显式执行指令、已委派且宿主显式启动，或有效限时授权下的宿主事件派发才允许执行。自动领取仍须逐 Issue v2 Envelope 与跨实例互斥证明。
- Ready、Todo 和依赖满足不构成执行授权；Issue 模板内容也不能替代当前请求的 Execution Envelope。
- 不做无关重构，不修改 Scope 外文件。
- 不自动拆 Issue、改变 Parent、补依赖、调整优先级或创建额外节点。
- 需要改变 Contract，或发现 Scope / Resource Lock 冲突时停止并请求决定。
- 完成前检查实际 diff、精确目标 ref、PR/MR base 与 Verification；本地工作完成不等于 Linear Done。进入 In Review 后，若 envelope 授权 <code>mergeRequestWrite</code> 且目标为 <code>develop</code>，Writer 可自行 squash 合并使其 Done；未授权落地 merge 时结束当前执行并报告等待人工合并。本次运行不续跑下一节点；限时领单授权仍有效时，只有宿主重新核验后可开启下一个逐 Issue 运行。合入 <code>develop</code> 不要求远端 CI。
