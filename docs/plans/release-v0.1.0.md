# 发布检查清单

- 运行 `pnpm check`。
- 运行 `pnpm loopengine install --target <temp-project> --profile codex-internal --dry-run`。
- 运行 `pnpm loopengine doctor --target <temp-project>`。
- 确认没有脱敏 finding。
- 确认 README 明确 v1 只支持 Codex adapter。
- 获得批准后打内部发布 tag：`v0.1.0`。
