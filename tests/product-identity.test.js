import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { productIdentity, readProductEnv } from '../scripts/lib/product-identity.js';
import { assertNoUnsupportedLegacyAssets, resolveProjectConfigLocation, resolveProjectStateLocation } from '../scripts/lib/project-layout.js';
import { writeDefaultProjectConfig } from '../scripts/lib/project-config.js';
import { stateFilePath, writeInstallState } from '../scripts/lib/install-state.js';
import { renderManagedInstructionBlock } from '../scripts/lib/template-renderer.js';
import { mergeManagedMcpBlock } from '../scripts/lib/tool-provisioning.js';

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

test('Cognis identity exposes only canonical project surfaces', () => {
  assert.deepEqual(productIdentity, {
    agentRuntimeDir: '.agents/runtime',
    chineseName: '智序',
    command: 'cognis',
    configFile: 'cognis.config.json',
    managedMarker: 'COGNIS',
    name: 'Cognis',
    packageName: '@jw/cognis',
    stateDir: '.cognis',
  });
  assert.deepEqual(readProductEnv({ COGNIS_TOOL_TIMEOUT_MS: '3000', LOOPENGINE_TOOL_TIMEOUT_MS: '1000' }, 'TOOL_TIMEOUT_MS'), {
    name: 'COGNIS_TOOL_TIMEOUT_MS', value: '3000',
  });
  assert.deepEqual(readProductEnv({ LOOPENGINE_TOOL_TIMEOUT_MS: '1000' }, 'TOOL_TIMEOUT_MS'), {
    name: 'COGNIS_TOOL_TIMEOUT_MS', value: undefined,
  });
});

test('legacy project assets are rejected without migration or namespace fallback', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-legacy-assets-'));
  try {
    await writeFile(path.join(target, 'loopengine.config.json'), '{}\n', 'utf8');
    await assert.rejects(assertNoUnsupportedLegacyAssets(target), (error) => error.code === 'COGNIS_LEGACY_UNSUPPORTED');
    assert.equal(await resolveProjectConfigLocation(target), null);
    assert.equal(await resolveProjectStateLocation(target), null);
    assert.equal(await exists(path.join(target, '.cognis')), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('fresh configuration and state use Cognis paths only', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'cognis-canonical-assets-'));
  try {
    const written = await writeDefaultProjectConfig({ projectDir: target });
    assert.equal(written.path, path.join(target, 'cognis.config.json'));
    assert.equal(await exists(path.join(target, 'loopengine.config.json')), false);
    await writeInstallState(target, { files: [], profile: 'core', version: '0.5.0' });
    assert.equal(stateFilePath(target), path.join(target, '.cognis', 'install-state.json'));
    const state = JSON.parse(await readFile(stateFilePath(target), 'utf8'));
    assert.equal(state.storageNamespace, 'cognis');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('managed outputs use Cognis markers only', () => {
  assert.match(renderManagedInstructionBlock('managed'), /<!-- COGNIS:START -->[\s\S]*<!-- COGNIS:END -->/u);
  assert.match(mergeManagedMcpBlock('', { example: { args: ['server.js'], command: 'node' } }).content, /# COGNIS:MCP:START/u);
});
