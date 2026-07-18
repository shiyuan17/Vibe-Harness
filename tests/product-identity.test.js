import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { productIdentity, readProductEnv } from '../scripts/lib/product-identity.js';
import { resolveProjectConfigLocation, resolveProjectStateLocation } from '../scripts/lib/project-layout.js';
import {
  readProjectConfig,
  writeDefaultProjectConfig,
} from '../scripts/lib/project-config.js';
import {
  readInstallState,
  stateFilePath,
  writeInstallState,
} from '../scripts/lib/install-state.js';
import {
  mergeManagedInstructionBlock,
  renderManagedInstructionBlock,
} from '../scripts/lib/template-renderer.js';
import { mergeManagedMcpBlock } from '../scripts/lib/tool-provisioning.js';

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

test('Cognis identity defines canonical and legacy project surfaces', () => {
  assert.equal(productIdentity.name, 'Cognis');
  assert.equal(productIdentity.chineseName, '智序');
  assert.equal(productIdentity.command, 'cognis');
  assert.equal(productIdentity.packageName, '@jw/cognis');
  assert.equal(productIdentity.configFile, 'cognis.config.json');
  assert.equal(productIdentity.stateDir, '.cognis');
  assert.equal(productIdentity.agentRuntimeDir, '.agents/cognis');
  assert.equal(productIdentity.legacy.configFile, 'loopengine.config.json');
  assert.equal(productIdentity.legacy.stateDir, '.loopengine');
});

test('canonical Cognis environment variables take precedence over legacy aliases', () => {
  assert.deepEqual(
    readProductEnv({ COGNIS_TOOL_TIMEOUT_MS: '3000', LOOPENGINE_TOOL_TIMEOUT_MS: '1000' }, 'TOOL_TIMEOUT_MS'),
    { deprecated: false, name: 'COGNIS_TOOL_TIMEOUT_MS', value: '3000' },
  );
  assert.deepEqual(
    readProductEnv({ LOOPENGINE_TOOL_TIMEOUT_MS: '1000' }, 'TOOL_TIMEOUT_MS'),
    { deprecated: true, name: 'LOOPENGINE_TOOL_TIMEOUT_MS', value: '1000' },
  );
});

test('project config location accepts either namespace and rejects ambiguity', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-config-layout-'));
  try {
    assert.deepEqual(await resolveProjectConfigLocation(target), null);

    const legacyPath = path.join(target, 'loopengine.config.json');
    await writeFile(legacyPath, '{}\n', 'utf8');
    assert.deepEqual(await resolveProjectConfigLocation(target), {
      legacy: true,
      namespace: 'loopengine',
      path: legacyPath,
    });

    const canonicalPath = path.join(target, 'cognis.config.json');
    await writeFile(canonicalPath, '{}\n', 'utf8');
    await assert.rejects(
      resolveProjectConfigLocation(target),
      (error) => error.code === 'COGNIS_CONFIG_CONFLICT',
    );
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('project state location keeps legacy installations in their original namespace', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-state-layout-'));
  try {
    const legacyDir = path.join(target, '.loopengine');
    await mkdir(legacyDir);
    await writeFile(path.join(legacyDir, 'install-state.json'), '{}\n', 'utf8');
    assert.deepEqual(await resolveProjectStateLocation(target), {
      dir: legacyDir,
      legacy: true,
      namespace: 'loopengine',
      path: path.join(legacyDir, 'install-state.json'),
    });

    const canonicalDir = path.join(target, '.cognis');
    await mkdir(canonicalDir);
    await writeFile(path.join(canonicalDir, 'install-state.json'), '{}\n', 'utf8');
    await assert.rejects(
      resolveProjectStateLocation(target),
      (error) => error.code === 'COGNIS_STATE_CONFLICT',
    );
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('project config writes the Cognis filename and still reads a legacy filename', async () => {
  const canonicalTarget = await mkdtemp(path.join(tmpdir(), 'cognis-config-write-'));
  const legacyTarget = await mkdtemp(path.join(tmpdir(), 'cognis-config-read-legacy-'));
  try {
    const written = await writeDefaultProjectConfig({ projectDir: canonicalTarget });
    assert.equal(written.path, path.join(canonicalTarget, 'cognis.config.json'));
    assert.equal(await exists(path.join(canonicalTarget, 'loopengine.config.json')), false);
    assert.equal(written.config.validationCommands.governance, 'node .agents/cognis/governance/validate.mjs');

    const legacyConfig = { projectName: 'Legacy', target: 'codex', profile: 'core' };
    await writeFile(
      path.join(legacyTarget, 'loopengine.config.json'),
      `${JSON.stringify(legacyConfig)}\n`,
      'utf8',
    );
    assert.deepEqual(await readProjectConfig(legacyTarget), legacyConfig);
  } finally {
    await Promise.all([
      rm(canonicalTarget, { force: true, recursive: true }),
      rm(legacyTarget, { force: true, recursive: true }),
    ]);
  }
});

test('install state writes version 4 in the canonical namespace for fresh projects', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-state-write-'));
  try {
    assert.equal(stateFilePath(target), path.join(target, '.cognis', 'install-state.json'));
    await writeInstallState(target, { files: [], profile: 'core', version: '0.5.0' });
    const state = JSON.parse(await readFile(path.join(target, '.cognis', 'install-state.json'), 'utf8'));
    assert.equal(state.stateVersion, 4);
    assert.equal(state.product, 'cognis');
    assert.equal(state.storageNamespace, 'cognis');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('install state preserves a legacy state namespace during upgrades', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-state-write-legacy-'));
  try {
    await mkdir(path.join(target, '.loopengine'));
    await writeFile(
      path.join(target, '.loopengine', 'install-state.json'),
      `${JSON.stringify({ files: [], profile: 'core', version: '0.4.0' })}\n`,
      'utf8',
    );
    await writeInstallState(target, { files: [], profile: 'core', version: '0.5.0' });
    const state = await readInstallState(target);
    assert.equal(state.stateVersion, 4);
    assert.equal(state.product, 'cognis');
    assert.equal(state.storageNamespace, 'loopengine');
    assert.equal(await exists(path.join(target, '.cognis', 'install-state.json')), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('managed instruction blocks write Cognis markers and replace legacy markers', () => {
  const rendered = renderManagedInstructionBlock('managed');
  assert.match(rendered, /<!-- COGNIS:START -->[\s\S]*<!-- COGNIS:END -->/u);

  const legacy = 'local\n\n<!-- LOOPENGINE:START -->\nold\n<!-- LOOPENGINE:END -->\n';
  const migrated = mergeManagedInstructionBlock(legacy, 'managed');
  assert.equal(migrated.includes('LOOPENGINE:'), false);
  assert.equal(migrated.includes('<!-- COGNIS:START -->'), true);
  assert.equal(migrated.includes('local'), true);
});

test('managed instruction blocks reject simultaneous Cognis and legacy ownership markers', () => {
  const ambiguous = [
    '<!-- LOOPENGINE:START -->',
    'legacy',
    '<!-- LOOPENGINE:END -->',
    '<!-- COGNIS:START -->',
    'canonical',
    '<!-- COGNIS:END -->',
    '',
  ].join('\n');

  assert.throws(
    () => mergeManagedInstructionBlock(ambiguous, 'managed'),
    (error) => error.code === 'COGNIS_MANAGED_BLOCK_CONFLICT',
  );
});

test('managed MCP blocks write Cognis markers and replace legacy markers', () => {
  const servers = { example: { args: ['server.js'], command: 'node' } };
  const fresh = mergeManagedMcpBlock('', servers).content;
  assert.equal(fresh.includes('# COGNIS:MCP:START'), true);

  const legacy = '# LOOPENGINE:MCP:START\n[mcp_servers.old]\ncommand = "old"\nargs = []\n# LOOPENGINE:MCP:END\n';
  const migrated = mergeManagedMcpBlock(legacy, servers).content;
  assert.equal(migrated.includes('LOOPENGINE:MCP'), false);
  assert.equal(migrated.includes('[mcp_servers.example]'), true);
});

test('managed MCP blocks reject simultaneous Cognis and legacy ownership markers', () => {
  const ambiguous = [
    '# LOOPENGINE:MCP:START',
    '# LOOPENGINE:MCP:END',
    '# COGNIS:MCP:START',
    '# COGNIS:MCP:END',
    '',
  ].join('\n');
  assert.throws(
    () => mergeManagedMcpBlock(ambiguous, {}),
    (error) => error.code === 'COGNIS_MCP_BLOCK_CONFLICT',
  );
});
