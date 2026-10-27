# 分组提交中断修复

## 问题和修改

关联执行在 `git commit` 的 pre-commit 检查处停止。暂存的两份
`verification-risk.mjs` 存在 EOF 空行，Git 正确拒绝提交，但 Hook 丢失了
`git diff --cached --check` 的 stdout 位置诊断。随后诊断曾在错误目录运行。
原分组还按 runtime、tests/config、docs/skills 划分，不能保证每组包含自身验证依赖。

- Hook 保持拒绝行为，只转发识别出的文件、行号和空白问题类型；不回显新增代码或原始 stderr。源入口和本仓库安装副本一致。
- split-push 和 Git 规则要求固定仓库目录、按完整逻辑分组，代码与依赖测试/配置一起提交；核对已有暂存，不沿用不完整分组。
- 每组先检查 index 空白，核对验证对象和 staged tree；需要时导出 index 隔离验证。工作树存在新测试不能证明提交包含该测试。
- 冻结范围内已定位的纯格式问题允许最小修复、重新暂存、重验后经原 Hook 重试一次；权限、安全策略、未知 Hook、重复失败仍停止。不禁用 Hook。
- 已有 EOF 问题已修正，当前工作树及暂存区空白检查均通过。保留原有暂存分组及其他未提交修改，本次未在真实仓库提交或推送。

## 行为证据

`tests/e2e/hook-installation.test.js` 使用一次性真实仓库验证：EOF 空行拒绝并定位、
仅修工作树仍拒绝、重新暂存后成功提交、排除项保留、空白诊断不输出代码、
密钥拒绝保留 HEAD 和 index。

`EVAL-GIT-DELIVER-013` 使用真实 index 导出、提交树和合成本地远端。
`tests/integration/eval-execution.test.js` 的正负控确认：
未执行、遗漏未暂存测试、未重新暂存、缺少远端提交、旧验证树和禁用 Hook
均不能通过；完整逻辑组经原 Hook 提交、普通推送后可以通过。
这些是确定性实现与判据证据，不是模型遵循 Skill 的改善证据。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `pnpm check:fast` | 通过，201 个单测；含 typecheck |
| Hook E2E、Eval execution/contract、self-install、eval projection、rule-skill parity 六个文件 | 90/90 通过 |
| `pnpm skills:audit` | 通过，20 个 Skill |
| `pnpm docs:audit` | 通过，153 份文档 |
| `pnpm tests:catalog check` | 通过，1464 个声明/台账用例；保留语言告警 |
| `pnpm lint:eslint` | 退出 0；284 个告警、0 个错误 |
| `pnpm pack:contract` | 通过 |
| `pnpm eval:check`、`pnpm eval:sync` | 通过，镜像漂移 0 |
| `git diff --check`、`git diff --cached --check` | 通过 |

初轮回归发现并修复旧套件版本断言和未同步的 Eval 镜像；未弱化判据。

## Reference 更新

沿用用户明确的漂移修复授权，核实宿主已提供 protected approval 后，
通过正式 `eval run` / `eval reference --confirm-reference-update --force` 入口更新。
相对本次修复开始时已有 reference，仅 hooks、rules、skills 分组改变，
config 保持不变；该比较基准不是仓库 HEAD。随后同步安装镜像、
offline replay 和 behavioral stub。两个离线结果不代表在线模型行为改善。

更新后 aggregate fingerprint：
`9e2a08963e92db56c4950bb2c84881184a7ea354a14d6da884855419c9fb6d3b`。
原 reference 和两份运行产物的备份分别保存在
`.vibe-harness/backups/2026-10-27T15-53-15-711Z/`、
`.vibe-harness/backups/2026-10-27T15-53-25-311Z/`、
`.vibe-harness/backups/2026-10-27T15-53-26-099Z/`。

## 在线行为验证限制

修改前条件指纹已保存在
`.vibe-harness/tasks/split-push-repair-baseline.json`，但没有不可变的旧版本模型执行基线，
前后行为比较为 blocked。

修改后使用同一 `EVAL-GIT-DELIVER-013` 执行三轮，runner 原始结果为
`ready` 且隐藏检查 0/3 通过，原始失败不覆盖、不计为通过。
另一次诊断复验仍未通过，返回 `mode-restricted` / `tool-error`，
三个工具调用、零交付范围文件变化；准备步骤首次写 `.git/config`
即遇到 `Read-only file system`，没有进入提交修复流程。
因此在线执行环境证据为受阻，不能证明或否定提交修复流程的模型遵循效果，
也不能声称成功率、交互次数或耗时已改善。
没有修改 runner 的分类逻辑或放宽 sandbox。

三轮摘要和诊断摘要分别保留在
`.vibe-harness/tasks/split-push-repair-online.json`、
`.vibe-harness/tasks/split-push-repair-online-diag.json`；
普通摘要不保存 transcript、命令输出或凭据。
