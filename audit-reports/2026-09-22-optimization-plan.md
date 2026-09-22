# Vibe-Harness 优化执行方案（P0+P1 全 8 项）

批准日期：2026-09-22。依据同日架构审查报告（audit-reports/2026-09-22-architecture-review.md）整改清单第 1-8 项。P2 两项（#9 eval 收敛/run.mjs 拆分/envelope v1 退役、#10 其余项）为明确非目标，另批规划。贯穿原则：简单>复杂、可执行>完整描述、证据>推测、自动化>人工约束、低成本>仪式化流程。

## 交付策略：仓库自带 worktree 生命周期（dogfood）

用 run.mjs 自身的 worktree 命令完成"新 worktree 分支 → 完工合并回来 → 删除分支"：

1. 先无 --write 出 plan 作证据，再执行：
   `node .agents/runtime/commands/run.mjs worktree bootstrap --task p0p1-optimization:codex/optimization-p0p1 --project . --base-ref codex/governance-audit-batch --write`
   - 必须显式 --base-ref codex/governance-audit-batch（默认 baseRef 是 origin/develop，本仓库不存在，run.mjs:928）
   - bootstrap 自动 junction 链接 node_modules（仓库根依赖除外，需补 pnpm install）
2. worktree 内 .vibe-harness/ 为空（gitignored）→ 从主检出复制 install-state.json（同提交、相对路径、内容哈希一致）+ validate 确认 ready
3. 全部批次验证通过后：主检出 `git merge --no-ff codex/optimization-p0p1` 合回 codex/governance-audit-batch
4. `run.mjs worktree cleanup --task p0p1-optimization --base-ref codex/governance-audit-batch --write`（cleanup 拒绝未落地分支，合并后自然放行），最后 `git branch -d codex/optimization-p0p1`

## 步骤 0：锚点与落盘

- `git status --short`（主检出仅 .zcodeignore 未跟踪，属预期，批次 C 入库）
- 长任务锚点：worktree 内 `run.mjs task init p0p1-optimization --project . --write`（risk-level: full）
- 审查报告与本方案落盘 audit-reports/，作为首个提交

## 批次 A：P0 解释器间接写红区绕过修复

**问题**：write gate（runtime/hooks/lib/policy.mjs:378-379）只采集 shellWritePaths（重定向 + cp/mv/rm/tee/truncate 操作数）；node -e/python -c 内联代码与 sed -i 的写目标不进 candidates，.env、vibe-harness.config.json、项目 .codex/config.toml、.github/workflows/ 等红区路径与项目外写入可绕过 RED_ZONE/CONTROL_PLANE_WRITE/PROJECT_BOUNDARY。

**改动（policy.mjs）**：

1. 新增 interpreterWriteTargets(command)：识别 node -e/--eval、python/python3/py -c、perl -e、ruby -e、php -r、deno eval、sed -i/--in-place、awk -i inplace；sed/awk 提取文件操作数（精确目标）；解释器内联代码提取引号内路径样字符串（绝对路径、含 / 相对路径、文件名.扩展名、红区 basename 如 .env）
2. 合并进 write gate：shellTargets = [...shellWritePaths(command), ...interpreterWriteTargets(command)]，下游判定链不动
3. ROLE_PERMISSION_PRESET（:428-434）：read-only 预设下任何解释器内联代码直接 deny

**测试**（每批次新增用例后 `pnpm tests:catalog sync --write`）：

- tests/integration/hook-runtime.test.js 负控：node -e 写 .env → deny RED_ZONE；python -c 写 vibe-harness.config.json → deny；sed -i 改 .codex/config.toml → deny CONTROL_PLANE_WRITE；node -e 写 /etc/hosts → deny PROJECT_BOUNDARY；read-only 预设 + node -e → deny ROLE_PERMISSION_PRESET（具体 code 按 CONTROL_PLANE→BOUNDARY→RED_ZONE 链序断言，deny 为硬断言）
- 正控防过度拦截：node -e "console.log(1)"、node -e "console.log('docs/README.md')"、node scripts/build.js、sed -n 's/a/b/p' file.txt、python scripts/x.py 均 null
- tests/component/hook-read-only-classification.test.js：interpreterWriteTargets 单元级用例

**安装刷新**：源≠安装副本 → install --project . --write --confirm-red-zone（刷新 .agents/runtime/hooks/lib/policy.mjs 红区文件）+ validate --project .

**批次验证**：`pnpm test:unit && pnpm test:component && pnpm test:integration && pnpm eval:check && pnpm tests:catalog check`

## 批次 B：CI 效率与信号（#7+#2+#3）

**#7 skills:audit 3 次→1 次**：删 .github/workflows/ci.yml:149-150（fast-gate 条件步骤）与 :218（supply-chain 无条件步骤）；保留 lint.js:11 内嵌（随 check:fast/check:full 所有路径恰好 1 次）。联动跑 tests/integration/eval-ci.test.js(:12,112) 与 tests/component/check-fast-tier-alignment.test.js(:11,61)（断言 ci.yml 内容；删步骤不删 job，预期仍过，失败则同步更新断言）。

**#2 独立评审收据遥测**：scripts/independent-review.js 输出 GITHUB_STEP_SUMMARY markdown（mode/status/risk level/evidence codes/receiptId），stdout JSON 不变；CONTRIBUTING.md 补 shadow→required 切换标准（连续 14 天/最近 20 个高风险 PR 无 REVIEW_FINGERPRINT_STALE/SAME_IDENTITY degraded 且收据率>80% → ci.yml independent-review job 注入 VIBE_HARNESS_INDEPENDENT_REVIEW_MODE=required）。

**#3 记忆新鲜度检查**：新增 memoryFreshnessViolations helper（与 validateMemoryEntry 分离，starter 模板占位日期不可解析）：比对 .agents/memory/CURRENT.md 与 docs/memory/PROJECT_STATE.md 的"最后更新"与 HEAD committer date，超 1 天宽限即违规。新增 tests/component/memory-freshness.test.js（沿 memory-entry.test.js 模式校验真实仓库文件）。顺序：本批次同时把两份记忆文件新鲜化（当前停在 09-19 vs HEAD 09-20，接入即红），收尾批次再按最终状态更新一次。

**批次验证**：`pnpm test:integration && pnpm test:component && pnpm eval:check && pnpm check && pnpm tests:catalog check`

## 批次 C：治理内核与锚点（#4+#6+#8）

**#4 Fast Path 卡片**：docs/rules/governance-core.md 顶部插 ~12 行卡片（默认循环/档位判定/升级触发/硬边界速查/锚点触发/验证档位），后接"以下为完整规则"分界；:14-19 成本与升级节改引用卡片。scripts/lib/template-renderer.js buildStartupLines(:100) 第 1 行改分层加载指令（"先读 Fast Path 卡片；仅当任务超出快速档或命中升级条件时读全文"）。重新渲染 AGENTS.md，跑 documentation.test.js 文档一致性用例并修复断言。

**#6 失败登记**：run.mjs 锚点 schema 增 failures[]（{at,text}，按 text 去重）；task update 增 --failure 可重复参数；task status 的 resumeHint 在 failures 非空时展示最近失败（anchorSignature 只排除 updatedAt/sessions，自动覆盖）。governance-core.md:25 字段清单同步。tests/integration/project-task-command.test.js 新增用例（init 空 failures/--failure 写入/去重/status 提示）。

**#8 unknown 预分类**：scripts/lib/verification-plan.js GROUP_RULES config 组补 .zcodeignore/.gitignore/.npmrc/.nvmrc/.editorconfig 等根 dotfile；HIGH_PATHS 补 .zcodeignore；tests/unit/verification-plan.test.js 新增"仓库根实际文件永不为 unknown"静态测试（枚举根文件逐个断言，倒逼补齐规则如 LICENSE）。.zcodeignore 入库（内容已核验为标准宿主忽略清单）。

**批次验证**：`pnpm test:unit && pnpm test:component && pnpm test:integration && pnpm eval:check && pnpm docs:audit && pnpm tests:catalog check` + install --write 刷新 + validate --project .

## 批次 D：Hook 覆盖矩阵显式化（#5）

scripts/lib/runtime-diagnostics.js 新增 HOOK_ACTIVATION_UNSUPPORTED 警告码：adapter.hookActivation==='unsupported'（gemini/opencode，manifests/adapters.json:47/:138）且 hooks 组已安装时按宿主归因，install/validate/doctor 报告透出。tests/matrix/tool-provisioning.test.js:1612-1615 deepEqual 断言联动更新。docs/hooks.md 宿主矩阵同步标注"hook 机制不支持，仅安装文件不激活"。

**批次验证**：`pnpm test:integration && pnpm test:matrix -- tests/matrix/tool-provisioning.test.js && pnpm tests:catalog check`

## 收尾批次

1. 记忆最终新鲜化：CURRENT.md/PROJECT_STATE.md 的最后更新/最后验证/锚点提交（本批次 HEAD 祖先）——#3 检查器自证通过
2. CHANGELOG.md 补记本批次
3. 锚点 task update → stage: verify，记录验证证据，nextAction 指向合并
4. 全量门禁：`pnpm check`（=check:full）+ `git diff --check` + `pnpm eval:check`
5. 合并与清理：主检出 `git merge --no-ff codex/optimization-p0p1` → `worktree cleanup --task p0p1-optimization --base-ref codex/governance-audit-batch --write` → `git branch -d codex/optimization-p0p1`

## 风险与对策

- **批次 A 改 deny 链**：负控+正控双向测试防过度拦截（正控覆盖 node/python 日常脚本路径，避免误伤正常开发流）；eval:check 防 eval reference 指纹漂移
- **install --confirm-red-zone 刷新红区**：刷新前后 validate 对比，diff 限预期文件
- **ci.yml 断言测试**：4 处引用，2 处断言内容，逐个跑通才提交
- **每批次一个逻辑提交**，锚点 units 与提交一一对应，失败登记（#6）在实施中即时 dogfood

## 非目标（本轮不做）

#9 eval 体系收敛/run.mjs 拆分/envelope v1 退役；hooks.json 宿主白名单扩 gemini/opencode（需宿主能力支持）；evals.yml 优化（保留 30 天 retention 现状）。
