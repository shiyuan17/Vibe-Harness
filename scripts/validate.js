#!/usr/bin/env node
import { validatePack } from './lib/pack-validation.js';
import { checkSelfInstallConformance } from './lib/self-install-check.js';

const rootDir = process.cwd();
const selfInstallSelected = process.argv.includes('--self-install');
const report = await validatePack(rootDir, { selfInstall: selfInstallSelected });

if (!report.ok) {
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

// Pack validation covers the assets; this covers the repository's own installed
// copy of them, which is where generated content (the managed AGENTS.md block,
// rendered targets) drifts silently. See docs/rules/governance-core.md.
const selfInstall = selfInstallSelected ? await checkSelfInstallConformance(rootDir)
  : { ok: true, skipped: 'source-only; run validate --self-install or doctor for deployed conformance' };
if (!selfInstall.ok) {
  console.error(JSON.stringify({
    error: 'self-install drift: the installed copy of these targets no longer matches the installer output',
    selfInstall,
  }, null, 2));
  process.exit(1);
}

console.log('Workflow asset integrity', JSON.stringify(report.workflowScan));
console.log('Self-install conformance', JSON.stringify({
  orphanedStateTargets: selfInstall.orphanedStateTargets,
  skipped: selfInstall.skipped,
  targets: selfInstall.targets,
  unmanagedCount: selfInstall.unmanagedCount,
}));
console.log('Vibe-Harness validation passed.');
