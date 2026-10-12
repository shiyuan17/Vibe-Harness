---
name: lwflow
description: Use only when the user explicitly invokes lwflow or $lwflow to sync the current plan as a Linear parent and task DAG, then deliver only those tasks through isolated develop worktrees.
---

# Linear 计划交付

`lwflow` / `$lwflow` 只处理当前会话已确定的任务计划；不是普通 Linear 查询或自动领单。规范见 `docs/rules/linear-workflow.md` 的「显式 lwflow」及 `docs/rules/git-rules.md` 的「显式 develop flow」，修改须同步。必须有可写 Linear connector、宿主必需的 v2 执行证明及持久 provider 原子 Claim；缺一则停止，不伪造同步或领取。回退边界：Linear 只读、不可达或不能确认写入时不执行本模式，不转为未登记的本地执行。每次本地落地仅临时使用 `--delivery local-land`，不改默认交付配置。

1. 将计划映射为一个 `aggregate` Parent、必要的 read/write 子任务、Scope、验收、验证、共享合同 owner 与 blocked-by / blocks 原生依赖。先核对团队、仓库和计划边界；不能从计划推断的高影响决定先澄清。默认单 Agent、按 DAG 拓扑顺序执行；只有已有隔离证明与实际收益才并行。
2. 只对本轮要创建的 Parent/子任务与关系写入 Linear；每个非幂等写入均先读取并校验目标、使用稳定幂等键或写后重读核对 ID、Parent、字段及原生依赖。结果未知时按同一键查询，绝不盲目重建；记录本轮创建节点 ID 的封闭集合。创建失败或重读不完整时停止并保留已创建的节点清单。
3. 只从这个封闭集合中挑选满足依赖、Ready、Scope 和锁条件的节点；不扫描、轮询或领取其他 Ready/Todo Issue。领取前按 Linear 规则的顺序执行 provider 原子 Claim → Delegate → v3 Start Receipt → 重读确认；每次状态写入都“读取 → 校验 → 写入 → 重读确认”。部分登记或互斥缺失时 fail-closed。
4. 每个 write 节点从最新 `origin/develop` 建仓库外 worktree 与 `<type>/<ISSUE-ID>-<slug>` 分支，在该 worktree 会话根内实施与验证、提交 `Refs <ISSUE-ID>`，然后在干净 `develop` 主检出执行 `worktree land --write --delivery local-land --push`；具体预览、断言、验证、失败保留和推送后清理步骤遵守 Git 规则。read 节点只提交约定输出及 Verification 证据，不创建实现 worktree。
5. 仅当 write 节点具有最新基线的验证通过、no-ff 合并、`origin/develop` 推送成功及 worktree/分支清理证据时才标记该节点 Done；read 节点按约定输出与验证确认。所有必需节点成功后从已合并结果做 Parent fan-in 验证，再按状态协议更新 Parent。报告 Linear ID、Claim/Receipt、状态和 Git/验证证据。

本模式不创建 PR/MR，不操作 `main`。普通 closing PR 的 Done 语义保持不变。Linear 写入不可用、基线漂移、冲突、验证/推送/清理失败时保留现场和已创建 ID，停止当前节点及依赖后继；不把本地成功或未确认请求描述为 Done，不自动回滚或强制清理。
