# Troubleshooting

Troubleshooting starts from reproducible evidence rather than guesses. Collect the symptom, scope, recent changes, logs, and minimum reproduction before proposing a fix.

## Rules

- 先收集症状、范围、最近变更和最小复现，再提出修复。
- 每个修复都应对应一个能防止回归的验证。
- 交付时写清影响范围、验证命令和未覆盖风险。

## Checklist

- 症状：记录实际错误、时间、环境、频率和影响范围。
- 最小复现：给出最小命令、步骤、输入或测试。
- 分界：确认最近变更、相关模块、外部依赖和排除项。
- 假设：每次只验证一个主要假设，观察结果要能证伪。
- 修复：修复必须对应回归测试、验证命令或人工核对。
- 变更：一次只改变能验证当前假设的最小变量；不要同时升级依赖、重构和修改配置。

## 验证证据

- 失败复现命令和退出码。
- 修复后的通过命令和关键输出。
- 未复现、间歇性或环境依赖风险。

## 停止条件

无法复现、缺少关键日志、需要生产权限或修复会扩大范围时停止并升级。
