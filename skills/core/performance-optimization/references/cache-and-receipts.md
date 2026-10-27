# 内容缓存与收据

## 缓存键

`tree-content` 模式绑定：工作树内容摘要、未跟踪文件、锁文件、命令、`cwd`、平台/架构、工具链版本、验证实现版本和 allowlist 环境摘要。绝对路径、HEAD、分支名只进入 provenance，不进入可复用身份。

## 检查范围

- `tree`：全仓 lint、typecheck、全量单测和后端检查；同一内容可跨 worktree/HEAD 复用。
- `selection`：`*:changed`、`*:affected` 等依赖 base 或 changed paths 的检查；额外绑定基线与变更上下文。
- 未声明时默认 `selection`，只有明确证明不依赖选择上下文的检查才声明 `tree`。

## 失败语义

- 路径、锁文件、工具链不可读，记录无法认证，worktree 有歧义，或最终快照不稳定：一律 miss 或 blocked。
- 单个检查 miss 不影响其他检查的命中；逐检查存储，禁止整批失效。
- 执行中若检查改动跟踪或未跟踪内容，停止使用后续预计算命中并重新取快照；最终内容不一致仍是 `FINAL_SNAPSHOT_MISMATCH`。
- 缓存只在本机、同一用户和兼容工具链内共享；不保存 stdout、stderr 或环境明文。

## 收据

- 完整运行收据留在当前工作树；检查级缓存放在 Git common dir 的共享 store。
- schema 升级后旧版收据可以读取，但不能作为自动复用命中。
- 收据必须绑定最终树、写指纹、选中的检查、审查/免审上下文和 provenance。
