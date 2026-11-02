---
name: vb-git-split-push
description: Use only when explicitly requested as Vb Git Split Push, $vb-git-split-push, or legacy $git-deliver to commit existing changes, merge and push without quality verification; high-risk merges require user authorization.
---

# Vb Git Split Push
显式调用本入口（兼容 git-deliver / `$git-deliver`）只整理已有改动、普通提交、低风险自动合并和普通推送；不创建分支或 worktree，不进入 develop flow 的 `stage`。常驻合同见 `docs/rules/git-rules.md`，修改须同步。

## 执行
1. 一次核对仓库、当前分支、upstream、已暂存／未暂存／未跟踪的完整 diff；显式调用覆盖调用时已有修改，用户限定范围优先。冻结起始清单和内容，排除敏感内容、生成垃圾、明确排除项及并发新增或变化，保留原文件与暂存区，不重复追问历史归属。
2. 按逻辑能力及依赖顺序分组，代码、对应测试、配置和必要文档一起提交；紧密耦合的改动合组，不按目录机械拆分。简列每组范围和 Conventional Commit 主题，直接执行，不逐组请求确认。只暂存明确文件或补丁，提交前核对 index 与冻结范围一致，不混入排除项。
3. 所有 Git 命令固定到已核对仓库。普通提交只执行受管 Hook 的独立安全检查，不运行 lint、typecheck、测试、Eval、构建、formatter、commitlint、验证计划或收据流程；不导出测试候选、不安装依赖、不自动修代码、修测试、同步台账或排障，失败保留现场和已完成提交。
4. 从 upstream 解析唯一实际 push URL 与精确 ref；无 upstream 仅在唯一 origin 且目标非保护分支时建立跟踪。拒绝多地址、mirror 和无法确定的目标。从实际 push URL fetch 精确 ref，冻结远端 SHA，不假定 fetch URL 与 push URL 相同。
5. 工作区和 index 干净且无进行中的 merge/rebase，目标为当前非保护分支的对应远端且有共同祖先时，允许低风险自动合并：相等或本地领先无需合并；纯落后用 `git merge --ff-only <remote-sha>`；分叉用 `git merge --no-edit <remote-sha>`。保留已有提交 SHA，合并后不追加质量验证。
6. 高风险合并先说明源、目标、影响及风险，请用户授权确认：保护分支、发布／生产分支、其他任务分支、无共同祖先，或冲突解决需要改变业务语义。当前 Skill 调用本身不授权这些高风险动作；已有明确覆盖同一范围和风险的授权不重复索取。冲突发生后停止受影响动作、保留现场，未获授权不自动解决。授权不允许绕过宿主权限、独立安全检查或服务器保护。
7. 冻结最终 HEAD，以 `git push --no-force <actual-push-url> <sha>:<exact-ref>` 普通推送；默认分组提交后统一推送，不要求质量验证或收据。回读同一地址的精确 ref：相等或已取得远端提交并证明包含待推 SHA，才确认推送成功。非快进拒绝最多三轮精确 fetch → 安全合并 → 推送；网络失败或结果不明先回读，不盲目重推。
## 边界与交付
- Git 状态、暂存范围、分支、祖先与远端 SHA 核对仅确认操作安全和结果，不属于代码质量验证；保留凭据、红区、冲突标记与用户改动保护，不使用 `--no-verify` 或禁用 Hook。
- 有排除项或并发修改时不自动 stash、提交或覆盖；无法安全同步时仅停止相关同步／推送。本地提交不因远端受阻而撤销。
- 不强推、不 rebase、不改写历史、不删除远端引用、不创建 PR/MR。保护目标不得自动直接推送，按用户明确授权与项目允许的受保护路径处理；合并授权不自动包含发布授权。
- 不要求质量例外、宿主授权凭证或审计空提交；项目外部 Hook 和服务端强制检查不绕过，若其阻断仅报告，不自行修复或关闭。
- 交付只列分组 commit SHA、合并结果与远端确认；说明“未运行质量验证”。不宣称测试通过、产品验收通过或已经发布。未显式调用本 Skill 时不启用此流程。
