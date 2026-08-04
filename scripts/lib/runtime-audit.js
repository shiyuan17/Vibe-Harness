import { spawn } from 'node:child_process';
import path from 'node:path';

import { pathExists } from './manifest.js';

const REGISTRY = 'https://registry.npmjs.org';
const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
const RUNTIMES = [
  { directory: 'codebase-memory-mcp', id: 'codebase-memory-mcp' },
  { directory: 'chrome-devtools-mcp', id: 'chrome-devtools-mcp' },
  { directory: 'playwright-cli', id: 'playwright-cli' },
  { directory: 'open-code-review', id: 'open-code-review' },
  { directory: 'ast-grep', id: 'ast-grep' },
];

function emptyCounts() {
  return { critical: 0, high: 0, info: 0, low: 0, moderate: 0, total: 0 };
}

function normalizeCounts(payload) {
  const raw = payload?.metadata?.vulnerabilities;
  if (!raw || typeof raw !== 'object') throw new Error('npm audit output is missing vulnerability metadata');
  const counts = emptyCounts();
  for (const severity of SEVERITIES) {
    if (!Number.isInteger(raw[severity]) || raw[severity] < 0) {
      throw new Error(`npm audit output has invalid ${severity} count`);
    }
    counts[severity] = raw[severity];
  }
  counts.total = SEVERITIES.reduce((total, severity) => total + counts[severity], 0);
  return counts;
}

function advisoryIds(payload) {
  const ids = new Set();
  for (const vulnerability of Object.values(payload?.vulnerabilities ?? {})) {
    for (const via of vulnerability?.via ?? []) {
      if (via && typeof via === 'object') ids.add(String(via.source ?? via.url ?? via.name));
    }
  }
  return [...ids].filter(Boolean).sort();
}

export async function resolveNpmAuditInvocation(args, {
  execPath = process.execPath,
  pathExists: exists = pathExists,
  platform = process.platform,
} = {}) {
  if (platform !== 'win32') return { args, command: 'npm' };
  const candidates = [
    path.join(path.dirname(execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(execPath), '../node_modules/npm/bin/npm-cli.js'),
  ];
  const npmCli = (await Promise.all(candidates.map(async (candidate) => await exists(candidate) ? candidate : null))).find(Boolean);
  if (!npmCli) throw new Error('npm is unavailable');
  return { args: [npmCli, ...args], command: execPath };
}

export async function runNpmAudit({ args, cwd }) {
  let invocation;
  try {
    invocation = await resolveNpmAuditInvocation(args);
  } catch (error) {
    return { error: error.message, exitCode: null, stderr: '', stdout: '' };
  }
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(invocation.command, invocation.args, { cwd, env: process.env, shell: false, windowsHide: true });
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ error: error.message, exitCode: null, stderr, stdout }));
    child.on('close', (exitCode) => resolve({ exitCode, stderr, stdout }));
  });
}

async function auditSurface(rootDir, runtime, surface, runAudit) {
  const args = ['audit', '--package-lock-only', '--audit-level=high', '--json', `--registry=${REGISTRY}`];
  const request = {
    args,
    cwd: path.join(rootDir, 'runtime/tools', runtime.directory),
    id: runtime.id,
    surface,
  };
  const result = await runAudit(request);
  if (result.error) throw new Error(`npm audit failed to start: ${result.error}`);
  if (!result.stdout?.trim()) throw new Error('npm audit did not return JSON');
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error('npm audit returned invalid JSON');
  }
  const counts = normalizeCounts(payload);
  if (![0, 1].includes(result.exitCode)) throw new Error(`npm audit failed with exit code ${result.exitCode}`);
  return { advisories: advisoryIds(payload), counts };
}

export async function auditRuntimeTools(rootDir, { runAudit = runNpmAudit } = {}) {
  const blocking = [];
  const errors = [];
  const tools = [];
  const warnings = [];

  for (const runtime of RUNTIMES) {
    try {
      const installed = await auditSurface(rootDir, runtime, 'installed', runAudit);
      const tool = { advisories: installed.advisories, id: runtime.id, installed: installed.counts };
      tools.push(tool);
      if (installed.counts.critical > 0 || installed.counts.high > 0) {
        blocking.push({ critical: installed.counts.critical, high: installed.counts.high, id: runtime.id });
      }
      if (installed.counts.moderate > 0) warnings.push({ id: runtime.id, moderate: installed.counts.moderate });
    } catch (error) {
      errors.push({ id: runtime.id, message: error.message });
    }
  }

  return { blocking, errors, ok: blocking.length === 0 && errors.length === 0, tools, warnings };
}
