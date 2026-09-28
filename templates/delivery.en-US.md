# Delivery record

- Result status:
- Actual changes:
- Verification performed this run:

Record each required acceptance item as passed, failed, blocked, or unverified and attach the actual command or manual criterion. Claim complete delivery only when every required item passed; builds, lint, file hashes, or skipped relevant tests do not substitute for target-behavior evidence.

Add unverified items, risks, or follow-up actions only when they exist.

## Cleanup alignment

Tests passing or a clean working tree does not mean knowledge is in sync. When a change touches behavior, interfaces, or configuration, check whether related docs, rules, and comments still match the code; fix in place or record as a follow-up. Within existing authorization, clean up disposable files created solely by this task when ownership is clear. Preserve pre-existing, concurrent, and unattributed files. Production, red-zone, irreversible cleanup, and scope expansion follow governance-core authorization rules. Summarize actual evidence; full command output and red-to-green evidence are not universal requirements. Local delivery does not imply commit, push, merge, or release.
