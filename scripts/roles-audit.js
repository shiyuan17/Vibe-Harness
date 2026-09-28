#!/usr/bin/env node
import path from 'node:path';

import { renderRolesAudit, runRolesAudit } from './lib/roles-audit.js';

const report = await runRolesAudit(path.resolve('.'));
process.stdout.write(renderRolesAudit(report));
if (!report.ok) {
  process.stderr.write(JSON.stringify({ errors: report.errors, ok: false }, null, 2) + '\n');
  process.exitCode = 1;
}
