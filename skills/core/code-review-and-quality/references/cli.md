# OCR CLI 参考

先确认 `ocr` 可执行，并运行 `ocr llm test` 验证已配置的模型。按审查范围选择 `--commit` 或 `--from`/`--to`，需要确认范围时先使用 `--preview`。

```bash
ocr review --audience agent --background "business context"
```

不得输出或硬编码 API key。命令、LLM 或凭据不可用时回退到本地审查，并记录未覆盖风险。
