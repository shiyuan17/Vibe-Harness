# 服务状态机修复与复现证据

范围：`runtime/lib/services.mjs`、`runtime/lib/service-supervisor.mjs`、对应安装镜像、生命周期回归和测试台账。保留此前工作流修复，不修改 Git/Linear 远端状态。

## 冻结输入

本地证据目录为 `.vibe-harness/probes/service-state-20261028-01/`，已被 Git 忽略，需随交接单独保留；提交中的回归测试可独立运行，不依赖这个本地目录。

- `manifest.json`：采集时间、HEAD、环境、864 个冻结文件的 SHA-256。
- `snapshot/`：修复前 runtime、生命周期测试、项目配置与依赖声明。
- `fixed/`、`fixed-manifest.json`：最终验证通过后的相同输入面及证据摘要，共 872 个文件哈希；与本轮通过的源码哈希逐一核对，安装镜像另做相等性断言。
- `worktree.patch`、`status.txt`：冻结时已有改动，防止把前序修复归因于本次服务改动。
- `state-baseline.json`：实际命令和 IPC 时序，控制令牌已移除。
- `red-regressions.*`：在旧 runtime 上运行新增的七项状态回归，七项全部失败。
- `failed-fixture/`：快速退出场景的配置、脚本、脱敏登记与进程观测。
- 各次运行的 `*.json`：命令、退出码、源码和输出哈希；后续运行增加前后源码比较，变化即记为 `stale`。

冻结环境：Windows x64 `10.0.26200`、Node `v24.21.0`、Git `2.55.0.windows.3`、pnpm `10.33.0`；HEAD 为 `6c0b84d39c148be7e715c4e8c49d6f4a6fa7961c`。HEAD 不是唯一输入，必须同时保留脏工作区快照。

## 已确认的根因

| 失败链 | 源码位置 | 修复与判据 |
| --- | --- | --- |
| 子进程在身份握手中退出，异步启动延续仍发布 `running`；退出清理与启动争用状态 | `runtime/lib/service-supervisor.mjs`，`captureStartIdentity`、`finishStartupExit`、spawn/listen 回调 | 启动拥有初始化转换；异步边界重查退出与 phase，已退出只返回清理终态或 blocked |
| 停止期间仍回答 `running`；第二个 stop 被当作归属错误 | 同文件，`reapTree`、控制端点 status/stop 分支 | `starting → running → stopping → stopped/blocked`；并发 stop 共享回收 Promise，blocked 可重试 |
| 最后一轮成员采样尚未退出就授权删除目录 | 同文件，`sampleTree`、`reapTree` | 停止后不启动新采样，先等待在途采样回调并合并成员，再证明服务树消失 |
| 终态缓存伪装成无身份的 supervisor 回复，重复 stop 退回 `ownership-unproven`；恢复后旧 reason 残留 | `runtime/lib/services.mjs`，`request`、`stopEntry`、`serviceReport` | 缓存终态按记录身份在本地复验，不连接已释放端点；恢复成功清空 reason |
| Windows PowerShell 5.1 把 `@(ConvertFrom-Json $json)` 中的数组作为一个管道对象；多个成员的 pid 转换报错后脚本仍返回 0，活进程被读为空集 | 同文件，`WINDOWS_MEMBER_PROBE` | 先赋值再 foreach；真实多进程用例必须返回两个成员，错误身份必须被排除 |
| 成员或 CIM 查询的非终止错误被读为有效输出 | 同文件，两个 Windows 探针 | 将执行错误转为失败；成员查询只将明确的进程不存在视为缺失，其余异常返回未知 |
| teardown 跳过所有缓存为 stopped 的登记，绕开本地真实性检查；停止后又重复整树遍历 | 同文件，`teardownServices`、`reclaimTree` | 所有本工作区登记统一经 `stopEntry`；回收路径统一证明树与端口，删除已被其覆盖的第二次遍历 |

Windows 探针自身已经在观察/发信号前核对根起始身份，supervisor 不再先启动一个 PowerShell 重复查询同一身份。PID 复用保护仍由实际树探针负责；不通过延长产品超时解决重复工作。

## 实际证据与限制

修复前原有测试在冻结输入上分别取得 4/4、14/14 通过，不能稳定暴露原先的清理失败。随后新增回归在同一旧 runtime 上取得 0/7，快速退出用例实际复现 `EBUSY`。

失败夹具中服务根已不存在，supervisor PID 6508 和其 PowerShell 采样子进程 PID 16204 仍存活；`observation.json` 保存了父子关系、启动时间和命令。已核验并停止本次合成复现留下的 supervisor，保留了证据。该观测证明残留进程及其关系；未使用句柄工具将目录锁唯一归因于某个具体句柄。

继续核验发现成员探针问题：两个真实活进程被返回为 `[]`，注入的执行错误也返回 `[]`；两项断言先失败再修复。CIM 查询故障注入同样先失败：查询不完整却返回有效成员列表，而非未知。

初版状态修复取得 40/40，但日志中的探针错误暴露了证据缺口。探针修复后的一轮为 42/43，普通停止曾返回 blocked；当时断言没有输出 reason，不能唯一归因为超时。该次日志保留为 `green-lifecycle-final.*`，标签不代表通过，必须看 JSON 的退出码。后续补齐失败诊断并删除重复探针。批量 teardown 的伪终态绕过另有先失败证据 `red-cached-teardown.*`。

验证清单与最终结果记录在下方；中间通过不能代替最终代码结果。未实际执行 Linux/macOS、其他 Node 版本和在线模型评测；Windows 的采样不能完整捕获所有瞬时脱离父链的后代，端口仍有独立佐证作用。无法获得身份或完整进程证据时继续 blocked。

## 可重放入口

无需本地冻结目录即可运行提交中的回归：

```powershell
node --test --test-reporter=spec --test-timeout=120000 tests/integration/delivery-lifecycle.test.js
```

本机冻结证据完整性核对：

```powershell
node .vibe-harness/probes/service-state-20261028-01/verify-evidence.mjs baseline-01 baseline-services red-regressions red-members red-tree-probe red-cached-teardown
```

在修复后快照上重放（按需执行，交付前未重复运行相同输入）：

```powershell
node .vibe-harness/probes/service-state-20261028-01/run.mjs replay-fixed fixed .
```

在旧 runtime 上重放当前回归（预期非零；使用新标签，不覆盖既有记录）：

```powershell
node .vibe-harness/probes/service-state-20261028-01/run.mjs replay-old regression-baseline '已停止服务重试|已停止登记仍有活进程|teardown 不跳过|Windows 启动身份|已认证 blocked|同一 supervisor|Windows 停止期间|快速退出的启动失败|Windows 成员探针逐项|Windows 成员探针执行出错|Windows 树快照查询出错'
```

竞态用例通过身份采集屏障、采样屏障和 HTTP `/exit` 明确制造事件顺序；等待上限用于判断故障，不使用固定 sleep 作为成功证据。旧版重放可能保留合成进程；只允许按本次创建记录与 OS 起始身份清理，禁止按 `node.exe` 名称批量结束。

## 最终验证

| 检查 | 实际结果 |
| --- | --- |
| 生命周期完整文件，`green-release.json` | 44/44，无跳过；退出码 0，源码前后 `match` |
| 服务与清理聚焦回归，`green-converged.json` | 10/10；源码前后 `match` |
| 工作区清理、发布后重试、资源保留，`consumers-final.log` | 6/6，无跳过；仅使用本地合成仓库 |
| `pnpm check:fast`，`check-fast-release.log` | lint、typecheck、204/204 单元测试通过 |
| `pnpm eval:check`，`eval-check-release.log` | 契约检查通过；没有更新 Eval reference |
| `pnpm pack:contract`，`pack-release.log` | 1030 个文件，无错误 |
| `pnpm tests:catalog check --json`，`catalog-check-release.log` | 1487 声明与台账一致，errors/problems 为空 |
| 服务源码与测试的聚焦 ESLint | 0 error、3 warning，见 `eslint-release.log` |
| `git diff --check` | 通过 |

最终通过的源码 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `runtime/lib/services.mjs` | `442f040580875be866d192812c3333f4495ccd064bf57d12f3370904ccb76013` |
| `runtime/lib/service-supervisor.mjs` | `55cc24c0c9ed0ded24b5d634d969cd9a82525ed6c59776f1323c21bd695aae78` |
| `tests/integration/delivery-lifecycle.test.js` | `f505c70decc060f7174f8b57acce7c30cfd69fd14273e53abf9dcb58e12b4e92` |

本轮新增 11 项回归均先取得失败证据，再在最终完整文件中通过；旧有“服务自行退出”用例改用显式退出信号，不再猜测启动和退出耗时。保留所有失败尝试，不把重试通过当作此前失败不存在，也不据单次结果声称消除所有负载相关超时。

回滚范围仅为服务源码、对应镜像和本次新增回归；不要回滚冻结时已存在的其他工作流改动。证据包不随 pack 发布，交接时需单独保留本地证据目录。
