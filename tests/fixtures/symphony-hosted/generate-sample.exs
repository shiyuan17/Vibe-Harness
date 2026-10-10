# Regenerates guarded-execution.sample.json from the Symphony Elixir fork's
# real receipt builders. Run it inside a container that mounts both the
# Symphony `elixir` directory and this folder:
#
#   docker run --rm -v <symphony>/elixir:/app -v <this-folder>:/out \
#     -v symphony_elixir_mix:/root/.mix -w /app elixir:1.19 \
#     sh -lc 'mix run --no-start -e "Code.require_file(\"/out/generate-sample.exs\")"'
#
# `--no-start` is required: the Symphony application needs a Linear token at
# boot, while building these records only calls pure functions.
alias SymphonyElixir.GuardedReceipt

claim = %{
  grant_id: "3f7c1a90-2b1d-4c8e-9f01-7a5b2c4d6e80",
  claim_id: "5b2c4d6e-7f80-4a1b-9c2d-3e4f5a6b7c80",
  execution_id: "9c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  fencing_token: 1,
  state: "reserved",
  lease_expires_at: ~U[2026-10-10 00:10:00Z]
}

identity = %{
  issue_identifier: "DEMO-401",
  agent_key: "codex",
  identity_kind: "delegate",
  delegate_id: "delegate-demo",
  runtime_instance_id: "7e6f5a4b-3c2d-41e0-9f8a-7b6c5d4e3f21"
}

{:ok, receipt} = GuardedReceipt.build(claim, identity, ~U[2026-10-10 00:00:00Z])
{:ok, event} = GuardedReceipt.terminal_event(claim.execution_id, ~U[2026-10-10 00:04:30Z])

File.write!(
  "/out/guarded-execution.sample.json",
  Jason.encode!([receipt, event], pretty: true) <> "\n"
)

IO.puts("wrote #{map_size(receipt)} receipt fields and #{map_size(event)} event fields")
