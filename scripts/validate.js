#!/usr/bin/env node
import { validatePack } from './lib/pack-validation.js';
import { checkSelfInstallConformance } from './lib/self-install-check.js';

const rootDir = process.cwd();
const report = await validatePack(rootDir);

if (!report.ok) {
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

// Pack validation covers the assets; this covers the repository's own installed
// copy of them, which is where generated content (the managed AGENTS.md block,
// rendered targets) drifts silently. See docs/rules/governance-core.md.
const selfInstall = await checkSelfInstallConformance(rootDir);
if (!selfInstall.ok) {
  console.error(JSON.stringify({
    error: 'self-install drift: the installed copy of these targets no longer matches the installer output',
    selfInstall,
  }, null, 2));
  process.exit(1);
}

console.log('Workflow asset integrity', JSON.stringify(report.workflowScan));
console.log('Self-install conformance', JSON.stringify({
  skipped: selfInstall.skipped,
  targets: selfInstall.targets,
  unmanagedCount: selfInstall.unmanagedCount,
}));
console.log('Vibe-Harness validation passed.');
