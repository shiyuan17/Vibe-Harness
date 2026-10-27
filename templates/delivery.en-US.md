# Delivery record

- Result status:
- Actual changes:
- Verification performed this run:

Record each required acceptance item as passed, failed, blocked, or unverified and attach the actual command or manual criterion. Claim complete delivery only when every required item passed; builds, lint, file hashes, or skipped relevant tests do not substitute for target-behavior evidence.

Add unverified items, risks, or follow-up actions only when they exist.

For behavior changes, check original requirements and preserved behavior. Reuse plan acceptance IDs and link units to current evidence; requirement IDs are not check IDs. Small tasks use prose, not another table. `acceptanceCoverage` diagnoses declared relationships only: advisory exit code 0 does not prove complete requirements or behavior.

## Rework observation (only for actual rework or an explicit pilot)

- Event ID and original acceptance item:
- Primary cause: requirement misunderstanding / scope omission / implementation / verification / environment / integration / unknown; record new requirements separately.
- Earliest missed detection point:
- Repair, prevention check, and evidence:
- Rework duration (blank if unknown), explicit acceptance feedback, and feedback window:

Count each event once, not log lines or edits. No feedback is not acceptance; unknown duration is not zero. Reuse task or delivery records, without a new ledger, monitor, database, or completion gate. Existing operational events retain `reworkCount` and `reasonCode`. Report engineering delivery, online behavior verification, and demonstrated rework improvement separately.

## Cleanup alignment

Tests passing or a clean working tree does not mean knowledge is in sync. When a change touches behavior, interfaces, or configuration, check whether related docs, rules, and comments still match the code; fix in place or record as a follow-up. Within existing authorization, clean up disposable files created solely by this task when ownership is clear. Preserve pre-existing, concurrent, and unattributed files. Production, red-zone, irreversible cleanup, and scope expansion follow governance-core authorization rules. Summarize actual evidence; full command output and red-to-green evidence are not universal requirements. Local delivery does not imply commit, push, merge, or release.
