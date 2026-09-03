# Linear Execution Receipt

Execution Receipt 是 Linear Issue 上不可变、追加式的结构化评论，用来记录具体 Agent 运行实例。人类 Assignee 表示结果责任人，Delegate/App User 表示 Agent 产品身份，Receipt 表示运行实例，Linear Activity Feed 表示委派或身份变更历史。

每条结构化评论只包含一个独立 JSON 对象，不混入自由文本。Receipt 和 terminal event 一经写入不得编辑或删除；解释或修正只能追加新评论。

## Start Receipt

    {
      "schema": "vibe-harness.linear-execution/v1",
      "executionId": "uuid-v4",
      "source": "explicit-user-request",
      "agentKey": "codex",
      "hostKind": "codex-desktop",
      "delegateId": "linear-app-user-id-or-null",
      "runtimeInstanceId": "opaque-uuid-v4",
      "role": "writer",
      "dagRootIssue": "ENG-100-or-null",
      "dagNodeIssue": "ENG-123",
      "startedAt": "RFC3339-UTC"
    }

约束：

- schema 固定为 vibe-harness.linear-execution/v1。
- executionId 和 runtimeInstanceId 是新生成的 UUID v4。runtimeInstanceId 只用于 Receipt 关联，不得复制宿主 thread、session、OAuth session、用户名、主机名或其他真实会话标识。
- source 只允许 explicit-user-request、existing-delegate、authorized-handoff。
- agentKey 和 hostKind 使用稳定、低基数的产品标识；role 在 V1.1 只允许 writer。
- delegateId 是当前原生 Delegate/App User ID；fallback label 模式填写 null。
- dagRootIssue 为顶层 Parent 标识；独立 Issue 填 null。dagNodeIssue 必须是当前 Issue。
- startedAt 使用 UTC RFC3339 时间，不得倒签或回填。

## Terminal Event

    {
      "schema": "vibe-harness.linear-execution-event/v1",
      "eventId": "uuid-v4",
      "executionId": "original-execution-uuid",
      "eventType": "released",
      "successorExecutionId": null,
      "occurredAt": "RFC3339-UTC"
    }

约束：

- schema 固定为 vibe-harness.linear-execution-event/v1。
- eventType 只允许 released、aborted、handed-off、local-work-completed。
- executionId 必须引用已有 Start Receipt。successorExecutionId 只有 handed-off 时为新运行预分配的 executionId，其余事件必须为 null。
- local-work-completed 只终结运行实例，不表示 Linear Done；write 节点仍需 closing PR 合并。
- released 表示显式释放；该指令可同时授权清除当前 Delegate 或 fallback Agent label，但必须保留人类 Assignee。
- aborted 和 local-work-completed 默认保留 Delegate；任何身份变更仍需明确授权。

## Handoff Completion Payload

handed-off 事件可携带一个 vibe-harness.handoff/v1 payload。它是完成状态的唯一可接受摘要，不复制原始会话：

    {
      "schema": "vibe-harness.handoff/v1",
      "completion": { "status": "complete", "accepted": true },
      "finalCheck": { "receiptId": "verification-uuid", "relevance": "reviewed", "status": "passed" },
      "unresolvedItems": [
        { "id": "follow-up-1", "summary": "待人工确认", "owner": "team-or-role" }
      ]
    }

- completion.status 只允许 complete、in-progress 或 blocked；只有 complete 且 accepted: true 才能表示已完成。
- finalCheck 必须引用最终检查收据，并同时声明 relevance: reviewed 与 status: passed；缺失或不匹配时 handoff 保持未完成。
- unresolvedItems 必须是数组；每个未决项都必须有非空 owner。没有未决项也必须明确写入空数组，不能省略责任边界。
- 任一字段未满足时只能作为进度交接，不能静默交付或推进完成状态。

## 活动实例与冲突

一个 Start Receipt 在其后没有有效 terminal event 时是 active。同一 Issue 同时最多一个 active execution；两个以上 active Receipt、一个 execution 的多个矛盾终结事件、同一 ID 的不同内容或无法完整读取评论历史都属于冲突，必须停止并由人工处理。

同一 eventId 且字段完全一致的重复结果视为同一事件；同一 execution 最多有一个有效 terminal event。未知的新增字段可由 V1 消费者忽略，但未知 schema major、未知 eventType 或破坏现有字段语义时必须 fail-closed。

## 幂等写入

一次登记或终结尝试先生成 ID，所有传输重试都复用这些 ID。写请求超时或结果不确定时先重新读取：

- 找到字段完全一致的对象，视为幂等成功，不再追加。
- 未找到时才用原 ID 重试。
- 找到同 ID 不同内容或第二个 active Receipt，停止并报告冲突。

身份已写而 Receipt 未确认，或 Receipt 已写而身份不一致，都属于 registration-incomplete；不得开始实现，不得删除 Receipt 伪造回滚。

## 授权交接

交接必须由用户明确授权，并按以下顺序执行：

1. 为 successor 预生成新的 executionId 和 runtimeInstanceId。
2. 向旧 execution 追加 handed-off event，并让 successorExecutionId 指向新 executionId。
3. 保留人类 Assignee，更新 Delegate 或管理员预配置的 fallback Agent label。
4. 使用同一个 successor executionId 写入 source 为 authorized-handoff 的新 Start Receipt。
5. 重新读取身份、旧终结事件和新 Receipt，逐字段确认。

若第 3 至 5 步失败，旧 execution 已终结且 successor 尚未确认；报告 handoff-incomplete。重试必须复用预生成的 successor ID，不得生成第三套运行记录。

## 敏感信息

Receipt 和 event 禁止包含用户名、主机名、本地路径、Token、API key、Cookie、认证头、验证码、thread/session ID、OAuth 凭据或个人敏感数据。需要解释原因或提供证据时另写经过脱敏的普通评论，不扩展结构化对象。
