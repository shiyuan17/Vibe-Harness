/**
 * Gate sets aggregated by scripts/merge-gate.js, keyed by MERGE_GATE_SCOPE.
 *
 * Each list mirrors the `env:` map of one workflow job that runs the script in
 * .github/workflows/ci.yml: `product` aggregates the test layer jobs, while
 * `aggregate` is the stable required check consumed by the develop/main
 * rulesets. tests/component/ci-gates.test.js asserts both sides, so renaming or
 * dropping an export has to happen in the workflow and here in the same change.
 */
export const GATE_SCOPES = {
  product: [
    'CHANGE_PLAN_RESULT',
    'FAST_GATE_RESULT',
    'INTEGRATION_GATE_RESULT',
    'SMOKE_GATE_RESULT',
    'FULL_GATE_RESULT',
  ],
  aggregate: [
    'BRANCH_POLICY_RESULT',
    'HIGH_RISK_REVIEW_RESULT',
    'HIGH_RISK_APPROVAL_RESULT',
    'RISK_EVIDENCE_RESULT',
    'CHANGE_PLAN_RESULT',
    'PRODUCT_RESULT',
    'SUPPLY_CHAIN_RESULT',
    'SECURITY_RESULT',
  ],
};
