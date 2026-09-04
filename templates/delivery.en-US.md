# Delivery record

- Result status:
- Actual changes:
- Verification performed this run:

Record each required acceptance item as passed, failed, blocked, or unverified and attach the actual command or manual criterion. Claim complete delivery only when every required item passed; builds, lint, file hashes, or skipped relevant tests do not substitute for target-behavior evidence.

Add unverified items, risks, or follow-up actions only when they exist.

## Cleanup alignment

Tests passing or a clean working tree does not mean knowledge is in sync. When a change touches behavior, interfaces, or configuration, check whether related docs, rules, and comments still match the code; fix in place or record as a follow-up. Only files, scripts, or temporary copies produced directly by this change qualify as deletion candidates--list each with a reason for user confirmation, and delete nothing before confirmation.
