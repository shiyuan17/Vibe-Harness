# Phase 1：可靠性域独立审查（2026-09-25）

## 结论与边界

- 基线：`98a9d52585e8cfe4692e8f81810b075cd8643dc6`；读取 Phase 0 基线及所属路径清单，不读取其他 Phase 1 输出。
- 范围：worktree/port、file transaction/install-state、Hook bootstrap/envelope 的失败、隔离、重试与宿主边界；不审 Anchor 内容、调度、验证完成判定。
- 发现 **4 条根因级问题**，均有源码关系链和本轮隔离 fixture 观察；暂列 P1。R1/R3 涉及数据丢失，按用户“P0 包含数据风险”的口径，应由 Phase 2 优先复核并决定是否上调，不能因暂列 P1 淡化影响。
- 改动仅本报告。正式聚焦测试 5/5 通过；这些通过不覆盖本报告列出的反例。临时内联脚本属于探索观察，不是项目注册 Micro 或正式完成收据。
- `codebase-memory status --project . --json` 返回 `runtime-not-installed`。使用 CodeGraph；遇 pending-sync 标记仅补读指定源码片段，未重做全仓搜索。源码未产生 Git diff。
- 未联网、未安装、未触碰用户 worktree、未执行产品修复。所有探索写入/提交/清理仅在新建的系统临时目录 `vh-reliability-observation-*`，清理前校验绝对路径归属。

## 关键机制五问

五级状态使用基线定义：已实现、部分实现、仅规范定义、缺失、无法确认；“已实现”是源级结论，不等于宿主端到端证明。

| 关键机制 / 状态 | 解决什么？ | 删除后的后果？ | 更简单替代？ | Agent 能稳定执行吗？ | 能机械验证吗？ |
|---|---|---|---|---|---|
| Worktree bootstrap、依赖 overlay / 部分实现 | 并行源码隔离、复用依赖、绑定本地包到本 worktree。`run.mjs:1242` 的 `linkDependencyRoot` 与 `:1702` 的复用分支可执行；审计 `worktree-audit.mjs:239` 明确报 `WORKTREE_INSIDE_REPOSITORY`。 | 直接删除会回到手工 `git worktree add`、手工配置依赖；真实并行写入隔离会更难，不建议整体删除。 | 简单任务不启用；复用既有 worktree 时只检查/补齐，不复用“新建失败即删除”的补偿路径。 | 正常重试有测试；失败重试目前不稳定，R1 可删除先前工作。环境路径范围另见 R4。 | 可以：正常复用、失败复用、未提交文件、用户分支、异名分支分别作 fixture。现有正常复用测试通过，不证明失败重试安全。 |
| Port registry 与独占锁 / 已实现（不宣称完备） | 同一 registry 内分配不重号端口块。`run.mjs:1388`：`openSync(lockPath, 'wx')`；`:1751` 在锁内重读并写 registry；`worktree-ports.mjs:184` 拒绝已登记端口冲突。 | 多进程读改写竞态重新出现；不应简单去锁。 | 没有并行服务时不启用；保留一份 registry 和窄临界区，不另建端口调度服务。 | 正常同 task 复用可执行；锁等候有 5 秒上限。`:1398` 明说 `the lock is never removed automatically`，崩溃后的自动续跑能力不能据此声称存在。 | registry 冲突、并发和复用可 fixture 验证。本轮只运行复用用例，未验证真实端口 bind、进程异常中断或所有宿主。 |
| 文件事务与 install-state / 部分实现 | 快照目标、失败恢复、互斥写入、持久安装归属。`file-transaction.js:200`：`records.push(await snapshotPath(...))`；`install-state.js:95` 校验 schema、`:131` 调用 `renameAtomic`。 | 多文件安装部分完成与状态失配更难恢复；不能因发现问题直接删除事务。 | 保留单一未完成事务门：先解决旧 journal，再允许新写入；删除“只破锁就继续”的隐式恢复。 | 正常 rollback/recover 可执行；跨进程退出后继续新事务再 recover 存在 R3。 | 可以用真实子进程退出、一次新提交、一次恢复验证顺序；不需要完整安装矩阵。 |
| Hook runtime 与 bootstrap / 部分实现 | 宿主事件适配、缺 runtime 拒绝、危险写入拒绝、限制环境泄漏。`codex-hook.mjs:205` 在预算到期生成失败决策；`hook-bootstrap.cjs:1` 有 `timeout:8000` 和缺入口拒绝。 | 直接删 bootstrap 会丢失缺 runtime 的统一拒绝和环境清洗；删 Hook 会丢失可观察调用上的补充保护。 | 保留一层 bootstrap、一个明确的宿主控制变量合同；不要增加第二套权限推导。 | 直接 evaluator 和安装链路不等价，R2 会丢失宿主只读权限预设；不能只凭直接 evaluator 测试声明安装后生效。 | 能比较同一事件、同一环境在直接 runtime 与实际 bootstrap 下的结果；本轮已观察差异。真实宿主是否加载仍无法确认。 |
| Execution Envelope v1/v2 / 部分实现；真实宿主证明无法确认 | 绑定 effect、session、workspace、外部目标与高风险宿主声明。`execution-envelope.mjs:869` 检查 session；`:747` 比较 Git/worktree 身份；`:800` 要求 `host.source === 'host'`、`process === 'isolated'`。 | 删除会失去跨工具的范围收窄；只靠自然语言不足以替代确定性检查。 | 保留普通低风险低摩擦路径和高风险 fail-closed；不把合同字段当 OS 隔离器，不另建 Agent 自签证明系统。 | 给定可信宿主注入，判定可确定执行；仓库不能证明实际 sandbox、批准链或未暴露远程工具。v2 不能弥补 bootstrap 先丢掉的预设。 | schema/effect/身份拒绝可 fixture 验证；宿主强制面须宿主证据，不能由仓库文字或 JSON 自称补齐。本轮不对外部宿主作通过判定。 |

## R1：复用既有 worktree 的失败路径删除了非本次创建资产

**问题 / P1（数据风险，Phase 2 优先定级）**

正常再次 bootstrap 会复用路径；但后续任一步失败，回滚没有区分“本次创建”与“此前已存在”。这不是只丢弃未完成的新环境，而可能丢失已存在 worktree 的未提交内容。

**证据与原文**

- `runtime/commands/run.mjs:1702`：`const existing = entries.find((entry) => !entry.primary ...`，按路径查找既有 worktree。
- `runtime/commands/run.mjs:1722`：`if (!existing) {` 才执行 `git worktree add`；因此 `existing` 路径确实进入同一后续流程。
- `runtime/commands/run.mjs:1780`：`setup = await runSetupCommands(...)`；下一行遇错误抛出。
- `runtime/commands/run.mjs:1802`：`await runGit(['worktree', 'remove', '--force', plan.worktreePath], projectDir);`，catch 没有 `!existing` 条件。
- `runtime/commands/run.mjs:1807`：`const branchDeleted = untouched && ...`；只比较 branch HEAD 与 base，不证明该分支由本轮创建。
- 对照测试：`tests/integration/project-worktree-command.test.js:298` 只测“同一 task 重复 bootstrap 复用既有端口块”；`:400` 测“setup 命令失败时回滚 worktree、分支与端口登记项”。本轮两项均通过；缺少二者组合。

**五级实现状态**：部分实现。新建失败补偿、正常复用存在；复用后的失败资产归属没有闭合。

**触发与本轮观察**

在全新临时 Git 仓库成功 bootstrap TASK-1 → 在该 worktree 写未提交 `user-unsaved.txt` → 主 checkout 设置 `setupCommands: ['node missing-setup.mjs']` → 同 task 再次 bootstrap。观察：

```json
{"firstStatus":"passed","retryStatus":"failed","rolledBack":true,"treeStillExists":false,"userFileStillExists":false,"branchDeleted":true}
```

**根因**：新建事务的补偿逻辑无条件用于复用流程；注释 `remove what this run created` 未转化为资源归属判定。

**影响**：可把一次可重试 setup 失败放大成同 worktree 未提交内容丢失；Agent 只看到 `rolledBack: true`，不能据此推断此前资产安全。没有证明任意正常 bootstrap 都会丢数据。

**最小改进**：失败时只删除本次明确创建且未被使用的资产；既有 worktree 默认保留并报告失败。优先删除不当补偿分支，不增恢复规则或人工流程。新增“复用 + 脏内容 + setup 失败”回归，用目录、文件内容、分支仍存在作断言。

## R2：bootstrap 的环境清洗删掉宿主权限预设

**问题 / P1**

runtime 将宿主 `VIBE_HARNESS_PERMISSION_PRESET` 视为角色权限上限，但实际 bootstrap 的环境白名单未传递该变量。直接调用的只读拒绝不能穿过安装启动链路。

**证据与原文**

- `scripts/lib/hook-bootstrap.cjs:1`：
  `const inherited=['PATH','PATHEXT','SystemRoot','SystemDrive','TEMP','TMP','HOME','USERPROFILE','CODEX_HOME','VIBE_HARNESS_EXECUTION_ENVELOPE','VIBE_HARNESS_EXECUTION_ENVELOPE_REQUIRED'];`
- 同行随后 `spawnSync(...,{env:env,...})`，子进程不是自动继承完整父环境。
- `runtime/hooks/codex-hook.mjs:139`：`const hostPreset = typeof environment.VIBE_HARNESS_PERMISSION_PRESET === 'string'`；`:147`：`const permissionPreset = hostPreset ?? settings.permissionPreset ?? null;`。
- `runtime/hooks/lib/role-permissions.mjs:22`：空/缺失 preset 返回 `null`；`:40`：`if (tier === null || tier === 'writable') return false;`。
- `tests/integration/hook-bootstrap.test.js:181` 测“passes only the allowlisted environment”，`:198`—`:200` 只断言 secret 不泄漏和 root 正确，没有核验宿主权限控制变量保真。

**五级实现状态**：部分实现。权限判定与清洗分别实现；接口组合缺一个必要控制字段。

**触发与本轮观察**

临时仓库复制当前 runtime Hook；父环境设 `VIBE_HARNESS_PERMISSION_PRESET=read-only`，项目未另设 preset、未配置 Envelope。对同一个 `Write` 事件只求 Hook 判定，不执行写工具：

```json
{"directExit":0,"directDecision":"deny / ROLE_PERMISSION_PRESET","bootstrapExit":0,"bootstrapDecision":{},"actualWriteExecuted":false}
```

**根因**：bootstrap 的正向环境合同与 runtime 消费的宿主控制面独立维护，测试只保护“该删什么”，没有保护“必须传什么”。

**影响**：依靠该变量的宿主角色收窄在 bootstrap 路径失效；若宿主自身还有只读 sandbox，它仍可能阻断真实写入，不能据此声称突破了 OS 沙箱。

**最小改进**：在现有唯一白名单中保留该控制变量，仍不传 secret；增加“只读 preset + 同事件 + 直接/包装入口一致”契约测试。不要取消清洗或新增另一套权限系统。

## R3：破陈旧锁后允许新事务，旧 journal 后续覆盖成功新状态

**问题 / P1（数据风险，Phase 2 优先定级）**

进程退出后的 lock 被下一次写入自动移除，但对应 active journal 仍可恢复。成功新事务清理自身 journal 后，无参数 recover 会选择旧事务，将后续成功内容恢复成更早 preimage。

**证据与原文**

- `scripts/lib/file-transaction.js:177`：`if (await lockOwnerIsStale(...)) {`；`:178`：`await rm(lockPath, { force: true, recursive: true });`；随后重新建锁，未恢复/终结旧 journal。
- `scripts/lib/file-transaction.js:200`：新事务从当时磁盘 `snapshotPath(...)`，所以可以建立在旧事务中断状态之上。
- `scripts/lib/file-transaction.js:226`：新事务写 `status: 'committed'`；`:227` 调 `releaseTransaction(...)`。
- `scripts/lib/file-transaction.js:124`：`await rm(transactionDir, { force: true, recursive: true });`，成功新 journal 不留作恢复顺序基准。
- `scripts/lib/file-transaction.js:290`：`transactions.filter((item) => ['active', 'recovery-failed'].includes(item.status))`；`:291` 默认选 `recoverable[0]`。
- `scripts/lib/file-transaction.js:295`—`:298` 仅在当前锁属于别的事务时拒绝；新事务已完成则无锁阻止旧恢复。
- `scripts/lib/file-transaction.js:92`：`await rm(targetPath, { force: true, recursive: true });`；`:97` 将旧 preimage 复制回来。

**五级实现状态**：部分实现。互斥和单事务恢复存在；“未完成事务 → 后续成功事务 → 再恢复”的持久历史约束没有闭合。

**触发与本轮观察**

临时文件初始 `original` → 子进程开启事务、写 `interrupted` 后退出（未 commit/rollback）→ 父进程自动破陈旧锁、开启新事务、写 `new-success` 并 commit → 调用无 id 的 `recoverTransaction({write:true})`：

```json
{"afterCommit":"new-success","staleJournals":["active"],"recoveredCount":1,"afterRecovery":"original"}
```

**根因**：把“持锁进程已死”当作“旧事务影响可忽略”，只恢复互斥可用性，没有先处理恢复日志的状态。恢复又没有校验当前文件是否仍是该事务拥有的失败状态。

**影响**：一次后来执行的正常恢复可能撤销更晚成功写入；上层 install/rollback/uninstall 使用同一事务原语，静态上可能承受该行为。本轮只验证原语，不声称完整安装生命周期已出现该损失。

**最小改进**：优先取消“破锁即新写入”的自动通道，发现未完 journal 先要求处理旧事务；若必须自动恢复，则在同一互斥边界内完成旧恢复后才允许新事务。恢复前校验资产归属/当前状态，不用多套恢复记录弥补。回归断言新提交状态不得被旧日志静默覆盖。

## R4：worktree 环境文件的“相对路径”校验不等于范围约束

**问题 / P1**

端口 env 文件只检查“不是绝对路径”，允许 `../`。写入阶段直接 `path.join(worktreePath, envFile)`，因此可写到指定 worktree 外。

**证据与原文**

- `runtime/commands/run.mjs:1107`：`... || path.isAbsolute(raw.ports.envFile)`，错误文案声称 `project-relative path`。
- `runtime/commands/run.mjs:1110`：`ports.envFile = normalizeSlashes(raw.ports.envFile.trim());`；该 normalize 不做父目录拒绝。
- `runtime/commands/run.mjs:1128` 对 `provision.envFiles` 同样只拒绝空串和绝对路径，这是静态旁支，未作本轮反例。
- `runtime/commands/run.mjs:1755`：`const envPath = path.join(plan.worktreePath, assignment.envFile);`；`:1757`：`writeFileSync(envPath, renderWorktreeEnv(...), 'utf8');`。
- 对照已有安全原语：`scripts/lib/install-state.js:235` 使用 `assertPortableRelativePath(...)`、`:236` 使用 `assertSafePathInside(...)`；不是整个项目没有路径安全能力，而是 worktree 分支未统一使用。

**五级实现状态**：部分实现。配置形状与绝对路径检查存在；规范化后的实际写入边界未强制。

**触发与本轮观察**

临时仓库配置 `worktree.ports.envFile: '../outside.env'` 后正常 bootstrap；生成文件在 fixture 内、worktree 外，未接触任何真实外部文件：

```json
{"status":"passed","envFile":"../outside.env","targetOutsideWorktree":true,"outsideFileExists":true}
```

**根因**：把路径语法校验当作授权范围校验；env 写入不重新核验最终路径。

**影响**：错误配置可在兄弟目录写入/覆盖文件，破坏多 worktree 隔离。配置本身可能由可信用户提供，因此这里不假定远程攻击者能改配置，也不声称 Hook/OS 沙箱已被绕过。

**最小改进**：删除局部重复且不完整的“相对路径”判定，复用一个运行时可用的 canonical containment 原语；读源、写目标分别绑定主 checkout/worktree，写前考虑符号链接。端口文件范围收紧不需要新增安全规则。回归覆盖 `../`、合法子路径、symlink 逃逸；后两者本轮未实测。

## 本轮验证记录

### 正式已有测试：passed

在仓库根运行，退出码 0；5 tests、5 pass、0 fail、约 2.7 秒：

```powershell
node --test --test-name-pattern='Hook bootstrap passes only|同一 task 重复 bootstrap|setup 命令失败时回滚|recover previews|recover refuses' tests/integration/hook-bootstrap.test.js tests/integration/project-worktree-command.test.js tests/integration/transaction-recovery.test.js
```

实际测试名：

1. `Hook bootstrap passes only the allowlisted environment to the managed runtime`
2. `同一 task 重复 bootstrap 复用既有端口块`
3. `setup 命令失败时回滚 worktree、分支与端口登记项`
4. `recover previews then restores the active transaction only with --write`
5. `recover refuses to release a lock owned by another transaction`

它们证明现有局部预期通过，不是对 4 项反例的反证；未运行全套、安装矩阵或真实宿主 E2E。

### 隔离探索观察：不是正式 Micro 收据

本轮实际执行 `@' ... '@ | node --input-type=module`，退出码 0，约 3.7 秒。以下保存该次脚本，供 Phase 2 按相同隔离边界独立挑战。预期用于观察反例，不应把“脚本成功退出”解释成产品验收通过。所有 Git 提交只在脚本新建的 fixture 仓库中。

```javascript
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beginFileTransaction, inspectTransactions, recoverTransaction } from './scripts/lib/file-transaction.js';
const sourceRoot = process.cwd();
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'vh-reliability-observation-'));
const runtimeEntry = path.join(sourceRoot, 'runtime/commands/run.mjs');
function git(cwd, args) {
  const result = spawnSync('git', ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
function invoke(args, cwd, options = {}) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', windowsHide: true, ...options });
  if (result.error) throw result.error;
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}
async function fixture(name, additions = {}) {
  const base = path.join(temporaryRoot, name);
  const repo = path.join(base, 'repo');
  await mkdir(repo, { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const config = { worktree: { root: '../trees', baseRef: 'main', dependencyRoots: [], ...additions } };
  await writeFile(path.join(repo, '.gitignore'), '.vibe-harness/\n');
  await writeFile(path.join(repo, 'vibe-harness.config.json'), JSON.stringify(config));
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'fixture']);
  return { base, repo, config, tree: path.join(base, 'trees', 'TASK-1') };
}
function bootstrap(repo) {
  const result = invoke([runtimeEntry, 'worktree', 'bootstrap', '--project', repo, '--task', 'TASK-1:feat/TASK-1', '--write', '--json'], repo);
  return { exitCode: result.exitCode, report: JSON.parse(result.stdout) };
}
try {
  const reused = await fixture('reuse');
  const first = bootstrap(reused.repo);
  await writeFile(path.join(reused.tree, 'user-unsaved.txt'), 'must survive failed retry\n');
  reused.config.worktree.provision = { setupCommands: ['node missing-setup.mjs'] };
  await writeFile(path.join(reused.repo, 'vibe-harness.config.json'), JSON.stringify(reused.config));
  const second = bootstrap(reused.repo);
  console.log(JSON.stringify({ observation: 'existing-worktree-failure', firstStatus: first.report.status, retryStatus: second.report.status, rolledBack: second.report.results[0].rolledBack, treeStillExists: existsSync(reused.tree), userFileStillExists: existsSync(path.join(reused.tree, 'user-unsaved.txt')), branchDeleted: second.report.results[0].branchDeleted }));

  const escaped = await fixture('escape', { ports: { envFile: '../outside.env' } });
  const escapeResult = bootstrap(escaped.repo);
  const outsidePath = path.join(escaped.base, 'trees', 'outside.env');
  console.log(JSON.stringify({ observation: 'relative-path-escape', status: escapeResult.report.status, envFile: '../outside.env', targetOutsideWorktree: !outsidePath.startsWith(escaped.tree + path.sep), outsideFileExists: existsSync(outsidePath) }));

  const txRoot = path.join(temporaryRoot, 'transactions');
  await mkdir(txRoot);
  const managedFile = path.join(txRoot, 'managed.txt');
  await writeFile(managedFile, 'original');
  const txModule = pathToFileURL(path.join(sourceRoot, 'scripts/lib/file-transaction.js')).href;
  const childCode = `import { beginFileTransaction } from ${JSON.stringify(txModule)}; import { writeFile } from 'node:fs/promises'; const tx = await beginFileTransaction({ operation:'interrupted', targetDir:${JSON.stringify(txRoot)}, trackedPaths:[${JSON.stringify(managedFile)}] }); await writeFile(${JSON.stringify(managedFile)},'interrupted'); console.log(tx.id);`;
  const interrupted = invoke(['--input-type=module', '-e', childCode], sourceRoot);
  if (interrupted.exitCode !== 0) throw new Error(interrupted.stderr);
  const nextTx = await beginFileTransaction({ operation: 'next-success', targetDir: txRoot, trackedPaths: [managedFile] });
  await writeFile(managedFile, 'new-success');
  await nextTx.commit();
  const afterCommit = await readFile(managedFile, 'utf8');
  const remaining = await inspectTransactions(txRoot);
  const recovery = await recoverTransaction({ targetDir: txRoot, write: true });
  console.log(JSON.stringify({ observation: 'stale-transaction-overwrites-new-commit', afterCommit, staleJournals: remaining.map(item => item.status), recoveredCount: recovery.recovered.length, afterRecovery: await readFile(managedFile, 'utf8') }));

  const hook = await fixture('hook');
  await cp(path.join(sourceRoot, 'runtime/hooks'), path.join(hook.repo, '.agents/runtime/hooks'), { recursive: true });
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'fixture-only', cwd: hook.repo, tool_name: 'Write', tool_input: { file_path: path.join(hook.repo, 'ordinary.txt'), content: 'fixture' } });
  const env = { ...process.env, VIBE_HARNESS_PERMISSION_PRESET: 'read-only' };
  delete env.VIBE_HARNESS_EXECUTION_ENVELOPE;
  delete env.VIBE_HARNESS_EXECUTION_ENVELOPE_REQUIRED;
  const direct = invoke([path.join(hook.repo, '.agents/runtime/hooks/codex-hook.mjs'), '--expected-event', 'PreToolUse'], hook.repo, { env, input });
  const bootstrapSource = await readFile(path.join(sourceRoot, 'scripts/lib/hook-bootstrap.cjs'), 'utf8');
  const wrapped = invoke(['-e', bootstrapSource, '--', '--expected-event', 'PreToolUse'], hook.repo, { env, input });
  console.log(JSON.stringify({ observation: 'bootstrap-host-preset-loss', directExit: direct.exitCode, directDecision: JSON.parse(direct.stdout), bootstrapExit: wrapped.exitCode, bootstrapDecision: JSON.parse(wrapped.stdout), actualWriteExecuted: false }));
} finally {
  const resolved = path.resolve(temporaryRoot);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('vh-reliability-observation-')) throw new Error('unsafe fixture cleanup target');
  await rm(resolved, { recursive: true, force: true });
}
```

完整观察输出：

```jsonl
{"observation":"existing-worktree-failure","firstStatus":"passed","retryStatus":"failed","rolledBack":true,"treeStillExists":false,"userFileStillExists":false,"branchDeleted":true}
{"observation":"relative-path-escape","status":"passed","envFile":"../outside.env","targetOutsideWorktree":true,"outsideFileExists":true}
{"observation":"stale-transaction-overwrites-new-commit","afterCommit":"new-success","staleJournals":["active"],"recoveredCount":1,"afterRecovery":"original"}
{"observation":"bootstrap-host-preset-loss","directExit":0,"directDecision":{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"[VIBE_HARNESS_POLICY:ROLE_PERMISSION_PRESET:61] 当前角色权限预设为只读（read-only），不允许任何写入，已拒绝。请在允许写入的角色或主会话中执行该操作。"}},"bootstrapExit":0,"bootstrapDecision":{},"actualWriteExecuted":false}
```

## 不计入问题的证据边界

- 未确认真实宿主 Hook 已加载、OS/容器是否隔离、外部工具是否受拦截；不能把仓库无法证明宿主事实本身算成产品缺陷。
- 未验证 kill/power-loss 中途 journal 原子性、Windows rename 降级的所有失败形态、端口是否已被无关进程占用；不从方法名推导这些能力已实现。
- 未审查 Anchor/验证收据的完成判定、Task DAG 调度或其他 Phase 1 输出；跨域最重要线索是“声明只读角色的宿主配置是否确实走 R2 的环境变量通道”，应由对抗轮确认实际影响面。
- 建议顺序是修资源归属和恢复顺序，再修控制变量与路径合同；不建议增加新角色、新审批阶段或新状态服务。
