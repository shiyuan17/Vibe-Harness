import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const workflowExtension = /\.ya?ml$/iu;

export async function scanWorkflowAssets(rootDir) {
  const workflowDir = path.join(rootDir, '.github', 'workflows');
  let entries;
  try {
    entries = await readdir(workflowDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { findings: [], inventoryCount: 0, scannedCount: 0, status: 'out-of-scope' };
    }
    throw error;
  }
  const assets = entries.filter((entry) => entry.isFile() && workflowExtension.test(entry.name))
    .map((entry) => entry.name).sort();
  const findings = [];
  for (const asset of assets) {
    const content = await readFile(path.join(workflowDir, asset), 'utf8');
    if (!/^name\s*:/mu.test(content) || !/^(?:on|'on'|"on")\s*:/mu.test(content) || !/^jobs\s*:/mu.test(content)) {
      findings.push({ asset: '.github/workflows/' + asset, code: 'WORKFLOW_STRUCTURE_INCOMPLETE' });
    }
  }
  return {
    findings,
    inventoryCount: assets.length,
    scannedCount: assets.length,
    status: findings.length === 0 ? 'clean' : 'findings',
  };
}
