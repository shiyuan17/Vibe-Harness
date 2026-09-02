#!/usr/bin/env node
import { syncRules } from './lib/sync-rules.js';

const report = await syncRules(process.cwd());
for (const name of report.updated) console.log(`Updated docs/rules/${name}`);
for (const item of report.skipped) console.log(`Skipped rules/${item.name} (${item.reason})`);
for (const name of report.unpaired) console.warn(`Warning: docs/rules/${name} has no rules/ source counterpart`);
if (report.updated.length > 0) {
  console.log(`Rules mirror synced: ${report.updated.length} updated, ${report.inSync.length} already in sync.`);
} else {
  console.log(`Rules mirror already in sync (${report.inSync.length} files).`);
}
if (report.unpaired.length > 0) process.exitCode = 1;
