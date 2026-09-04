#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

import { discoverExecutables } from './lib/executable-discovery.js';
import { scanWorkflowAssets } from './lib/workflow-assets.js';
import { runSkillsAudit, skillScanSummary } from './lib/skills-audit.js';

const files = await discoverExecutables(process.cwd());
const workflowScan = await scanWorkflowAssets(process.cwd());
const skillScan = skillScanSummary(await runSkillsAudit(process.cwd()));
let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(result.stderr || result.stdout);
  }
}
if (workflowScan.findings.length > 0) {
  failed = true;
  console.error(JSON.stringify({ workflowScan }, null, 2));
}
if (skillScan.findings.length > 0) {
  failed = true;
  console.error(JSON.stringify({ skillScan }, null, 2));
}
if (failed) process.exit(1);
console.log('Workflow asset scan', JSON.stringify(workflowScan));
console.log('Skill asset scan', JSON.stringify(skillScan));
console.log(`Vibe-Harness lint passed (${files.length} files checked).`);
