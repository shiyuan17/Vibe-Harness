#!/usr/bin/env node
import { validateDocumentation } from './lib/docs-validation.js';

let report;
try {
  report = await validateDocumentation({ rootDir: process.cwd() });
} catch (error) {
  console.error(JSON.stringify({
    documentationErrors: [error instanceof Error ? error.message : String(error)],
    ok: false,
    warnings: [],
  }, null, 2));
  process.exit(1);
}
if (!report.ok) {
  console.error(JSON.stringify({
    documentationErrors: report.errors,
    ok: false,
    warnings: report.warnings,
  }, null, 2));
  process.exit(1);
}

console.log(`Cognis documentation audit passed (${report.counts.cataloged} documents checked).`);
for (const warning of report.warnings) console.warn(`Warning: ${warning}`);
