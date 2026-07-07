---
name: open-code-review
description: >
  使用 alibaba/open-code-review 的 `ocr` CLI 对 Git 变更执行 AI 代码审查。用于用户要求审查代码、PR、staged/unstaged 变更、commit 或分支 diff。输出行级审查意见；用户明确要求时可协助修复。
license: Apache-2.0
compatibility: >
  需要已安装 `ocr` CLI（通过 `npm install -g @alibaba-group/open-code-review` 或 GitHub release binary）。首次运行前需要配置可用的 LLM（Anthropic 或 OpenAI-compatible）。
metadata:
  author: alibaba
  homepage: https://github.com/alibaba/open-code-review
  version: "1.0.0"
---

# Open Code Review 审查

此 skill 调用 `ocr` 对 Git diff 做结构化审查。保留命令、参数和配置 key 的英文原样。

## 前置检查

```bash
which ocr || echo "NOT INSTALLED"
ocr llm test
```

如果未安装：

```bash
npm install -g @alibaba-group/open-code-review
```

如果 `ocr llm test` 失败，引导用户配置 LLM。不要编造或硬编码 API key。

环境变量方式：

```bash
export OCR_LLM_URL=https://api.anthropic.com/v1/messages
export OCR_LLM_TOKEN=<api-key>
export OCR_LLM_MODEL=claude-opus-4-6
export OCR_USE_ANTHROPIC=true
```

持久配置方式：

```bash
ocr config set llm.url https://api.anthropic.com/v1/messages
ocr config set llm.auth_token <api-key>
ocr config set llm.model claude-opus-4-6
ocr config set llm.use_anthropic true
```

## 工作流

1. 收集业务上下文：从任务、diff、commit 或分支名提炼简短背景。
2. 运行审查：优先把上下文传给 `--background`。
3. 分类报告：只向用户呈现 High 和 Medium；Low 作为低置信噪声丢弃。
4. 修复：只有用户明确要求 “review and fix” 时才直接修；单纯 review 需先征得同意。

常用命令：

```bash
ocr review --audience agent --background "business context here"
ocr review --audience agent --background "business context here" --commit abc123
ocr review --audience agent --background "business context here" --from main --to <branch>
ocr review --preview
```

参数要点：

- `--audience agent`：避免进度 UI 污染输出。
- `--commit` / `-c`：审查单个 commit。
- `--from <ref>` 与 `--to <ref>`：审查两个 ref 之间的 diff。
- `--timeout <minutes>`：调整单文件超时。
- `--concurrency <n>`：遇到 rate limit 时降低并发。
- `--preview` / `-p`：只预览审查范围。

## 结果分类

- High：明显 bug、安全问题、清晰错误或有精确修复方案的问题。
- Medium：合理但依赖上下文的风险、性能/风格建议，或需要人工实现的修复。
- Low：疑似误报、上下文不足、吹毛求疵或无意义建议；默认不汇报。

输出模板：

```markdown
## 代码审查结果

**已审查文件**: N
**发现问题**: X 个高优先级 / Y 个中优先级

### 高优先级

- **`path/to/file.ts:42`** - 简述问题
  > 建议：修复建议

### 中优先级

- **`path/to/file.ts:88`** - 简述问题
  > 建议：修复建议
```

如果过滤后没有问题，说明：`审查完成，N 个文件中未发现需要报告的问题。`

当 `start_line` 和 `end_line` 都为 `0` 时，说明评论未定位到精确行；读取目标文件，根据评论语境找到对应代码后再处理。

## 自定义规则

OCR 规则优先级：

1. `--rule <path>`
2. `<repo>/.opencodereview/rule.json`
3. `~/.opencodereview/rule.json`
4. 内置默认规则

示例：

```json
{
  "rules": [
    {
      "path": "**/*.java",
      "rule": "All new methods must validate required parameters for null",
      "merge_system_rule": true
    }
  ]
}
```

预览规则：

```bash
ocr rules check src/main/java/com/example/Foo.java
```

## 注意事项

- 首次审查前必须运行 `ocr llm test`。
- `ocr review` 在当前 Git repo 上运行；必要时使用 `--repo /path/to/repo`。
- bare `ocr review` 会包含 staged、unstaged 和 untracked 变更。
- 大 diff 可能被截断；超过 50 行变更会进入额外 risk-analysis 阶段。
- 审查语言受 `language` config 控制，默认中文。

## 验证

审查结束后确认：

- 命令退出码为 0。
- 生成了评论，或出现 “No comments generated”。
- stderr 中的 warning 已阅读并向用户说明。

参考：

- https://github.com/alibaba/open-code-review
- https://www.npmjs.com/package/@alibaba-group/open-code-review
