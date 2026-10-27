# Git worktree 协作优化实施记录

状态：A–D 实现、安装副本和本地回归已落地；性能未达到启用条件，复用保持关闭。
受保护 Eval 指纹与外部验证仍未完成，不能发布。未提交、未推送、未修改服务器规则。

## 实施范围

| 交付组 | 已实现行为 | 主要入口 |
| --- | --- | --- |
| A | 去除独立审查/人工批准 CI job；保留 product、merge-gate、安全扫描和自动质量检查；共享风险分类及交付检查选择 | `.github/workflows/ci.yml`、`runtime/lib/verification-risk.mjs` |
| B | 候选独立身份、端口、命名空间和缓存；成对 setup/teardown；具体资源锁；依赖隔离；外部集成与正常发布统一清理 | `runtime/lib/candidate-resources.mjs`、`check-resources.mjs`、`worktree-command.mjs` |
| C | 原生 Hook 完整参数/stdin、精确 SHA/ref、本机认证单次证明、完整依赖内容和环境指纹、v6 缓存；证明失效在队外补证 | `runtime/hooks/git-hook.mjs`、`runtime/lib/push-verification.mjs`、`verification-inputs.mjs` |
| D | 全图严格诊断与节点派发分离；局部冲突不清空无关 ready；10 分钟且 15% 门槛与 20% 缓冲；Linear/Git/资源事实归属收敛 | `scripts/task-dag.js`、`runtime/lib/linear-planning.mjs`、相关规则和 Skills |

保留上一轮三项修复：无关候选不被误取消；affected 范围绑定冻结基线；
环境失败重试沿用未变候选。只对本轮相关文件增量修改，保留原有 Memory、
schema 与 `.claude/` 内容；没有自动建 Linear Issue、派发 Agent 或新增
常驻调度/审批服务。

## 契约与恢复

- CLI 新增 `task-dag check --node <id>` 和 `worktree cleanup --batch <id>`；
  后者默认 dry-run，写入须 `--write`。
- v5 事务保留终态，正常发布和外部已集成都回收源与候选；源 HEAD、脏状态、
  资源归属或服务停止不明时保留为 `integrated_cleanup_pending`。
- 资源日志放在 Git common dir，先记意图、再执行、再记成功下标。外部命令
  必须按工作区 ID 和步骤键幂等，不能承诺任意数据库命令恰好执行一次。
- 超时或崩溃后无法证明检查进程树停止时，具名资源占用保留，仅阻塞相关
  检查。需要项目环境确认停止后才能恢复该资源，不能因 PID 死亡自动放行。
- 依赖安装、锁文件变化和写依赖检查使用独立目录；默认不将未知共享目录
  视为不可变。项目声明的 setup 负责按最终候选 lockfile 准备依赖。
- 缓存 v6 不接受缺少新输入指纹的旧记录。环境白名单不再隐藏仍传给检查的
  变量。只有显式 deterministic 的检查能复用；跨工作区还须完整输入一致。
- 受管证明只支持同机同用户；精确对象、目标、配置、依赖、环境或运行器
  改变都使证明失效。普通多 ref 推送按 SHA 合并全部目标差异后验证一次。
- 收尾负控复现了“检查结束后、证明签发前输入变化仍被签发”的缺口。
  现已将签发时输入与原验证收据的 execution/environment 指纹逐项核对，
  并让证明消费共用验证器的工具链指纹。已知好样本仍能签发，环境或依赖
  字节变化返回空证明；篡改、目标错配和重复消费的原有负控继续通过。
  同次证明核对复用已采样 HEAD/status，并按该不可变 SHA 解析 tree。
- Hook 单独安装现在自动包含 project-scripts 依赖，避免安装成功但原生
  Hook 因缺模块无法启动。

## 自动验证证据

| 验证 | 当前结果 |
| --- | --- |
| `pnpm check:fast` | 201 项单元测试通过，语法/资产扫描与 typecheck 通过 |
| `pnpm check` 最终组合运行 | 201 单元通过；358 组件中 353 通过，5 项因受保护 Eval reference/behavioral 指纹漂移失败 |
| 完整 `pnpm test:integration` 最终运行 | 779 项：776 通过、2 失败、1 跳过；两项后续定向复验通过，详见下文 |
| 新协作与缓存回归 | 最终 46 项通过，包含远端高风险重建与证明签发前输入漂移的正反控 |
| DAG 与并行成本模型 | 29 项通过，包含两个阈值边界与协调成本反例 |
| 安装 E2E/adapter matrix 子集 | 73 项中 72 通过，1 项安装副本瞬时漂移；该项定向复验通过 |
| `pnpm smoke:lifecycle` | core 与 full 生命周期全部通过 |
| `pnpm validate`、`pnpm docs:audit`、`pnpm skills:audit`、测试台账 | 通过 |
| `git diff --check` | 通过 |

完整 integration 首次失败包含执行期间源码/安装副本漂移、旧缓存/候选清理
契约断言、rename 两端范围变化，以及服务健康检查超时。定向复验保持原行为
断言或按明确的新契约更新：不会为消除失败降低必要验证。

最终完整运行日志为 `.vibe-harness/worktree-integration-final.log`。两项失败：

1. `project-task-command` 的帮助文本仍断言 `reused by default`，与已确认的
   新条件冲突。改为断言显式 deterministic、认证、完整输入匹配与 no-reuse，
   `.vibe-harness/task-help-green.log` 通过。
2. `delivery-lifecycle` teardown 返回 `blocked / cleanup-timeout`，
   `.vibe-harness/teardown-final-recheck.log` 单独复验通过。没有修改服务实现、
   放宽超时或删除断言；Windows 负载下偶发超时仍是限制，不能声称已修复。

1 项跳过是显式 opt-in 的真实 Codex runner smoke。最终完整运行并非全绿；
以上结果与定向复验分别保存，不能合并成“一次全部通过”。

收尾证据位于 `.vibe-harness/proof-creation-red.log`（真实失败）、
`proof-creation-green.log`（3 项通过）、`proof-final-regressions.log`（46 项通过）、
`worktree-fast-final.log`（201 项通过）和 `worktree-validate-final.log`
（源码与安装副本一致）。索引覆盖报告显示新文件未索引、既有文件已变化；
实现结论使用当前源码及执行测试，不以旧图索引证明完整覆盖。

Eval reference 在本轮开始前已有 config/rules/skills 漂移，本轮又改变
Hook/规则/配置。没有覆盖 reference 或 behavioral 产物使测试变绿。
因此 `check`/`eval:check` 仍不满足发布条件，不宣称全部自动门禁通过。

## 性能试验

固定 U0 保存的 runtime 基线、同机 Node 工具链和相同临时 Git/bare 远端
fixture。五类样本各五次，顺序运行，测量阶段暂停其他测试负载。脚本：
`node scripts/worktree-benchmark.js --runtime <runtime-path> --repetitions 5 --output <file>`。

性能脚本要求 stage 和 publish 真正成功，否则退出失败，不把失败路径
计作收益。输出原始检查计数、事件时间、队列等待/持有区间、候选 replay、
清理状态和证明创建/核对耗时。只报告中位数和最大值，不推算 p95。

最终对比数据见 [性能原始记录](2026-10-27-worktree-collaboration-performance.json)。
环境为 Windows x64、Node v24.21.0，fixture 检查本体 150ms、依赖目录为空；
耗时包含 stage 到 publish 结束，不含 fixture/bootstrap 和另行计时的清理重试。
旧版为 U0 固定的 runtime，新版为最终修复后的 runtime，各 25 个成功样本。
文件保存 runtime 与脚本摘要、每轮耗时、检查事件、队列时间和清理重试结果。

| 场景（各 5 次） | 旧中位数 / 最大值 ms | 新中位数 / 最大值 ms | 每轮检查次数：旧 → 新 |
| --- | ---: | ---: | --- |
| 普通小改动 | 5078 / 5219 | 8014 / 8461 | 2,2,2,2,2 → 1,1,1,1,1 |
| 两个独立任务 | 11232 / 11806 | 17506 / 17936 | 5,5,5,5,5 → 3,3,3,3,3 |
| 共享资源争用 | 11593 / 12717 | 18676 / 19911 | 5,5,5,5,5 → 3,3,3,3,3 |
| 远端基线推进 | 8652 / 9067 | 15212 / 16890 | 3,3,3,3,3 → 2,2,2,2,2 |
| 中断后恢复 | 11683 / 12586 | 14960 / 15817 | 4,4,4,4,4 → 3,3,3,3,3 |

中断场景的计数包括一次失败尝试，不能把该启动记为成功验证。独立任务和
共享资源场景中，第二次发布会因前一次集成而重建，所以第三次检查覆盖新组合树。

| 观测 | 最终结果 |
| --- | --- |
| 未变候选重复检查 | 普通场景每轮 1 次，stage → publish 没有重复启动 |
| FIFO 内检查启动 | 全部 25 轮为 0；旧版普通/基线/恢复每轮 1，双任务每轮 2 |
| 共享资源 / 独立资源并发峰值 | 每轮分别为 1 / 2 |
| 无关候选取消 | 全部 25 轮为 0 |
| 环境恢复额外重建 | 五轮恢复前后 replayCount 均保持 1，增量为 0 |
| 清理重试 | 35 次均无新增检查、重建或 push，远端 SHA 不变 |
| 清理终态 | 25 轮全部 integrated |

额外开销单独计量（中位数 / 最大值，ms）。以下为每轮最后一次保留的验证
和证明时点，不是全轮累加；旧版未提供对应字段，记为 unavailable：

| 场景 | 输入指纹 | 证明创建 | 队外证明核对 | FIFO 持有：旧 → 新 |
| --- | ---: | ---: | ---: | --- |
| 普通小改动 | 13 / 16 | 492 / 549 | 557 / 628 | 851 / 867 → 1246 / 1487 |
| 两个独立任务 | 12 / 14 | 561 / 621 | 570 / 577 | 873 / 1086 → 1241 / 1442 |
| 共享资源争用 | 13 / 15 | 517 / 550 | 559 / 612 | 882 / 1044 → 1319 / 1552 |
| 远端基线推进 | 13 / 16 | 560 / 657 | 618 / 743 | 856 / 877 → 1502 / 2110 |
| 中断后恢复 | 13 / 14 | 471 / 487 | 503 / 567 | 959 / 1145 → 1155 / 1435 |

本轮已去除证明核对内部重复的 HEAD/status 读取，但完整证据核对及资源
生命周期的总成本仍大于短检查节省的成本。FIFO 没有测试进程并不代表占锁
时间下降：Hook 仍需认证并核对输入，五组持有时间均上升。队列等待中位数
均为 2ms；本 fixture 顺序 publish，没有测量高竞争发布队列吞吐。

**性能验收未通过。** 本仓库 `verification.reuse.enabled=false`；保留精确
对象验证和资源安全，不恢复错误主检出验证。后续启用须针对真实项目的
依赖规模、检查时长及证明核对成本继续优化并重新比较；这些短检查样本
不支持真实项目提速主张，也不用于推算 p95。

## 迁移与外部验证边界

迁移详见 [协议说明](../docs/specs/worktree-collaboration-migration.md) 和
[ADR-0026](../docs/adr/ADR-0026-worktree-collaboration-evidence-and-resources.md)。

2026-10-27 通过 GitHub API 只读核对：main active ruleset 的 required checks
为 product 与 merge-gate，两者保留；develop ruleset disabled。没有执行
服务器规则变更，也没有新增 develop push CI。

仍需外部取得的证据：真实 GitHub PR/main CI、Unix 原生链接行为、项目真实
数据库/容器 setup/teardown、线上 Linear 回写恢复，以及经过独立确认的
Eval reference 更新。Windows 上的跨 adapter matrix 不等于 Unix 运行证据。
