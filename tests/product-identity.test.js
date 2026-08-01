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

test('Vibe-Harness identity exposes only canonical project surfaces', () => {
  assert.deepEqual(productIdentity, {
    agentRuntimeDir: '.agents/runtime',
    chineseName: 'Vibe-Harness',
    command: 'vibe-harness',
    configFile: 'vibe-harness.config.json',
    managedMarker: 'VIBE_HARNESS',
    name: 'Vibe-Harness',
    packageName: '@jw/vibe-harness',
    stateDir: '.vibe-harness',
  });
  assert.deepEqual(readProductEnv({ VIBE_HARNESS_TOOL_TIMEOUT_MS: '3000', LOOPENGINE_TOOL_TIMEOUT_MS: '1000' }, 'TOOL_TIMEOUT_MS'), {
    name: 'VIBE_HARNESS_TOOL_TIMEOUT_MS', value: '3000',
  });
  assert.deepEqual(readProductEnv({ LOOPENGINE_TOOL_TIMEOUT_MS: '1000' }, 'TOOL_TIMEOUT_MS'), {
    name: 'VIBE_HARNESS_TOOL_TIMEOUT_MS', value: undefined,
  });
});

test('legacy project assets are rejected without migration or namespace fallback', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-legacy-assets-'));
  try {
    await writeFile(path.join(target, 'loopengine.config.json'), '{}\n', 'utf8');
    await assert.rejects(assertNoUnsupportedLegacyAssets(target), (error) => error.code === 'VIBE_HARNESS_LEGACY_UNSUPPORTED');
    assert.equal(await resolveProjectConfigLocation(target), null);
    assert.equal(await resolveProjectStateLocation(target), null);
    assert.equal(await exists(path.join(target, '.vibe-harness')), false);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('fresh configuration and state use Vibe-Harness paths only', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-canonical-assets-'));
  try {
    const written = await writeDefaultProjectConfig({ projectDir: target });
    assert.equal(written.path, path.join(target, 'vibe-harness.config.json'));
    assert.equal(await exists(path.join(target, 'loopengine.config.json')), false);
    await writeInstallState(target, { files: [], profile: 'core', version: '0.5.0' });
    assert.equal(stateFilePath(target), path.join(target, '.vibe-harness', 'install-state.json'));
    const state = JSON.parse(await readFile(stateFilePath(target), 'utf8'));
    assert.equal(state.storageNamespace, 'vibe-harness');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('managed outputs use Vibe-Harness markers only', () => {
  assert.match(renderManagedInstructionBlock('managed'), /<!-- VIBE_HARNESS:START -->[\s\S]*<!-- VIBE_HARNESS:END -->/u);
  assert.match(mergeManagedMcpBlock('', { example: { args: ['server.js'], command: 'node' } }).content, /# VIBE_HARNESS:MCP:START/u);
});
