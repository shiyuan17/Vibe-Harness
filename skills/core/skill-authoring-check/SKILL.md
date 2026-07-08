---
name: skill-authoring-check
description: 创建、修改或审查 LoopEngine skill、skill metadata、skill manifest 或 skill 安装面时使用。
---

# Skill 编写检查

目标是让 skill 能被未来 agent 正确发现、按需加载、稳定执行，并保持 LoopEngine 的通用可分发边界。

## 检查顺序

1. 触发条件：`description` 只描述何时使用，不摘要正文流程。
2. 渐进披露：`SKILL.md` 保留核心步骤；长参考、脚本或模板放到相邻资源文件。
3. 可测试性：为每个新增或修改的 skill 写至少一个压力场景。
4. 通用性：不得出现源项目名称、个人路径、业务专有词或只适用于单项目的例子。
5. 安装面：manifest、metadata、install-map 和 profile 档位一致。

## 压力场景

每次修改 skill 时记录三项：

| 字段 | 要求 |
| --- | --- |
| pressure scenario | agent 容易跳过规则或误用 skill 的真实任务场景 |
| baseline failure | 没有本 skill 时可能出现的错误行为 |
| with-skill expected behavior | 读取 skill 后应出现的可观察行为 |

## 常见绕过

| 借口 | 现实 |
| --- | --- |
| “只是改 description” | description 决定是否触发，必须验证。 |
| “正文写得越全越安全” | 常用 skill 过长会挤占上下文；重内容应延迟加载。 |
| “这个例子来自真实项目更具体” | 通用核心目录不能携带项目专有标识。 |
| “manifest 已经有了” | 还要确认 install-map 和 profile 会安装它。 |

## 完成证据

- `SKILL.md` 有 `name` 和 `description` frontmatter，且 name 与 manifest id 一致。
- `metadata.json`、`manifests/skills.json` 和 `adapters/codex/install-map.json` 同步。
- profile 分层符合 `minimal` / `core` / `full` 边界。
- `pnpm check` 通过，或明确列出失败命令和原因。
