# Skills 精简记录

当前 Vibe-Harness 只保留九个原生 Skills。`git-deliver` 仅允许显式调用，其他 Skill 由宿主按 description 原生选择：

- `clarify-requirements`
- `define-goal`
- `git-deliver`
- `systematic-debugging`
- `eval-driven-development`
- `security-and-hardening`
- `api-and-interface-design`
- `frontend-design`
- `runtime-cross-repo-rollout`

这些 Skills 不互相形成流程依赖，也不替代项目规则、人工安全确认或验证证据。普通规划、测试、Review 和交付由 Agent 按用户请求直接完成；只有显式调用 `$git-deliver` 或明确指定该 Skill 才授权整理当前任务改动、分组提交和普通推送当前分支。显式工具插件保留独立安装面。

manifest、metadata、OpenAI adapter metadata 和安装 target 是静态校验真值。Skill 选择不再维护 Router benchmark 或固定 token reduction 基线。
