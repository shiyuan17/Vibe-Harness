#!/usr/bin/env node
const names = [
  'BRANCH_POLICY_RESULT',
  'DEVELOP_GATE_RESULT',
  'HIGH_RISK_REVIEW_RESULT',
  'MAIN_RELEASE_GATE_RESULT',
  'RISK_EVIDENCE_RESULT',
  'CHANGE_PLAN_RESULT',
  'PRODUCT_RESULT',
  'SUPPLY_CHAIN_RESULT',
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
