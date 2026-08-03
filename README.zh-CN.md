# Vibe-Harness

[English](README.md) | [简体中文](README.zh-CN.md)

Vibe-Harness 为 Codex、Claude Code、Gemini CLI、Cursor、Qoder 和 ZCode 安装项目级规则、领域 Skills、可选 Eval、显式工具插件和安全 Hook。它只写目标项目，不修改全局 Agent 配置。

默认执行路径只有一条：`获取事实 -> 直接执行 -> 聚焦验证 -> 简洁交付`。快速、轻量、完整三档只用于选择风险控制和验证强度。

## 快速开始

需要 pnpm 10+，以及 Node.js 20.19+、22.18+ 或 24+。

```bash
pnpm install
pnpm vibe-harness init --project ../some-project --target codex
pnpm vibe-harness install --project ../some-project --target codex --profile core --dry-run
pnpm vibe-harness install --project ../some-project --target codex --profile core --write
pnpm vibe-harness validate --project ../some-project
```

`validate` 只检查安装一致性。执行项目验证使用：

```bash
pnpm vibe-harness verify --project ../some-project
```

`verify` 依次执行已配置的 `lint -> typecheck -> test -> eval`，未配置的项会跳过。

## 执行模型

- 快速：只读、解释、文档和微小非行为变化，通常只需静态核对。
- 轻量：可逆的本地行为改动，运行与受影响范围匹配的检查。
- 完整：安全、生产、发布、数据迁移、公共契约、红区、不可逆或跨仓变更，扩大验证并准备回滚。

单 Agent 默认完成任务。用户显式调用的 `open-code-review`、浏览器验证、Eval 和项目测试仍可正常使用。任务 Markdown 是可选的人读记录，不参与运行时判断。

## Profiles

| Profile | 安装内容 |
| --- | --- |
| `minimal` | 平台说明、安全边界、Git/Test 规则和可选任务/交付模板 |
| `core` | `minimal` 加通用工程规则、五个领域 Skills 和离线 Eval |
| `full` | `core` 加三个领域 Skills、在线 Eval 和已支持宿主的安全 Hook |
| `docs-only` | 规则、模板和 schemas，不安装 runtime、Skills、MCP 或 Hook |

外部工具和 memory 仍只通过 `--plugin` 显式启用。所有宿主配置文件均属于红区写入，需要 `--confirm-red-zone`。

```bash
pnpm vibe-harness install --project ../some-project --target codex --profile full --dry-run
pnpm vibe-harness install --project ../some-project --target codex --profile full --write --confirm-red-zone
```

Claude Code 和 Gemini CLI 使用相同的四个 profile；其 preview 能力需要显式 `--allow-preview`。

## Adapter 支持

| Target | 项目指令 | Skills | 项目级 Hook / MCP 配置 |
| --- | --- | --- | --- |
| Codex | `AGENTS.md` | `.agents/skills/` | `.codex/` |
| Claude Code | `CLAUDE.md` | `.claude/skills/` | preview 能力 |
| Gemini CLI | `GEMINI.md` | `.gemini/skills/` | preview 能力 |
| Cursor | `AGENTS.md` | `.cursor/skills/` | `.cursor/hooks.json`、`.cursor/mcp.json` |
| Qoder | `AGENTS.md` | `.qoder/skills/` | `.qoder/settings.json`、`.mcp.json` |
| ZCode | `AGENTS.md` | 不自动安装 | `.zcode/config.json` |

ZCode 尚未公开项目级 Skill 的磁盘路径，因此 Vibe-Harness 不会写入 `~/.zcode`，也不会猜测项目 Skill 目录；需要时请通过 ZCode UI 手动导入。受管 JSON 只更新 Vibe-Harness 的 MCP server 和 Hook 组，用户已有配置会保留。

## 项目配置

`vibe-harness init` 创建以下结构：

```json
{
  "projectName": "ExampleProject",
  "language": "zh-CN",
  "packageManager": "pnpm",
  "target": "codex",
  "profile": "core",
  "validationCommands": {
    "lint": null,
    "typecheck": null,
    "test": null,
    "eval": null
  },
  "evaluations": {
    "enabled": false,
    "suites": [],
    "reference": "evals/references/project.json",
    "thresholds": {
      "criticalPassRate": 1,
      "overallScore": 0.9,
      "maxCapabilityRegression": 0.05
    },
    "onlineRunner": null,
    "repetitions": 3
  },
  "hooks": {
    "allowedWriteRoots": [],
    "allowedEgressHosts": [],
    "mode": "guarded"
  },
  "riskZones": {
    "red": ["auth", "secrets", "ci-cd", "env"],
    "yellow": ["shared-libs", "state", "routing", "io-clients"]
  },
  "crossRepo": {
    "enabled": false,
    "backendRepo": ""
  },
  "projectRules": {
    "mode": "auto",
    "overrides": {}
  },
  "clarification": {
    "posture": "balanced"
  },
  "memory": {
    "enabled": true,
    "path": ".agents/memory"
  }
}
```

旧字段 `governance.mode`、`governance.workflow`、`hooks.completionGate` 和 `validationCommands.governance` 会触发 `VIBE_HARNESS_OBSOLETE_GOVERNANCE_CONFIG`。Vibe-Harness 不静默兼容或自动修改项目配置。

## 显式工具

可选插件包括 `rtk`、`ast-grep`、`codebase-memory-mcp`、`chrome-devtools-mcp`、`playwright-cli` 和 `open-code-review`。Agentmemory runtime 因上游 High 漏洞暂停提供，不作为 `--plugin` 选项；如需记忆能力，请通过 `--modules memory` 安装 memory 模块。

```bash
pnpm vibe-harness install --project ../some-project --target codex --profile core --plugin -rtk --dry-run
pnpm vibe-harness install --project ../some-project --target codex --profile core --plugin -rtk ast-grep --write
pnpm vibe-harness install --project ../some-project --target codex --profile core --plugin none --write
```

插件选择会保存在项目 install-state 中。`--modules` 是替换 profile 模块集合的高级接口，不是插件增量接口。

## 升级与移除

升级会比较旧 install-state 与新安装计划。计划不再包含且未修改的受管文件会在 `--upgrade --write` 下退役；已修改文件只报告冲突，不会删除。过期运行时状态会精确清理，不会删除整个 `.vibe-harness`。

```bash
pnpm vibe-harness install --project ../some-project --target codex --profile core --dry-run --upgrade
pnpm vibe-harness install --project ../some-project --target codex --profile core --write --upgrade
pnpm vibe-harness uninstall --project ../some-project --target codex --dry-run
pnpm vibe-harness uninstall --project ../some-project --target codex --write
```

### 退出码

| 退出码 | 含义 |
|--------|------|
| 0 | 成功（或降级但传了 `--allow-degraded`）。 |
| 1 | 失败：状态无效、安装错误或未处理异常。 |
| 2 | 部分跳过：卸载或回滚因用户修改保留了部分文件；或健康检查降级且未传 `--allow-degraded`。 |

## 安全边界

- 未使用 `--force` 时不覆盖已有项目文件。
- 所有真实写入使用 `--write`；红区写入需要显式确认。
- 安装器不修改全局 Agent 配置或 `.git/config`。
- Codex、Cursor、Qoder 和 ZCode Hook 会把 `PreToolUse` 和权限事件归一到同一安全策略，用于阻止危险 Git、全局配置写入、凭据外传、红区文件上传、越界写入，以及（配置 `allowedEgressHosts` 白名单后）非白名单主机出口。RTK Hook 路由仍只支持 Codex。
- 完成主张必须由本轮有效证据支持；无法验证时缩小主张并说明风险。

## 文档

- [文档索引](docs/README.md)
- [架构](docs/architecture.md)
- [迁移指南](docs/migration-guide.md)
- [Hook 安全策略](docs/hooks.md)
- [Eval](docs/evals.md)
- [贡献指南](CONTRIBUTING.md)

## License

[MIT](LICENSE)
