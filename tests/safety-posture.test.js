import './helpers/offline-tools.js';

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { adapterSafetyPosture, safetyPostureWarnings } from '../scripts/lib/safety-posture.js';
import { loadAdapterCatalog } from '../scripts/lib/adapter.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '..');
const cliPath = path.join(rootDir, 'scripts/vibe-harness.js');

async function run(args) {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], { cwd: rootDir, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout);
}

const codex = {
  id: 'codex',
  capabilities: { hooks: 'stable', mcp: 'stable' },
  redZonePrefixes: ['.codex/'],
};
const claude = {
  id: 'claude',
  capabilities: { hooks: 'preview', mcp: 'preview' },
  redZonePrefixes: [],
};

test('adapterSafetyPosture marks codex as not degraded', () => {
  const posture = adapterSafetyPosture(codex);
  assert.equal(posture.degraded, false);
  assert.deepEqual(posture.reasons, []);
});

test('adapterSafetyPosture marks claude as degraded with both reasons', () => {
  const posture = adapterSafetyPosture(claude);
  assert.equal(posture.degraded, true);
  assert.equal(posture.reasons.length, 2);
  assert.match(posture.reasons[0], /hooks=preview/u);
  assert.match(posture.reasons[1], /redZonePrefixes is empty/u);
});

test('safetyPostureWarnings returns empty for codex and a warning for claude', () => {
  assert.deepEqual(safetyPostureWarnings(codex), []);
  const warnings = safetyPostureWarnings(claude);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'DEGRADED_SAFETY_POSTURE');
  assert.match(warnings[0].message, /claude/u);
});

test('every adapter in the catalog has a consistent safety posture assessment', async () => {
  const catalog = await loadAdapterCatalog(rootDir);
  for (const adapter of catalog.items) {
    const posture = adapterSafetyPosture(adapter);
    // codex is the reference adapter and must not be degraded.
    if (adapter.id === 'codex') {
      assert.equal(posture.degraded, false, 'codex should not be degraded');
    }
    // Adapters with stable hooks AND non-empty redZonePrefixes are not degraded.
    if (adapter.capabilities.hooks === 'stable' && adapter.redZonePrefixes.length > 0) {
      assert.equal(posture.degraded, false, `${adapter.id} should not be degraded`);
    }
    // Adapters without stable hooks or without redZonePrefixes are degraded.
    if (adapter.capabilities.hooks !== 'stable' || adapter.redZonePrefixes.length === 0) {
      assert.equal(posture.degraded, true, `${adapter.id} should be degraded`);
    }
  }
});

test('install --target claude dry-run emits a DEGRADED_SAFETY_POSTURE warning', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-safety-claude-'));
  try {
    await run(['init', '--project', target, '--target', 'claude', '--profile', 'core']);
    const preview = await run(['install', '--project', target, '--target', 'claude', '--profile', 'core', '--dry-run']);
    const codes = (preview.warnings ?? []).map((warning) => warning.code);
    assert.equal(codes.includes('DEGRADED_SAFETY_POSTURE'), true);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('install --target codex dry-run does not emit a DEGRADED_SAFETY_POSTURE warning', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-safety-codex-'));
  try {
    await run(['init', '--project', target, '--target', 'codex', '--profile', 'core']);
    const preview = await run(['install', '--project', target, '--target', 'codex', '--profile', 'core', '--dry-run']);
    const codes = (preview.warnings ?? []).map((warning) => warning.code);
    assert.equal(codes.includes('DEGRADED_SAFETY_POSTURE'), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('claude and gemini instruction templates document the degraded posture; codex does not', async () => {
  const [claude, gemini, codex] = await Promise.all([
    readFile(path.join(rootDir, 'adapters/claude/CLAUDE.template.md'), 'utf8'),
    readFile(path.join(rootDir, 'adapters/gemini/GEMINI.template.md'), 'utf8'),
    readFile(path.join(rootDir, 'adapters/codex/AGENTS.template.md'), 'utf8'),
  ]);
  const postureNote = /无运行时安全 Hook.*降级/u;
  assert.match(claude, postureNote);
  assert.match(gemini, postureNote);
  assert.doesNotMatch(codex, postureNote);
});

test('all platform instruction templates stay within the resident line budget', async () => {
  for (const [adapter, filename] of [['codex', 'AGENTS'], ['claude', 'CLAUDE'], ['gemini', 'GEMINI']]) {
    const content = await readFile(path.join(rootDir, 'adapters', adapter, `${filename}.template.md`), 'utf8');
    assert.equal(content.split(/\r?\n/u).length <= 90, true, `${filename}.md exceeds the resident line budget`);
  }
});
