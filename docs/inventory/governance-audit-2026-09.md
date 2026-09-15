# 治理规范与工作流审计（2026-09）

审查日期：2026-09-15。基线：`d315874`（审计开始时的在制批次提交），其后 eval reference 重生成于 `24d143e`。处置提交：`d4bb676`（W1，P0 全部）、`ec2c2b1`（W2，P1 规范口径）、`aaf650a`（W3，P1 工作流补强）；W4 为本文与其配套治理。受众：Vibe-Harness 维护者。

本文含计数口径的条目均标注快照日期与再生成方式（规则见 `docs/README.md` 审计参考节）；正文判定保留审计时点的原始结论，处置状态以提交为证，不回溯改写。

## 结论先行

方向判断：Vibe-Harness 的核心设计——去仪式化（不设固定 Planner/Reviewer 门禁）、SSOT 意识、dry-run 优先、风险分级验证、「确定性护栏管确定性逻辑、eval 合同管非确定性行为」的分工——与业界实践一致，不需要推倒重构。

核心病灶：系统性「声明与实现漂移」。规范口径、资产清单、自安装状态三类资产依赖手工同步；凡未被 self-install-check 与 install-map 覆盖的领域，漂移静默累积而不触发任何门禁。本审计共识别 31 项发现：P0 6 项、P1 12 项、P2 路线图 10 项、接受 3 项。P0 与 P1 已全部处置（各节处置证据与提交链）；P2 只记录不执行，避免审计批次膨胀为无边界重构。

对照结论（细节见「业界最佳实践对照」）：安装面即真值、description 即路由真值、生成物再生成而非手工镜像、测试发现优于手工枚举、快照类文档带日期与再生成方式——五条实践里本仓机制骨架均已具备，缺口集中在守护覆盖面，而非机制缺失。

## 范围、基准与证据等级

### 审查范围

- 规则面：`docs/rules/` 全部规则文档，重点为 `governance-core.md` 执行内核与 `role-routing.md`。
- 角色面：`.agents/roles/` 多角色路由。
- Skill 面：原生与集成 Skill（`pnpm skills:audit` 口径）。
- 工具链三层：`scripts/`（仓库开发 CLI）、`runtime/`（pack 源）、`.agents/`（自安装投影）。
- 资产面：manifests、schemas 与 `docs/schemas/` 镜像。
- 门禁面：CI change-plan 分层、merge-gate、release-verify。
- eval 面：三层 eval 体系与 reference 指纹。
- 自安装状态：install-state 注册面与 self-install-check 守护范围。

### 证据等级

- 发现证据来自基线 `d315874` 时点的静态阅读与命令输出（dry-run、审计命令、聚焦测试）；文中行号为该时点位置，处置后的代码形态以提交 diff 为准。
- 处置证据为提交与处置后的聚焦验证；测试输出不在此重复罗列，收据汇总见「处置联动」。

## 业界最佳实践对照

| 实践 | 业界要点 | 本仓对照结论 | 落点 |
| --- | --- | --- | --- |
| AGENTS.md 约定 | 安装面即真值、保持简短；展示的配置必须等于执行的配置 | 受管块结构符合约定；typecheck 存在三处口径矛盾，违反「展示=执行」 | A-06 |
| Anthropic Agent Skills 指南 | progressive disclosure；description 是唯一路由真值，需要机械一致 | 结构已实现；description 标点存在双标准，且无机械校验兜底 | B-07 |
| 生成物防漂移 | 生成物用「再生成 + diff」守护，不做手工镜像 | self-install-check 已有但覆盖不全；docs/schemas 镜像与测试 fixture 各存在一处手工镜像实例 | A-01、A-02、B-11、C-10 |
| 测试发现优于手工枚举 | node:test 默认 glob 发现；保留手工清单时必须有登记守护 | package.json 手工测试清单无未登记检测，新测试文件会静默不跑 | B-08 |
| docs-as-code 快照治理 | 含计数的文档必须带快照日期与再生成方式，被取代即归档 | inventory 两份文档的计数互相矛盾且无日期口径（见本文「快照治理」处置） | W4 本批 |

## 快照基准（2026-09-15）

| 口径 | 数值 | 再生成方式 |
| --- | --- | --- |
| 原生 / 集成 Skill | 12 / 3（合计 15，扫描 clean、0 findings） | `pnpm skills:audit` |
| 规则文档 | 21 个 markdown | 枚举 `docs/rules/` 下的 `.md` |
| manifests / schemas / docs 镜像 | 8 / 27 / 16 个 JSON | 枚举 `manifests/`、`schemas/`、`docs/schemas/` 下的 `.json` |
| `pnpm check` | 376 项测试通过 | `pnpm check` |
| `pnpm test:integration` | 320 通过 / 1 跳过 | `pnpm test:integration` |
| eval 合同 | `pnpm eval:check` 通过 | `pnpm eval:check` |

## P0 发现与处置（W1，提交 `d4bb676`）

| 条目 | 发现与证据 | 处置 |
| --- | --- | --- |
| A-01 knowledge-coverage 三重漂移 | install-map 的 runtime-eval 组仅映射 protected-config 与 hidden-tests，`runtime/evals/lib/knowledge-coverage.mjs` 无条目；`.agents` 投影副本落后 pack 源（缺 lifecycleDecision、completionClaimStatus 字段）；`runtime/evals/observers.json` 的安装策略未决 | 补 install-map 条目并经自安装重新投影（`d4bb676` 中 `.agents/runtime/evals/lib/knowledge-coverage.mjs` 补齐 18 行）；observers.json 判定为 eval 治理资产、仅存在于 pack 源（见 E-03） |
| A-02 runtime 镜像零注册 | install-map 有 `runtime/lib` 与 `runtime/commands/run.mjs` 条目，但 install-state 零注册；根因是本仓库自安装的 resolvedModules 不含 project-scripts | 将 project-scripts 纳入自安装模块面并真实写入，由 self-install-check 持续守护；`tests/project-worktree-command.test.js` 的导入面为 dogfood 判据 |
| A-03 metadata.json 安装覆盖不统一 | 12 个原生 Skill 仅 2 个在 install-map 映射 metadata.json；frontend-design 的该文件在盘不在册，形成孤儿 | 统一为 12 个 Skill 全映射并重新自安装（`d4bb676` 新增 10 个 metadata.json 投影），消除孤儿 |
| A-04 孤儿投影资产 | `.agents/skills/browser-verification/`（SKILL.md 与 references/cli.md）与 `.agents/runtime/lib/rtk-environment.mjs` 在盘但无 install-map、无 install-state 依据；其能力组仅经 playwright 插件触达而 requestedPlugins 为空 | 落地为移除投影（`d4bb676` 删除两处投影）；pack 源 `skills/integrations/browser-verification/` 保留，由 skills:audit 记账、按插件请求安装 |
| A-05 杂项清理 | `scripts/lib/self-install-check.js` 注释中的大写 `AGENT_SKILL_ROUTING.md` 构成假路径，触发 CLEANUP_REFERENCE_MISSING error；`tests/tmp-legacy-archive-TPEBQ7/` 空目录遗留；`.codebase-memory` 索引指向 `f561d4a` 而非 HEAD | 注释改为不构成假路径的表述；空目录删除；`.codebase-memory` 按工具合同记录接受理由（见 E-02） |
| A-06 typecheck 口径三处矛盾 | AGENTS.md 手工节（「未接入」）、受管块（列出 typecheck）与 `vibe-harness.config.json` 的 `typecheck: null` 三处不一致；根因是渲染走 resolveValidationCommands 回填，而执行（`runtime/commands/run.mjs:318-327`）直读原值 | 统一两处解析路径；config 显式接入 `pnpm typecheck`；重新自安装刷新受管块并同步 AGENTS.md 手工节口径 |

## P1 发现与处置

### W2 规范口径（提交 `ec2c2b1`）

| 条目 | 发现与证据 | 处置 |
| --- | --- | --- |
| B-01 README 中英分叉 | `README.en.md` memory 模块措辞与中文版不一致；Profiles 节缺角色说明 | 对齐措辞并补齐说明（`README.md`、`README.en.md`） |
| B-02 role-routing 内嵌合同 | `docs/rules/role-routing.md` 内嵌的 Skill 选择合同与 `agent-skill-routing.md` 平行维护 | 改为指向单源的引用表述，保留一份权威排序 |
| B-03 ai-collab 单向指针 | Linear 状态映射表处缺 `linear-workflow.md` 回指，权威指针单向 | 补回指，形成双向可达 |
| B-04 task 模板语义复述 | `docs/templates/task.md` 复述 DAG result 状态语义，与权威定义漂移风险高 | 改为指针加字段名清单，正文不再复制语义（中英模板同步） |
| B-05 audit --kind all 语义缺失 | `audit --kind all` 不含 cleanup 的语义只在代码注释中存在，用户面文档缺失 | `docs/audits.md` 写明子命令集语义 |
| B-06 online eval 现状不可见 | onlineRunner 为 null、仅单一 offline reference，文档未声明该现状 | `docs/evals.md` 显式声明现状与处置决定，缺口从「不可见」变为「已声明的接受状态」（见 E-01） |
| B-07 description 标点双标准 | 12 个 Skill description 存在连字符与 em-dash 混用（clarify-requirements、frontend-design 为连字符） | 统一为 em-dash，同步 `manifests/skills.json` 与 SKILL.md frontmatter；eval reference 相应重生成 |

### W3 工作流补强（提交 `aaf650a`）

| 条目 | 发现与证据 | 处置 |
| --- | --- | --- |
| B-08 测试枚举无守护 | package.json 手工测试清单新增文件不登记则静默不跑，违反「测试发现优于手工枚举」 | 新增 `scripts/lib/test-enumeration.js`：lint 与 validate 将 glob 到的 `tests/*.test.js` 与清单比对，未登记即 fail；保留显式清单的可控性，不改为 glob 执行 |
| B-09 forbiddenProjectTerms 硬编码 | `scripts/lib/project-config.js` 硬编码 4 个先前项目词，违反 AGENTS.md 安全规则 4（项目专有标识不得进入通用核心目录） | 改为 project-config 可选字段（schema 校验与 docs 镜像同步）；4 个词移入本仓库 `vibe-harness.config.json`（唯一合法归宿）；redaction 测试改为双扫描——pack 目录全量扫描源项目词、config 只扫未声明词——并把声明集 pin 死，防止例外静默扩大 |
| B-10 worktree 双入口分工未文档化 | `scripts/worktree.js`（list/check/plan，开发面）与 runtime run.mjs worktree（list/check/bootstrap/cleanup，项目面）子命令集不同，用户无法从一处获知分工 | `docs/rules/git-rules.md` Worktree 节写明分工，两侧 `--help` 互指 |
| B-11 docs/schemas 镜像不对称 | `project-config.schema.json` 缺 docs 镜像，governedAssets 与测试 fixture 的镜像清单各需同步 | 补镜像并纳入 governedAssets；`tests/helpers/docs-fixture.js` 清单同步（该手工镜像本身记为 C-10） |
| B-12 redaction 死条目（计划外发现） | 脱敏扫描 includeDirs 含根级 `rules`，该目录不存在（规则在 `docs/rules/`）；扫描器对不存在路径静默跳过——已装规则内容从未被实际扫描 | 改为 `docs/rules`；扫描器静默跳过行为保留（pack 安装场景合法），由测试守护真实路径 |

## P2 路线图（只记录，未执行）

| 条目 | 说明 | 入口证据 |
| --- | --- | --- |
| C-01 manifest 加载单轨化 | loadAllManifests 收编 capabilities 与 install-presets 的独立加载路径 | `manifests/capabilities.json`、`manifests/install-presets.json` 的加载入口 |
| C-02 scripts 对 runtime 的反向依赖收敛 | 开发 CLI 直接 import runtime 内部模块，层次倒置 | `scripts/lib/install-planner.js:32-34`、`scripts/eval-trials.js:7` |
| C-03 --target 与 --targets 语义统一 | 两个旗标并存，语义边界未文档化 | adapters 与 CLI 命令面 |
| C-04 CHANGELOG 条目分段 | 单段条目混合多个关注点，检索性差 | `CHANGELOG.md` |
| C-05 角色前言去重 | 各角色文件重复约 25 行公共前言，应由 role-projection 编译器去重 | `.agents/roles/` |
| C-06 hooks 其余宿主滚动核验 | 已核验宿主之外仍有 7 个宿主未做滚动核验 | `.codex/hooks.json` 及宿主矩阵 |
| C-07 governance-core 与 ai-collab 双向引用整理 | 两份规则互引方向不一致 | `docs/rules/governance-core.md`、`docs/rules/ai-collab-rules.md` |
| C-08 unmanagedCount 门禁化评估 | self-install 输出的 unmanagedCount 未纳入门禁，孤儿资产只能靠人工审计发现 | `scripts/lib/self-install-check.js` |
| C-09 install 写路径保护 | 目标已存在文件经占位符渲染后写入会产出损坏内容（症状：`--force` 重装时 `docs/rules/project-specific-rules.md` 自引用渲染损坏），应拒绝 sameResolvedPath 而非产出损坏内容 | 安装器写路径 |
| C-10 docs-fixture 清单派生化 | 测试 fixture 的 GOVERNED_SCHEMAS 与 docs-validation governedAssets 手工镜像，B-11 暴露该漂移类；应从单源派生 | `tests/helpers/docs-fixture.js` |

## 接受项

| 条目 | 对象与理由 |
| --- | --- |
| E-01 online eval 现状 | onlineRunner 为 null、仅单一 offline reference；按 `docs/evals.md` 声明的接受状态处理，待 online runner 需求出现再立项（B-06 使其从隐式变显式） |
| E-02 `.codebase-memory` 索引新鲜度 | 工具自管缓存（artifact.json 指向 `f561d4a`、indexed_at 2026-09-05），仓库侧不维护其新鲜度，由工具合同负责重建；本审计未改动该目录 |
| E-03 observers.json 仅 pack 源 | `runtime/evals/observers.json` 由 `manifests/capabilities.json` 与 `scripts/eval-check.js` 消费，属 eval 治理资产；`.agents` 投影侧（codex-runner.mjs、run.mjs）无引用，不投影是 A-01 处置的一部分 |

## 处置联动与验证收据

| 批次 | 提交 | 范围 | 验证收据 |
| --- | --- | --- | --- |
| 基线 | `d315874`、`24d143e` | 审计开始前的在制批次与其 eval reference 重生成 | 见对应提交说明 |
| W1 | `d4bb676` | A-01 至 A-06 | `pnpm test:integration`、`pnpm smoke:lifecycle`、自安装一致性校验、`pnpm check` |
| W2 | `ec2c2b1` | B-01 至 B-07 | `pnpm check`（含 docs:audit）、`pnpm test:unit`、`pnpm skills:audit`、eval 指纹漂移按 CONTRIBUTING 确认清单处理后重生成 |
| W3 | `aaf650a` | B-08 至 B-12 | `pnpm check`（376 项）、`pnpm test:integration`（320 通过 / 1 跳过）、`pnpm skills:audit`、eval run 至 eval:check 链路重生成 |
| W4 | 本提交 | 审计落盘、inventory 快照治理、CHANGELOG | `pnpm check`、`pnpm docs:audit` |

## 快照治理处置（本批附带）

按 docs/README.md 审计参考节的快照规则，本批对既有 inventory 文档做口径标注（保留原文、不回溯改写）：[ai-eval-investigation.md](ai-eval-investigation.md) 的计数为 2026-07-30 快照，[harness-superpowers-comparison.md](harness-superpowers-comparison.md) 的计数为 2026-09-05 快照（处置状态更新于 2026-09-14）；两者的再生成方式与后续快照以本文「快照基准」为口径起点。
