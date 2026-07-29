# 测试规则

测试范围与完成主张匹配；不因任务档位自动运行固定矩阵。

| 改动 | 建议验证 |
| --- | --- |
| 普通对话 / 只读诊断 | 事实核对、静态检查或无需命令 |
| 局部行为 | 受影响范围的聚焦测试和适用 lint/typecheck |
| 共享行为、公共契约 | 调用方回归与集成检查 |
| UI | 组件测试和真实浏览器关键状态 |
| 安全、数据、发布 | 正向/负向路径、回滚与必要的环境验证 |

全量测试不是默认验证；仅在用户明确要求、CI/发布要求、影响面无法缩小或项目自身配置为门禁时运行。显式 Review、浏览器验证和 Eval 是可选产品能力，不由 Cognis 自动触发。

记录实际命令、退出码和关键结果。失败不得通过降低断言绕过；无法验证时缩小完成主张并说明风险。

验证记录应保留验收矩阵、每项命令的退出码、未验证项和剩余风险。

## 工程约定

框架：仅用 Node.js 内置测试运行器（`node --test` + `node:assert/strict`），不引入第三方测试依赖。

分层：通过 `package.json` 脚本分为 unit / eval / integration；集成测试 `--test-concurrency=1` 串行，避免共享临时项目状态污染。

卡死兜底：所有 `test:*` 脚本设 `--test-timeout`（unit/eval 30s、integration 120s）；该值只作失败兜底，非可靠的进程取消。

风格：顶层 `test('描述句', fn)`，不使用 `describe` 套件；断言统一 `node:assert/strict`；基准路径用 `import.meta.dirname`，禁止硬编码绝对路径。

隔离：临时目录用 `mkdtemp` 并在 `try/finally` 中 `rm` 清理；断言抛错也必须执行清理。

Mock：优先依赖注入式手写替身；只在验证调用次数/参数时考虑 `t.mock.fn`，且用 `t.mock` 而非顶层 `mock` 确保自动还原。

门禁：`.test.js` 不得提交 `test/it/describe` 的 `.only` 或 `.skip` 残留；pre-commit 扫描暂存内容拦截，合法的条件跳过用选项对象 `{ skip: ... }` 或运行时 `context.skip(...)`。

边界：确定性代码走普通产品测试；Agent 规则/Skill/模板/adapter/Hook 的非确定性行为走 Eval，且 `eval:offline` 必须确定性 stub LLM 与时间。
