#!/usr/bin/env node
const results = ['PRODUCT_RESULT', 'SUPPLY_CHAIN_RESULT', 'RISK_EVIDENCE_RESULT']
  .map((name) => ({ name, value: process.env[name] }));
const failed = results.filter((item) => item.value !== 'success');
console.log(JSON.stringify({ checks: results, ok: failed.length === 0 }, null, 2));
if (failed.length > 0) process.exitCode = 1;
