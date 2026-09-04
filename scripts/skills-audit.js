#!/usr/bin/env node
import path from 'node:path';

import { renderSkillsAudit, runSkillsAudit, skillScanSummary } from './lib/skills-audit.js';

const report = await runSkillsAudit(path.resolve('.'));
process.stdout.write(renderSkillsAudit(report));
process.stdout.write('\nSkill asset scan ' + JSON.stringify(skillScanSummary(report)) + '\n');
if (report.errors.length > 0) {
  process.stderr.write(`${JSON.stringify({ errors: report.errors, ok: false }, null, 2)}\n`);
  process.exitCode = 1;
}
