#!/usr/bin/env node
// Aggregate result reader for the required merge-gate check.
//
// The workflow exports one <NAME>_RESULT variable per gate job, plus a
// REQUIRED_<NAME>_RESULT flag that is `false` when the job is not applicable to
// the event. Only variables the workflows actually set are read here: a name
// that no job exports is indistinguishable from a passing gate, so dead names
// are removed instead of being left to look satisfied.
const names = [
  'BRANCH_POLICY_RESULT',
  'HIGH_RISK_REVIEW_RESULT',
  'HIGH_RISK_APPROVAL_RESULT',
  'RISK_EVIDENCE_RESULT',
  'CHANGE_PLAN_RESULT',
  'PRODUCT_RESULT',
  'SUPPLY_CHAIN_RESULT',
  'SECURITY_RESULT',
  'FAST_GATE_RESULT',
  'INTEGRATION_GATE_RESULT',
  'SMOKE_GATE_RESULT',
  'FULL_GATE_RESULT',
];
const results = names
  .filter((name) => process.env[name] !== undefined)
  .map((name) => ({
    name,
    value: process.env[name],
    required: process.env[`REQUIRED_${name}`] !== 'false',
  }));
const failed = results.filter((item) => item.value !== 'success'
  && !(item.value === 'skipped' && !item.required));
console.log(JSON.stringify({ checks: results, ok: failed.length === 0 }, null, 2));
if (failed.length > 0) process.exitCode = 1;
