import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { auditCleanup, mapCatalogEvidence } from '../../scripts/lib/cleanup-audit.js';
import { readJson, validateJsonAgainstSchema } from '../../scripts/lib/manifest.js';
import { runProjectAudit } from '../../scripts/lib/project-audit.js';

const rootDir = path.resolve(import.meta.dirname, '../..');
const execFileAsync = promisify(execFile);

async function temporaryProject() {
  return mkdtemp(path.join(os.tmpdir(), 'vibe-harness-cleanup-'));
}

async function gitProject() {
  const project = await temporaryProject();
  await execFileAsync('git', ['init'], { cwd: project, windowsHide: true });
  await execFileAsync('git', ['config', 'user.email', 'cleanup@example.invalid'], { cwd: project, windowsHide: true });
  await execFileAsync('git', ['config', 'user.name', 'Cleanup Test'], { cwd: project, windowsHide: true });
  await writeFile(path.join(project, '.gitignore'), '.vibe-harness/\nignored/\n', 'utf8');
  return project;
}

async function snapshotProject(directory) {
  const entries = [];
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      const content = await readFile(fullPath);
      entries.push(`${createHash('sha256').update(content).digest('hex')}  ${path.relative(directory, fullPath)}`);
    }
  };
  await walk(directory);
  return entries.sort();
}

function codesOf(report) {
  return report.evidence.map((entry) => entry.code);
}

test('cleanup audit confirms missing references and separates heuristic candidates', async () => {
  const project = await gitProject();
  await mkdir(path.join(project, 'scripts'), { recursive: true });
  await writeFile(
    path.join(project, 'scripts/entry.js'),
    "import { helper } from './lib/helper.js';\nimport { gone } from './lib/gone.js';\nconsole.log(helper);\n",
    'utf8',
  );
  await mkdir(path.join(project, 'scripts/lib'), { recursive: true });
  await writeFile(path.join(project, 'scripts/lib/helper.js'), 'export function helper() { return 1; }\n', 'utf8');
  await writeFile(path.join(project, 'scripts/lib/leftover.js'), 'export function orphan() { return 2; }\n', 'utf8');

  const report = await auditCleanup({ rootDir: project, targetDir: project });
  const codes = codesOf(report);
  assert.equal(codes.includes('CLEANUP_REFERENCE_MISSING'), true);
  assert.equal(codes.includes('CLEANUP_UNREFERENCED_FILE'), true);

  const missing = report.evidence.find((entry) => entry.code === 'CLEANUP_REFERENCE_MISSING');
  assert.equal(missing.path, 'scripts/lib/gone.js');
  assert.equal(missing.severity, 'error');
  const candidate = report.evidence.find((entry) => entry.code === 'CLEANUP_UNREFERENCED_FILE');
  assert.equal(candidate.severity, 'info');
  assert.equal(report.status, 'degraded');
  assert.equal(report.details.confirmedFindings > 0, true);
  assert.equal(report.details.candidateFindings > 0, true);
});

test('cleanup audit ignores ignored directories and test fixture paths', async () => {
  const project = await gitProject();
  await mkdir(path.join(project, 'ignored'), { recursive: true });
  await writeFile(path.join(project, 'ignored/leftover.md'), '# leftover\n', 'utf8');
  await mkdir(path.join(project, 'tests'), { recursive: true });
  await writeFile(
    path.join(project, 'tests/example.test.js'),
    "import { mkdir } from 'node:fs/promises';\nassert.equal(target, 'docs/absent.md');\n",
    'utf8',
  );

  const report = await auditCleanup({ rootDir: project, targetDir: project });
  const paths = report.evidence.map((entry) => entry.path ?? '');
  assert.equal(paths.some((entry) => entry.startsWith('ignored/')), false);
  assert.equal(paths.some((entry) => entry.startsWith('.vibe-harness/')), false);
  assert.equal(codesOf(report).includes('CLEANUP_REFERENCE_MISSING'), false);
});

test('cleanup audit resolves document links against the linking file', async () => {
  const project = await gitProject();
  await mkdir(path.join(project, 'docs/memory'), { recursive: true });
  await mkdir(path.join(project, 'memory'), { recursive: true });
  await writeFile(path.join(project, 'memory/README.md'), '# Memory\n', 'utf8');
  await writeFile(path.join(project, 'docs/memory/STATE.md'), '# State\n', 'utf8');
  await writeFile(
    path.join(project, 'docs/README.md'),
    '# Docs\n\n- [状态](memory/STATE.md)\n- [缺失](memory/GONE.md)\n',
    'utf8',
  );

  const report = await auditCleanup({ rootDir: project, targetDir: project });
  const missing = report.evidence.filter((entry) => entry.code === 'CLEANUP_REFERENCE_MISSING');
  assert.deepEqual(missing.map((entry) => entry.path), ['memory/GONE.md']);
});

test('cleanup audit treats configuration examples outside the scan surface as declarations', async () => {
  const project = await gitProject();
  await mkdir(path.join(project, 'docs/rules'), { recursive: true });
  await mkdir(path.join(project, 'scripts'), { recursive: true });
  await writeFile(
    path.join(project, 'docs/guide.md'),
    '# Guide\n\n```json\n{ "path": "docs/rules/gone-rule.md" }\n```\n',
    'utf8',
  );
  await writeFile(
    path.join(project, 'scripts/config.js'),
    "export const defaults = { evaluations: { reference: 'evals/references/project.json' } };\n",
    'utf8',
  );

  const report = await auditCleanup({ rootDir: project, targetDir: project });
  assert.equal(codesOf(report).includes('CLEANUP_REFERENCE_MISSING'), false);
});

test('cleanup audit measures code index freshness from the index artifact', async () => {
  const project = await gitProject();
  await writeFile(path.join(project, '.gitignore'), '.vibe-harness/\nignored/\n.codebase-memory/\n', 'utf8');
  await execFileAsync('git', ['add', '.'], { cwd: project, windowsHide: true });
  await execFileAsync('git', ['commit', '-m', 'test: seed index fixture'], { cwd: project, windowsHide: true });
  const { stdout: head } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: project, windowsHide: true });

  const unavailable = await auditCleanup({ rootDir: project, targetDir: project });
  assert.deepEqual(
    unavailable.evidence.filter((entry) => entry.code.startsWith('CLEANUP_INDEX_')).map((entry) => entry.code),
    ['CLEANUP_INDEX_UNAVAILABLE'],
  );

  await mkdir(path.join(project, '.codebase-memory'), { recursive: true });
  await writeFile(
    path.join(project, '.codebase-memory/artifact.json'),
    JSON.stringify({ commit: head.trim(), indexed_at: new Date().toISOString() }),
    'utf8',
  );
  const current = await auditCleanup({ rootDir: project, targetDir: project });
  assert.deepEqual(current.evidence.filter((entry) => entry.code.startsWith('CLEANUP_INDEX_')), []);

  await writeFile(
    path.join(project, '.codebase-memory/artifact.json'),
    JSON.stringify({ commit: '0'.repeat(40), indexed_at: new Date().toISOString() }),
    'utf8',
  );
  const stale = await auditCleanup({ rootDir: project, targetDir: project });
  const staleIndex = stale.evidence.find((entry) => entry.code === 'CLEANUP_INDEX_STALE');
  assert.equal(staleIndex.severity, 'warning');
  assert.equal(staleIndex.path, '.codebase-memory/artifact.json');
});

test('cleanup audit maps documentation catalog drift to cleanup codes', async () => {
  const project = await temporaryProject();
  await mkdir(path.join(project, 'docs'), { recursive: true });
  await writeFile(path.join(project, 'docs/current.md'), '# Current\n', 'utf8');
  const evidence = mapCatalogEvidence({
    counts: {},
    errors: [
      'catalog documentation does not exist: docs/removed.md',
      'governed documentation is missing from catalog: docs/current.md',
      'docs/current.md references missing current asset: docs/gone.md',
    ],
    ok: false,
    warnings: [],
  });
  assert.deepEqual(evidence.map((entry) => entry.code), [
    'CLEANUP_DOC_ORPHAN',
    'CLEANUP_DOC_UNCATALOGED',
    'CLEANUP_REFERENCE_MISSING',
  ]);
  assert.deepEqual(evidence.map((entry) => entry.path), ['docs/removed.md', 'docs/current.md', 'docs/gone.md']);
});

test('cleanup audit never mutates the project it scans', async () => {
  const project = await gitProject();
  await mkdir(path.join(project, 'scripts'), { recursive: true });
  await writeFile(path.join(project, 'scripts/leftover.js'), 'export const LEFTOVER_VALUE = 1;\n', 'utf8');
  await execFileAsync('git', ['add', '.'], { cwd: project, windowsHide: true });
  await execFileAsync('git', ['commit', '-m', 'test: seed cleanup fixture'], { cwd: project, windowsHide: true });
  const before = await snapshotProject(project);
  await auditCleanup({ rootDir: project, targetDir: project });
  assert.deepEqual(await snapshotProject(project), before);
  const status = await execFileAsync('git', ['status', '--porcelain'], { cwd: project, windowsHide: true });
  assert.equal(status.stdout.trim(), '');
});

test('cleanup audit output validates against the audit report schema', async () => {
  const project = await gitProject();
  await writeFile(path.join(project, 'app.js'), "import './lib/missing-module.js';\n", 'utf8');
  const report = await runProjectAudit({ kind: 'cleanup', rootDir, targetDir: project });
  assert.equal(report.kind, 'cleanup');
  assert.equal(report.readOnly, true);
  assert.deepEqual(report.written, []);
  const schema = await readJson(path.join(rootDir, 'schemas/audit-report.schema.json'));
  assert.deepEqual(validateJsonAgainstSchema(report, schema, 'cleanup report'), []);
});

test('cleanup stays read-only and rejects write mode', async () => {
  const project = await gitProject();
  await assert.rejects(
    runProjectAudit({ kind: 'cleanup', rootDir, targetDir: project, write: true }),
    /only allowed/u,
  );
  const before = await stat(project);
  const report = await runProjectAudit({ kind: 'cleanup', rootDir, targetDir: project });
  assert.equal(report.readOnly, true);
  assert.ok((await stat(project)).mtimeMs >= before.mtimeMs);
});

test('aggregate audit keeps cleanup out of the default all-kind receipt', async () => {
  const project = await gitProject();
  const report = await runProjectAudit({ kind: 'all', rootDir, targetDir: project });
  assert.equal(Object.hasOwn(report.details, 'cleanup'), false);
  assert.equal(Object.hasOwn(report.details, 'memory'), true);
});
