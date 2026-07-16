#!/usr/bin/env node
import path from 'node:path';

import { renderSkillsAudit, runSkillsAudit } from './lib/skills-audit.js';

const report = await runSkillsAudit(path.resolve('.'));
process.stdout.write(renderSkillsAudit(report));
if (report.errors.length > 0) {
  process.stderr.write(`${JSON.stringify({ errors: report.errors, ok: false }, null, 2)}\n`);
  process.exitCode = 1;
}
