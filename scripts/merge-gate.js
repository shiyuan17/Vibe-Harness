#!/usr/bin/env node
// Aggregate result reader for the required merge-gate check.
//
// The workflow exports one <NAME>_RESULT variable per gate job, plus a
// REQUIRED_<NAME>_RESULT flag that is `false` when the job is not applicable to
// the event. Each invocation declares which gate set it aggregates through
// MERGE_GATE_SCOPE, so wiring drift fails closed: a name the scope expects but
// the workflow did not export is a failure, and an exported <NAME>_RESULT that
// is not part of the scope is reported as drift instead of being ignored.
import { GATE_SCOPES } from './lib/merge-gate-scopes.js';

const scopeName = process.env.MERGE_GATE_SCOPE;
const scope = GATE_SCOPES[scopeName] ?? null;
const checks = [];
const drift = [];
if (!scope) {
  drift.push({
    code: 'MERGE_GATE_SCOPE_UNKNOWN',
    message: `MERGE_GATE_SCOPE must be one of: ${Object.keys(GATE_SCOPES).join(', ')}`,
  });
} else {
  for (const name of scope) {
    if (process.env[name] === undefined) {
      drift.push({
        code: 'MERGE_GATE_EXPORT_MISSING',
        name,
        message: `${name} was not exported by the workflow; a missing gate result is not a pass.`,
      });
      continue;
    }
    checks.push({
      name,
      value: process.env[name],
      required: process.env[`REQUIRED_${name}`] !== 'false',
    });
  }
  for (const name of Object.keys(process.env)) {
    if (!name.endsWith('_RESULT') || name.startsWith('REQUIRED_')) continue;
    if (!scope.includes(name)) {
      drift.push({
        code: 'MERGE_GATE_EXPORT_UNEXPECTED',
        name,
        message: `${name} does not belong to the ${scopeName} scope.`,
      });
    }
  }
}
const failed = checks.filter((item) => item.value !== 'success'
  && !(item.value === 'skipped' && !item.required));
const ok = failed.length === 0 && drift.length === 0;
console.log(JSON.stringify({ scope: scopeName ?? null, checks, drift, ok }, null, 2));
if (!ok) process.exitCode = 1;
