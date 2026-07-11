---
name: open-code-review
description: Use when a Git worktree, commit, branch diff, or pull request needs AI-assisted review through the ocr CLI.
license: Apache-2.0
compatibility: Requires the ocr CLI and a configured Anthropic or OpenAI-compatible LLM.
---

# Open Code Review

## 前置

1. 检测 `ocr` 是否可执行。
2. 运行 `ocr llm test`；不得编造、输出或硬编码 API key。
3. 确认 Git 审查范围、目标分支和业务背景。

若 CLI、LLM 或命令不可用，回退到 `code-review-and-quality` 或独立人工审查，说明原因和未覆盖风险。

## 执行

优先使用 agent 输出并传入简短背景：

```bash
ocr review --audience agent --background "business context"
```

单 commit 使用 `--commit`，分支范围使用 `--from`/`--to`；先确认范围时使用 `--preview`。完整配置、参数和规则优先级见 `references/cli.md`。

## 输出

- 先核对命令退出码、stderr warning 和实际审查文件。
- 只报告可操作的 High/Medium；丢弃无证据的低置信噪声。
- finding 包含位置、触发方式、影响和建议；无法定位行号时读取文件后再判断。
- 没有 finding 时报告审查范围、证据和残余风险。
- 单纯 review 保持只读；只有用户明确要求修复时才修改代码。

OCR 不替代项目 Review 规则、高风险独立判断或红区人工确认。
