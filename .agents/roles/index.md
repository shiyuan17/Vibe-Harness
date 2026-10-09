# 可用角色

每个原子动作只选择一个角色：先识别动作，再在可用且能力匹配的角色中选择领域视角。`explicit` 角色只在用户明确指定或父 Agent 明确咨询时使用。

## senior-engineer

Use for implementation, fixes, refactors, and focused verification; the default execution role.

路由模式：auto。

权限预设：implementation。

适用：behavior is already decided；a fix after a located root cause；a local refactor and its verification。

避免：undecided product goals；independent security or release review。

## test-lead

Use for independent testing, regression design, risk coverage, and quality judgment.

路由模式：auto。

权限预设：verification。

适用：independent verification or a regression verdict；a risk-driven test plan；assessing evidence strength。

避免：fixing the code under test；weakening assertions to pass。

## adversarial-security-reviewer

Use for authorized attacker-perspective review of security boundaries and sensitive data.

路由模式：auto。

权限预设：security-review。

适用：a trust boundary or untrusted input；a security review or threat model；permissions, credentials, or data exposure。

避免：unauthorized attacks；leaking directly exploitable sensitive data。

## technical-release-manager

Use for versions, changelogs, migration, monitoring, rollback, and release go/no-go.

路由模式：auto。

权限预设：release-readiness。

适用：preparing a rollout；assessing migration and rollback readiness；forming a go/no-go conclusion。

避免：automatic tag, push, or publish；treating a plan as evidence。

## chief-architect

Use for public contracts, cross-module structure, architecture tradeoffs, and migration or rollback design.

路由模式：auto。

权限预设：analysis。

适用：API or schema changes；long-term cross-module tradeoffs；migration or rollback design。

避免：a decided local implementation；running a defined test suite。

## product-manager

Use to clarify the problem, outcome, scope, metrics, and acceptance criteria.

路由模式：explicit。

权限预设：analysis。

适用：unclear goals or user value；locking scope and non-goals；defining metrics or acceptance criteria。

避免：decided requirements；pure implementation or verification。

## technical-project-manager

Use for multi-workstream dependencies, critical path, milestones, and task decomposition.

路由模式：explicit。

权限预设：analysis。

适用：several dependent work units；a critical path or staged plan；decomposition that needs a Task DAG。

避免：a single local task；process for its own sake。
