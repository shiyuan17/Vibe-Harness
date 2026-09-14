# <任务编号> <标题>

> 可选的人读记录；不由 Vibe-Harness 解析或作为完成门禁。

- 档位：快速 / 轻量 / 完整
- 状态：进行中 / 等待 / 阻塞 / 完成 / 取消
- 风险等级：低 / 中 / 高

## 来源

## 目标

## 非目标

## 验收

- [ ]

## 影响范围

## 关系链（依赖 / 契约 / 测试 / 文档）

## 执行判定

> 仅在有助于理解实施安排时记录直接实施或拆分的原因；不要求每个 Plan 填写。实际协作时声明必要依赖。该判定不构成新增授权，宿主 Plan 模式保持只读。

> 需要把已有计划转为 Goal、Task DAG 和单节点执行提示词时，可调用 `task-decomposition`；默认先在回复中输出可复制结果，只有长任务恢复需要时才写入本记录。

## 实施任务拆分（仅判定为拆分时填写）

> 按依赖、隔离和独立并行收益决定拆分时填写；每个任务应有明确结果和验证，不要求单独提交。该表不由 Vibe-Harness 解析或作为完成门禁。

| 任务 | 目标 | 依赖 | 修改范围 | 约束 | 验收标准 | 验证方式 | 产出 |
|---|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |  |

## 协作图（仅使用协作时填写）

> 两个以上协作单元存在顺序依赖、并行写入或共享契约时填写；该表不由 Vibe-Harness 解析或作为完成门禁。

> Linear 映射时 dependsOn 只从原生 blocked-by / blocks 关系派生；Parent/Sub-issue 和 related 不产生执行边。writeScope 只接受精确项目相对路径或目录范围；冲突 Scope / resourceLocks 必须已有依赖顺序，all_done 只用于 aggregate，不能把失败 Root 判为成功。

> DAG result 使用 pending / ready / running / unverified / succeeded / failed / blocked / skipped / cancelled；unverified 与 blocked 都是非终态。Linear 的 Canceled、Duplicate、Won't Fix 只作为外部终态并按非 succeeded 处理。write 节点派发前须重验证 DAG、依赖、Scope、锁、HEAD 和工作区身份；节点交接至少报告结果、修改文件、base/head、验证命令与退出码、风险和阻塞。

| id | kind（read / write / aggregate） | output | dependsOn | trigger（all_success / all_done） | writeScope | resourceLocks | verification | result |
|---|---|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |  |  |

## 完整项目分析（仅显式要求或影响范围无法缩小时填写）

- 技术栈：
- 目录结构：
- 业务流：
- 数据流：
- 模块依赖：

## 执行与验证

## 判定（能不能动）

## 下一步

## 风险
