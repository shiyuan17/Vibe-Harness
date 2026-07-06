# v0.2.0 发布检查清单

- 运行 `pnpm check`。
- 运行 `pnpm pack:preview`。
- 在临时目录运行 `install --apply --confirm-red-zone`，确认 `.loopengine/install-state.json` 存在。
- 运行 `loopengine diff --target <temp-project> --profile codex-internal`。
- 修改 managed 文件后运行 `install --apply --upgrade --confirm-red-zone`，确认默认拒绝。
- 使用 `--force` 升级，确认 `.loopengine/backups/**` 存在。
- 运行 `rollback --target <temp-project> --dry-run`。
- 运行 `rollback --target <temp-project> --apply --confirm-red-zone`。
- 确认 rollback 不覆盖安装后又被用户修改的文件，并清理 `.loopengine/install-state.json`。
- 运行 `init --project <temp-project>` 并确认生成 `loopengine.config.json`。
- 运行 `install --project <temp-project> --target codex --profile core --dry-run` 并确认不写入 `AGENTS.md`。
- 运行 `install --project <temp-project> --target codex --profile core --write` 和 `validate --project <temp-project>`。
- 确认 README 明确 v0.2 仍只承诺 Codex adapter。
- 获得批准后打发布 tag：`v0.2.0`。
