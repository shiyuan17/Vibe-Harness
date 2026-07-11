# OCR CLI 参考

安装与连通性：

```bash
npm install -g @alibaba-group/open-code-review
ocr llm test
```

常用范围：

```bash
ocr review --audience agent --background "context"
ocr review --audience agent --commit abc123 --background "context"
ocr review --audience agent --from main --to feature --background "context"
ocr review --preview
```

遇到 rate limit 可降低 `--concurrency`，长任务可调整 `--timeout`。运行 `ocr --help` 获取当前版本参数，不在 skill 中复制完整 CLI 文档。

规则优先级：`--rule`、仓库 `.opencodereview/rule.json`、用户目录规则、内置规则。用 `ocr rules check <file>` 预览文件命中的规则。配置 LLM 时使用环境变量或 `ocr config set`，凭据只从安全 secret 来源读取。
