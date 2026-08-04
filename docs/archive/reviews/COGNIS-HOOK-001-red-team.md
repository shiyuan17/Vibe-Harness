状态：Completed

# COGNIS-HOOK-001 Red Team 审查包

- 任务编号：COGNIS-HOOK-001
- 审查范围：`hooks.allowedWriteRoots` 的配置校验、Hook 运行时路径边界、文档和回归测试
- 审查方式：独立只读 diff 审查与聚焦回归复验
- 结论：批准

## 发现与处置

| 编号 | 严重度 | 状态 | 发现 | 处置 |
| --- | --- | --- | --- | --- |
| RT-HOOK-001 | High | 已修复 | 任务合同曾对 Shell 写入作出超出路径提取器能力的边界承诺。 | 将合同和文档明确限定为 Hook 可识别的结构化文件写入。 |
| RT-HOOK-002 | High | 已修复 | 词法路径比较可被目录 junction 或 symlink 引导至白名单外路径。 | 候选路径和白名单根目录均解析真实路径；不存在的末级路径从已有父目录继续解析；新增 junction 回归测试。 |
| RT-HOOK-003 | Medium | 已修复 | 配置校验可接受与当前运行平台不一致的路径方言。 | 配置校验和 Hook runtime 统一使用当前平台的 `path.isAbsolute()` 语义。 |

## 复核证据

- `node --test tests/hook-runtime.test.js tests/hook-installation.test.js`：41/41 通过。
- `pnpm check`：437 通过、0 失败、2 跳过。
- `pnpm test:integration`：98 通过、0 失败、1 跳过；`pnpm smoke:lifecycle`：core/full 10/10 通过。
- `pnpm docs:audit`、`pnpm eval:check`、`pnpm eval:offline`：均退出 0。

## 剩余风险

路径检查与实际写入之间存在本地文件系统 TOCTOU 窗口；Hook 是纵深防御，不能替代文件系统沙箱。通用 Shell 写入参数不在此结构化路径白名单的解析范围内。
