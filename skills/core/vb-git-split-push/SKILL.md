---
name: vb-git-split-push
description: Use only when explicitly requested as Vb Git Split Push, $vb-git-split-push, or legacy $git-deliver to group existing workspace changes, sync and push the current branch including develop; excludes worktree delivery.
---

# Vb Git Split Push

调用标识：`vb-git-split-push` / `$vb-git-split-push`；显示名 Vb Git Split Push；旧别名 git-deliver / `$git-deliver`。此显式入口在当前分支（含 `develop`）分组提交、同步并普通推送，不创建任务分支或 worktree；local-land 使用显式 develop flow 的 `stage`/`publish`。常驻合同见 `docs/rules/git-rules.md`，修改须同步。

## 执行

1. 核对工作区、当前分支、upstream 和完整 diff（已暂存、未暂存、未跟踪）。显式调用默认将调用时已有修改纳入分析和交付，不因早于本次会话或缺少历史归属记录而追问；用户限定范围优先。冻结起始清单和内容，排除明确不交付项、并发新增或变化、敏感内容及生成垃圾；这些排除项归属不明时保留，不覆盖、不暂存、不提交。
2. 按独立逻辑变更和依赖顺序形成提交组，代码、对应测试、配置和必要文档一起提交，不按 runtime/tests/docs 等文件类别机械分组；紧密耦合且不能独立验证的修改合为一组。每组列出包含/排除文件、验证、风险和 Conventional Commit 主题，直接执行，不逐组请求确认；只暂存明确文件或补丁，不混入原暂存区中已排除的内容。复用已有暂存时先复核完整性，不能默认之前的分组有效。
3. 所有 Git 命令固定到已核对的仓库目录。每组暂存后先运行 `git diff --cached --check`，覆盖刚加入的新文件；仅 `git diff --check` 通过不证明暂存区合格。核对该快照的代码、检查脚本、测试登记及其本地依赖齐全；未暂存的新文件不能支撑已暂存的脚本或配置。运行匹配该组影响面的必要检查，验证相关路径的工作树内容须与 index 一致，且检查不能依赖组外未暂存内容；无法证明时从 index 导出隔离快照验证，保留原工作树和 index。记录 staged tree，提交前复核，Hook 改变验证对象后重新验证。遵守项目必需验证，不额外固定启动全量检查。

   对已明确定位、属于冻结交付范围的 EOF 空行、尾随空格或项目 formatter 的纯格式问题，可保留语义作最小修复，记录修复并仅重新暂存对应文件/补丁，重新检查快照与必要验证，再经原 Hook 重试提交一次。相同失败再次出现、发现并发变化、修复需要语义或范围决定，或权限、安全策略、未知 Hook 拒绝、必要验证失败或超时时，停止受影响步骤并保留现场及已完成组。不使用 `--no-verify`、禁用 Hook 或改变策略换取通过。
4. 从已核实 upstream 解析唯一实际 push URL 与精确目标 ref；无 upstream 仅在唯一 origin 且非保护目标时显式建立跟踪。拒绝多地址、mirror、保护目标未知或无法唯一证明的目标。远端受阻不撤销已完成的本地提交。
5. 本地分组完成后，从该实际 push URL fetch 精确目标 ref，冻结远端 SHA；不假定 fetch URL 与 push URL 相同。核对工作区和暂存区干净，无进行中的 merge/rebase；有排除项或并发修改则只停止同步及推送，不自动 stash 或提交它们。本地与远端相等或本地领先时继续；纯落后用 `git merge --ff-only <remote-sha>`；分叉时用 `git merge --no-edit <remote-sha>` 显式同步，保留已有提交 SHA。无共同祖先、冲突或 Hook 拒绝时保留现场并停止，不自动解决冲突或改写历史。
6. 同步改变最终树后，按本地交付及远端引入的实际影响面重新运行必要检查，绑定最终待推送 SHA，不能复用同步前失效证据。用 `git push --no-force <actual-push-url> <sha>:<exact-ref>` 推送冻结 SHA，并从同一地址回读精确远端 SHA；相等，或取得该远端提交并证明包含待推 SHA，才确认远端交付。默认全部提交验证通过后统一推送；失败保留本地提交，不 reset、rebase 或 force push。
7. 若远端再次前进且确认是可重试的非快进拒绝，重复精确 fetch → 同步 → 必要验证 → 推送，整个同步推送流程最多三轮。网络失败或推送结果不明时先回读对账；不能证明结果则停止，不能当作基线前进盲目重试。交付分别列出分组 commit SHA、本地同步状态、验证结果和远端确认；推送受阻时明确本地已完成部分。

停止边界：不自动推送 main、master、release 或仓库声明为保护的共享分支；`develop` 按实际保护策略核验，不因名称拒绝交付。不删除远端引用、不改历史、不创建 PR/MR。自动 merge 仅同步当前分支的精确远端目标，不合入其他任务分支、不启动受管 stage/publish。未显式调用本 Skill 时不启用分组交付流程。
