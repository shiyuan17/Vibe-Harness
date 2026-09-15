# Linear 发布 Issue（Release Issue）

Release Issue 是发布窗口的 aggregate 记录，不创建实现 worktree 或任务分支。开发 Issue 在合入 <code>develop</code> 后立即 Done（该合入不要求远端 CI）；Release Issue 只证明一次提升、正式发布和回同步完整结束，完整发布门禁在发布边界运行。

## 目标（Goal）

- Version / window:
- Observable release outcome:

## 背景（Context）

- Included Linear Project or Milestone:
- Included completed Issue IDs:
- Source branch: <code>origin/develop</code>
- Target branch: <code>origin/main</code>

## 范围（Scope）

- Promotion PR: <code>develop</code> → <code>main</code>
- release-please version PR and GitHub Release
- Post-release back-sync PR: <code>main</code> → <code>develop</code>

## 范围外（Out of Scope）

- Feature implementation
- Reopening or delaying completed development Issues
- Long-lived <code>release/*</code> branches

## 合同（Contract）

None. This Issue records the release evidence and branch promotion contract.

## DAG 元数据（DAG Metadata）

- kind: aggregate
- trigger: all_success
- resourceLocks: None

## 验收标准（Acceptance Criteria）

- [ ] Promotion PR uses <code>Refs &lt;ISSUE-ID&gt;</code> and merges <code>develop</code> into <code>main</code> with a merge commit.
- [ ] Release-boundary required check and release verification pass.
- [ ] release-please version PR merges with <code>main</code> as its target.
- [ ] GitHub Release, tag, assets, checksum, provenance and release evidence are observable.
- [ ] <code>main</code> → <code>develop</code> back-sync PR merges successfully.
- [ ] Rollback is documented as a new patch release or a revert before the next promotion.

## 依赖（Dependencies）

Managed by Linear relations

## 验证（Verification）

- Promotion PR URL and merge SHA:
- Release-please PR URL and merge SHA:
- GitHub Release URL and tag:
- Release evidence and artifact checksums:
- Back-sync PR URL and merge SHA:

## Linear 与 Git 关联（Linear / Git linking）

- Promotion and back-sync PRs use <code>Refs &lt;ISSUE-ID&gt;</code>.
- Only a PR that closes this Release Issue may use <code>Fixes &lt;ISSUE-ID&gt;</code>.
- Development Issue IDs remain references; do not add closing magic words for them again.
