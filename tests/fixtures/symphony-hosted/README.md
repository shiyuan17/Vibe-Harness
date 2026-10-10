# Symphony 宿主契约样例

`guarded-execution.sample.json` 是 Symphony Elixir fork（guard dispatch）真实代码路径写出的结构化记录样例，供消费方契约测试使用：

- 第 1 条由 `SymphonyElixir.GuardedReceipt.build/3` 生成（`vibe-harness.linear-execution/v3`，`source=authorized-auto-claim`）。
- 第 2 条由 `SymphonyElixir.GuardedReceipt.terminal_event/2` 生成（`vibe-harness.linear-execution-event/v1`，`eventType=local-work-completed`，`successorExecutionId` 必须存在且为 `null`）。

样例是协议形状证据，**不是**真实执行记录：其中 Issue、Grant、Claim、执行标识均为合成值，未签发 Grant、未领单、未写入 Linear。重放生成时 `eventId` 会变化，其余字段固定。

重新生成（需要 Symphony 仓库的 `elixir` 目录与本机 Docker，脚本见同目录 `generate-sample.exs`）：

```text
docker run --rm -v <symphony>/elixir:/app -v <this-folder>:/out -v symphony_elixir_mix:/root/.mix -w /app elixir:1.19 \
  sh -lc 'mix run --no-start -e "Code.require_file(\"/out/generate-sample.exs\")"'
```

`mix run` 必须带 `--no-start`：Symphony 应用启动需要 Linear token，而生成样例只调用纯函数。
