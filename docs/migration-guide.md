# Cognis 迁移指南

## 旧产品边界

Cognis 不接管 LoopEngine 安装。发现旧产品配置、状态目录或受管标记时会以 `COGNIS_LEGACY_UNSUPPORTED` 拒绝写入；请先自行备份并移除旧资产，再初始化 Cognis。

## 删除的治理配置

以下字段已删除：

- `governance.mode`
- `governance.workflow`
- `hooks.completionGate`
- `validationCommands.governance`

存在任一字段时命令返回 `COGNIS_OBSOLETE_GOVERNANCE_CONFIG`，列出需要删除的字段，并且不写项目。Cognis 不静默兼容或自动改写配置。验证命令现在是可选的 `lint`、`typecheck`、`test`、`eval`。

CLI `--workflow` 也已删除。四个 profile 名称保持不变；`full` 现在表示全部领域 Skills、可选 Eval 和 Codex 安全 Hook。

## 升级

```bash
pnpm cognis install --project ../target-project --target codex --profile core --dry-run --upgrade
pnpm cognis install --project ../target-project --target codex --profile core --write --upgrade
pnpm cognis validate --project ../target-project
pnpm cognis doctor --project ../target-project
```

升级会退役旧 install-state 中存在、但新计划不再包含的受管文件。未修改文件删除；已修改文件只报告冲突。旧会话绑定与收据状态被精确删除，其他 `.cognis` 数据保留。

Codex full 的红区写入仍需 `--confirm-red-zone`。

## 命令边界

所有项目命令使用 `--project <path>`；`--target` 只选择 adapter。所有真实修改使用 `--write`，不使用 `--apply`。
