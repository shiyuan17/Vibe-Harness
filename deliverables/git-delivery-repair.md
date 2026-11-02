# Git 交付与验证修复交接

范围：Vibe-Harness 源包；业务项目只读，单 Agent 实施。基线为 `42db80c`。交接生成时，修改保留在当前工作区；当时未执行真实提交、推送或业务部署。

## 已落地

| 验收能力 | 实现与边界 |
| --- | --- |
| 轻量拆分与范围 | develop-flow 建立验收—文件—关联输入—排除项—检查映射；小任务一个切片，不增加 DAG、worktree 或审批。实施路径与最终交付真实 diff 分开。Skill、默认提示、metadata 与常驻 Git 规则已同步。 |
| 冻结上下文与计划 | 显式 paths 优先，其次继承冻结上下文；无效上下文拒绝而非静默切换。只读计划不探测可执行程序、不建立认证键；缓存报告为待核对输入，而非虚构命中。执行前输出逐项选择、复用与原因。 |
| 原子复用 | workspace 与 tree-content 都逐检查复用。第 9 版缓存绑定完整代码、配置、依赖、工具链、环境与资源；保留 selection/tree 区别及前后独立快照。旧记录安全 miss；失败失效旧通过，不把例外写为通过。 |
| Git Hook | 共用精确推送目标解析；保留安全扫描，删除 shell Hook 重复空白检查。commit-msg 先验信息再 staged lint，index 改变使相关证据失效。pre-push 优先利用代表精确对象的工作区，必要才隔离；原生入口也拒绝未知／非祖先远端对象。 |
| split-push 质量例外 | 增加结构化 Git 正文记录、树/ref/检查绑定、提交后空审计 commit 支持及真实失败状态。限开发／任务功能修复分支，不扩展 stage/publish。Git 文本不是授权根；可信宿主签名校验与未授权、过期、保护分支、安全检查的拒绝已实现。 |
| 安装 | 同一实际变更判据用于红区预览、strict 判定及执行；无内容、权限、受管元数据变化的 no-op 不写文件或安装状态。计划后内容／源码变化拒绝；仅元数据变化仍按事务更新，不重写不变目标。 |
| 源码与部署 | 源包 validate 默认不要求实时自安装同步；显式 `validate --self-install`、项目安装一致性和 doctor 路径保留。临时安装、回滚、用户修改保护与 strict 安全合同继续验证。 |
| Eval | replay、check 及项目 CLI 执行入口区分新输入与判据。历史结果保留并标 stale；新输入沿用旧 oracle／阈值。权重等判据变化拒绝，runner/model/执行条件变化仍需要可比基线。离线结果明确不是 Agent 行为证据。 |
| 资源恢复 | 仅在自有进程树退出得到证明时释放超时锁；旧记录或未知归属不按 TTL 删除。传播关联 ID；保持 Windows 原生进程执行和现有精确远端对账／只恢复未完成动作的合同。 |
| 业务适配 | `BL-CNAS/validation-delivery.patch` 与迁移说明单独交付，不进入通用规则或安装表面。包含 changed 原子化、传感器输入映射、AST 页面断言及域内资源获取。 |

## 验证证据

以下为前阶段证据，不自动覆盖后续修改。新增长耗时修复的最终结果见下节；不为验证表述完整而重复执行此前不受影响的安装／Eval 矩阵。

- 最终快速层 `pnpm check:fast`：静态资产扫描、typecheck、205 项单元测试通过。最后安装判据去重后，另补相同 typecheck 和对应安装／strict 回归，不重放不受影响单测。
- Eval 相关三个文件的组合测试：45／45，通过旧判据新输入、判据变更负控、历史证据保留与运行受阻语义；online 文件使用测试替身，不是真实 Agent。
- 最终安装与 enforcement 组合：27／27，包含 no-op、元数据刷新、红区、strict owner-union、用户改动保护及事务回滚。
- Hook／验证复用／安装／Eval 的先前组合：169／171，两项失败分别为缺少查看工具登记及验证期间源码变化；对应精确复验均通过。后续安装最终回归单独执行，未将旧失败报告改写为全绿。
- 源包 `node scripts/validate.js` 通过，明确 `selfInstallStatus=not_selected`；文档审计、规则／Skill parity、包契约及临时自安装相关检查已执行。
- `pnpm tests:catalog check`：1504 条声明与台账一致。台账同步是机械生成，不替代测试。
- `pnpm lint:eslint`：0 error，300 warning；最终修改路径补 ESLint 检查无 error。
- `node scripts/eval-check.js`：当前 contract-replay passed，历史证据 stale，Agent 行为 unverified；没有重录 reference。
- `git diff --check` 通过。没有运行完整矩阵、业务前后端全量或真实远端推送。

## 两个长耗时会话的追加修复

固定样本：职称任务的 stage 命令耗时 2,958,837 ms（约 49 分 19 秒），publish 命令又耗时 3,132,889 ms（约 52 分 13 秒）；会话明确报告 publish 再执行约 41 分钟验证。培训任务曾等待另一个任务持有的后端资源。会话墙钟包含等待，不能全归因于测试，也不能据此声称优化后的真实耗时。

- 同一批次、候选、基线、ref 和完整输入匹配时，显式 transaction 的本地证据可供 publish 和原生 pre-push 消费；fresh、跨批次、输入变化和篡改仍拒绝。不可修复的签名／目标问题直接报错，不用产品测试尝试修复。
- 依赖指纹改为快照内物理节点与链接边图，循环依赖不会反复展开；前后仍独立读取完整内容。共享依赖模式不再固定禁止内容复用，变更真实依赖仍失效。
- 同资源等待者公平排队，无关前后端资源不互堵；新增执行输出字节与静默时长，明确“进程存活”不等于“验证有进展”。
- 修复验收时发现的预检记录类型漏登记、跨层去重把默认策略误置 fresh，以及别名策略在 CLI／推送证明中被原始声明覆盖的问题。
- 不适用原子项仍为 not_selected，不写通过缓存；适用项须有真实通过／复用，全空选择仍 unverified。推送证明单独保留未选项和原因，避免原子化后永久阻塞纯前端任务。
- 精确登记 `git -C <path> apply --check <patch>` 等只读形式；实际 apply、index 写入、混合参数和配置覆盖不因此放行。
- 当前业务适配为 `BL-CNAS/validation-delivery-v2.patch`：包含后端测试类范围、前端配置分组、共享依赖输出隔离和 transaction 配置。旧补丁保留，不同时应用。

本轮最终结果：

- 验证契约单元、只读 Hook 分类、验证一致性组合：75／75 passed。
- 交付事务、证明篡改负控、fresh 别名、适用性汇总、共享依赖失效、公平排队及 Git 环境的聚焦集成：10／10 passed。计数器断言证明对应固定候选发布未重放测试，不等于真实业务耗时测量。
- 业务隔离补丁范围回归：7／7 passed；生成器只读业务目录并生成 v2 产物。真实业务 `git apply --check` 仍被旧 Hook 阻止，适用性和业务测试保持 unverified。
- typecheck、源码 validate、docs audit（153 文档）、docs-sync 只读检查、台账 check（1517 条）、git diff --check passed。聚焦 ESLint 0 error、10 warning。
- Eval contract-replay passed；历史证据 stale，真实 Agent 行为 unverified。没有重录批准 reference。
- 受管安装 dry-run：37 个 user-modified、4 个 conflict；未执行写入。冲突目标为 `.agents/runtime/lib/parent-batch.mjs`、`worktree-delivery-queue.mjs`、`push-verification.mjs`、`candidate-resources.mjs`。预览还报告本地 Hook 状态和自检降级；这些元数据不能推翻本轮实际观察到的宿主拒绝，也不能证明修复已生效。

没有真实业务重放或真实 Agent 前后 Eval，不能给出性能提升比例或宣称正在运行的旧 Hook 已更新。交接生成时未提交、未推送，也未修改业务工作区。

## 尚未完成／不能声称

1. **自安装部署 blocked**：受管升级 dry-run 标记多份既有运行时／规则为 user-modified，其中也包括源仓库兼作安装目标的文件。未使用 force、手工覆盖或修改 install-state。当前运行的旧 Hook 仍可能误拦 CodeGraph／复杂只读包装；源包测试通过不代表当前宿主已生效。
2. **例外真实端到端 blocked**：当前没有已配置的可信宿主签名能力。单位测试证明签名与绑定的接受／拒绝，不证明当前宿主能签发授权。未自填宿主证明；只阻止依赖例外的动作。人类授权无需重新取得，缺的是宿主集成能力。
3. **业务补丁 unverified**：前阶段隔离范围回归记录为 4／4；业务源码保持只读，未在业务环境执行模板 AST 测试、typecheck 或套件。补丁适用性检查曾被旧 Hook 拒绝，应用前仍须核对真实业务 diff。
4. **真实 Agent Eval unverified**：没有同条件真实模型前后运行、交互次数或自然任务耗时样本，因此不宣称性能提升比例、授权确认零次已实测，或全部行为验收完成。
5. **远端 unverified**：没有真实提交／发布／远端确认；精确推送解析及拒绝回归不能替代实际远端结果。

## 后续安全执行

先核对自安装差异归属，将当前源文件与已安装副本逐项比较，再通过受管安装合并已确认的目标；不可用 force 覆盖未知改动。部署后运行一次无副作用宿主查询确认生效。例外交付需宿主独立 provision 签名信任，不由 Agent 创建证明。

业务补丁另在获授权的业务实施任务中按 `BL-CNAS/README.md` 应用、展开真实范围并补必要证据。回滚采用普通 revert 与受管安装，不改历史、不覆盖业务工作区。网络、清理、状态回写的恢复只处理未完成步骤。
