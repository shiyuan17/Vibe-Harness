#!/usr/bin/env node
const results = [
  'BRANCH_POLICY_RESULT',
  'DEVELOP_GATE_RESULT',
  'HIGH_RISK_REVIEW_RESULT',
  'MAIN_RELEASE_GATE_RESULT',
  'RISK_EVIDENCE_RESULT',
]
  .map((name) => ({ name, value: process.env[name] }));
const failed = results.filter((item) => !['success', 'skipped'].includes(item.value));
console.log(JSON.stringify({ checks: results, ok: failed.length === 0 }, null, 2));
if (failed.length > 0) process.exitCode = 1;
