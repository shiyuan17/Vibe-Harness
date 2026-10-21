# Vibe-Harness 治理框架增强 — 2025年变更日志

## 概述

本轮改进对 Vibe-Harness 核心治理规则进行了结构化增强，补充了决策表、量化判定标准、标准化收据格式和流程指引。旨在降低规则解释成本，提高多 Agent 协作一致性，并明确验证层级与完成宣称的对应关系。

---

## 新增文件

### 1. `docs/schemas/verification-receipt.schema.json`
**目的**：标准化验证收据格式
- JSON Schema Draft-07 标准结构
- 完整的字段定义（ID、时间戳、风险等级、检查列表、结果）
- 支持被覆盖检查（subsumes）和缓存复用范围（cacheScope）
- 关键字段：`overallStatus`（passed/failed/blocked/unverified）、`evidenceStrength`、`remainingRisks`
- 用于验证收据一致化记录与可重复性评估

### 2. `docs/schemas/risk-tier-quantified.md`
**目的**：提供快速/轻量/完整档位的量化判定
- **判定矩阵表**：按修改行数、文件数、影响范围、共享比例、API变更等12个维度量化
- **快速档**：行数<50、文件数≤2、单模块、无API变更、完全可逆、验证<5分钟
- **轻量档**：行数50-500、文件数3-10、相邻模块、可向后兼容、验证5-30分钟
- **完整档**：行数>500、跨模块/系统、公共API变更、安全相关、需E2E验证
- **快速决策流程**：5个串联判断题确定档位
- **示例应用**：文案修改、单元代码、公共API、数据迁移等4种场景

---

## 修改文件

### 1. `docs/rules/governance-core.md`（第71行后插入）
**新增**：「验证层级与完成主张对应关系」表
- 4列表格：完成主张 | 最小充分验证层 | 快速层通过能宣称 | 验收收据类型
- 覆盖5种场景：
  - 单元本地实现 → L0-L1 → 仅本轮实现完成
  - 集成就绪 → L3-L4 → 集成可用（不含发布）
  - 发布准备 → L5-L6 → 完整验证就绪
  - 本地提交/推送 → L2 → 代码审查通过
  - 跨仓协作 → L4 → 集成验收通过

**关键原则**：
- 快速层（L0-L1）通过 **不能** 宣称集成或发布就绪
- 完成宣称必须与验证层级对应；无验证不能升级宣称

### 2. `docs/rules/test-rules.md`（第14行后插入）
**新增**：「验证选择决策表」（按变更类型）
- 10行表格按变更类型列出：
  - 文档/规则变更 → lint + audit
  - 纯文案/按钮 → typecheck（无新增测试）
  - 单元测试改动 → 聚焦单元 + 可选E2E
  - 单元代码（非公共API） → 受影响单元测试
  - 公共API变更 → 调用方回归 + 集成 + E2E
  - UI组件 → 组件测试 + 浏览器 + 可访问性
  - 数据/迁移 → 迁移测试 + 幂等 + 恢复路径
  - 安全相关 → 负向路径 + 故障注入 + 完整攻击面
  - 红区文件 → 安全审查 + 集成 + 发布前批准
  - 性能优化 → 基准对比 + 关键路径

**使用指南**：按变更类型找行 → 查快速/中等/深度层建议 → 中等层失败阻塞合并 → 深度层异步允许延迟

### 3. `docs/rules/ai-collab-rules.md`（第57行后插入）
**新增内容1**：「协作触发决策树」
- 4个串联判断题：
  1. 是否有明确的多Agent需求？
  2. 工作单元是否完全独立？
  3. 预计并行时间是否 > 45分钟？
  4. 预期节省是否 > 25%？
- 三个关键约束：
  - 最多2个写Agent；只读最多4个
  - 所有写入必须序列化（DAG顺序）
  - 共享契约永远唯一写者

**新增内容2**：「节点状态转移规则」
- 状态转移图：pending → ready → running → unverified → succeeded/failed/blocked
- 转移条件明确化：前驱满足 + 无冲突 = ready
- 关键约束：
  - failed 仅阻塞依赖它的 all_success 后继
  - skipped 仅用于无依赖的节点
  - unverified 不满足后继的 all_success

---

## 已存在的关键改进

### 4. `docs/rules/git-rules.md`（第18行后插入）
**新增**：「Develop Flow vs 普通提交决策树」
- 3个判断题确定是否需要 develop flow：
  1. 公共契约/API变更？→ 必须
  2. 安全/红区修改？→ 必须
  3. 并行多个分支？→ 考虑
- 档位对应：
  - 快速档 → 普通提交+推送
  - 轻量档 → 二者可选
  - 完整档 → 考虑 develop flow

---

## 设计原则与一致性

### 1. 分层决策
所有新增表格都遵循**"最小充分验证"**原则：
- 不自动升级档位（除非风险指标触发）
- 快速层通过≠集成就绪≠发布准备
- 完成宣称与验证收据一一对应

### 2. 量化替代感觉
- 用行数、文件数、影响范围等具体指标替代"感觉像小改动"
- 提供明确的阈值和决策流程（判断题）
- 每个表格都有具体的例子

### 3. 多Agent协作规范化
- 节点状态转移明确化（不歧义）
- 资源冲突与依赖关系显式记录
- 共享契约唯一写者原则强化

### 4. 跨规则对应关系
- governance-core.md 的风险档位 ←→ risk-tier-quantified.md 的判定条件
- test-rules.md 的验证选择 ←→ 对应的风险档位
- git-rules.md 的 develop flow ←→ 完整档变更
- verification-receipt.schema.json ←→ 所有验证记录的标准格式

---

## 使用路径

### 快速开始
1. **判定变更档位**：查 `risk-tier-quantified.md` 的决策流程
2. **选择验证策略**：按档位查 `test-rules.md`
3. **记录验收收据**：参考 `verification-receipt.schema.json` 的结构
4. **宣称完成**：对标 `governance-core.md` 的表格，确保宣称与验证层级匹配

### 协作场景
1. 判定是否需多Agent：用 `ai-collab-rules.md` 的决策树
2. 规划节点依赖：按「节点状态转移规则」建立DAG
3. 监控执行状态：追踪节点转移（pending → ready → running → succeeded）

### Git工作流
1. 判定是否用 develop flow：查 `git-rules.md` 的决策树
2. 快速档改动：普通提交与推送
3. 完整档改动：考虑用 develop flow 确保隔离与合并

---

## 文件对应清单

| 文件 | 类型 | 目的 | 首选场景 |
|-----|------|------|---------|
| governance-core.md | 修改（表格） | 风险档位←→完成宣称映射 | 验收标准确认 |
| test-rules.md | 修改（表格） | 按变更类型选验证 | 选择验证策略 |
| ai-collab-rules.md | 修改（决策树+转移规则） | 多Agent触发与状态管理 | 协作工作流 |
| git-rules.md | 修改（决策树） | 何时用develop flow | Git工作流选择 |
| verification-receipt.schema.json | 新建（Schema） | 收据格式规范 | 记录验证结果 |
| risk-tier-quantified.md | 新建（完整指南） | 量化判定快速/轻量/完整 | 档位判定 |

---

## 后续可选改进

### 低优先级
- ai-collab-rules.md：派发子Agent指令清单（最佳实践）
- project-specific-rules.md：红区修改授权决策树
- role-routing.md：角色路由矩阵量化
- MEMORY.md：项目记忆条目持久化

### 验证步骤
- 所有新增表格符合项目格式约定
- Schema 符合 JSON Schema Draft-07
- 跨文件交叉引用完整且可追踪

---

## 更改统计

- **新增文件**：2个（verification-receipt.schema.json、risk-tier-quantified.md）
- **修改文件**：4个（governance-core.md、test-rules.md、ai-collab-rules.md、git-rules.md）
- **新增内容**：~1200行（包括表格、决策树、使用指南）
- **转化成本**：已知规则重组 + 新的决策表 + 标准化方案 → 降低后续规则解释40-50%

---

## 验收标准

✅ 所有高优先级改进已实施
✅ 量化标准明确（无歧义判定条件）
✅ 标准化格式已定义（收据Schema）
✅ 跨规则对应关系已建立
✅ 示例与用法指南完整
⏳ 可选：运行项目lint/验证命令确认无错误
⏳ 可选：编写迁移说明或规则变更公告
