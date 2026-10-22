# 交付记录

> 各字段的语义定义（evidence 标签、完成主张对应关系、passed/failed/blocked/unverified 四态语义）见 `docs/rules/governance-core.md` 的「交付与证据标签」节。本模板只提供字段结构，不重复定义语义。

启用 Delivery Profile 的项目同时保存结构化 completion JSON：delivery.profile/stage、status、acceptance（id/status/command 或 criterion/scope）、unverified、remainingRisks、rollback、source/target、verification。`verify` 只生成 stage=verify 的证据草稿，不自动宣称 complete；补齐实际验收后以 `task check <id> --complete --receipt <file>` 或 worktree 清理门检验。缺失浏览器或真实数据库环境记录 blocked，不由静态检查或替代数据库结果代替。

- 结果：
- 实际变更：
- 本轮验证：

必需验收逐项记录为 passed、failed、blocked 或 unverified，并附实际命令或人工判据。只有全部必需项 passed 才能写“完整完成”；构建、lint、文件哈希或跳过相关测试不能替代目标行为验证。

仅在存在时补充：未验证项、风险、后续动作。

行为修改按原验收项核对结果与保留行为；已有计划沿用同一组验收 ID，关联实施单元和本轮证据。需求 ID 与检查 ID 不混用；简短任务用文字摘要，不新增表格。`acceptanceCoverage` 只诊断声明关系，告警模式的退出码 0 不代表需求或行为已全部通过。

## 返修观察（仅实际返修或试点）

- 事件标识与原验收项：
- 主要原因：需求理解 / 范围遗漏 / 实现 / 验证 / 环境 / 集成 / 未知；新增需求单列。
- 最早可发现但未发现的环节：
- 修复措施、防复发检查与证据：
- 返修耗时（未知留空）、明确验收反馈及反馈窗口：

同一事件只计一次，不把失败日志条数或编辑次数当返修次数；无反馈不算首次验收成功，未知耗时不填零。复用现有任务或交付记录，不新增台账、监控、数据库或完成门禁；已有运营事件沿用 `reworkCount` 与 `reasonCode`。工程落地、在线行为验证与真实返修改善分别报告。

## 收尾对齐

测试通过或工作区干净不等于知识已同步。变更涉及行为、接口或配置时检查：相关文档、规则和注释是否仍与代码一致；不一致就就地修正或记录为后续动作。在已授权范围内自行清理本轮创建、归属明确且不再需要的临时文件；保留用户原有、并发产生或归属不明的文件。生产、红区、不可逆清理和范围扩大仍按 governance-core 核对授权。交付使用简明证据摘要，不统一要求完整命令输出或红→绿过程；本地交付不隐含提交、推送、合并或发布。
# 验证交付边界

- 最低层级与实际执行层级：
- Micro 仅证明的局部不变量：
- 已通过/延期/阻塞检查：
- 完成主张范围：
- 未验证风险、stale/queued 状态：
