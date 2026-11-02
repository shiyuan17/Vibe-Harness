# 明确授权的质量例外

> 历史兼容参考：普通 split-push 已改为纯 Git 操作，不运行质量验证、不消费此例外流程、不要求凭证或审计空提交。以下记录只用于理解旧提交，不作为当前执行要求；本地 stage 合同见当前 Git 规则。

仅 split-push 支持质量检查／流程条件例外，限 `develop` 及本任务明确关联的功能、修复分支；排除 main、master、release 及发布分支。先列出检查、真实 failed/blocked/unverified 状态、原因与残余风险。用户已明确授权的同一目标／效果／风险范围跨阶段、会话、重试持续有效，不重复索权；范围扩大、新失败或相关代码改变不自动继承。宿主能力不可用时一次说明，只暂停依赖动作，不要求 Agent 自造证明。

通过受支持的可信授权能力绑定 staged tree、目标 ref 与精确检查后，在 commit 正文写入 `Vibe-Harness-Exception: v1` JSON 段（以 `Vibe-Harness-Exception-End` 结束）；字段与校验见 `runtime/lib/delivery-exception.mjs`。不写原始对话、会话标识、凭据和用户路径；Git 记录只作审计，不是宿主授权证明。commit-msg 先检查信息再读取例外、执行必要 staged lint；pre-push 只消费匹配对象的明确豁免，其他检查仍须取得证据。验证不改写为 passed，不生成通过缓存。提交后才授权时追加引用受影响 SHA／tree 的审计 commit，仅此用途允许空 commit，不 amend。

安全扫描、敏感内容、权限、用户改动归属、服务端保护、精确目标和非强推边界不可豁免；不使用 `--no-verify`、禁 Hook 或修改策略取得通过。本能力不扩展到 develop-flow stage。
