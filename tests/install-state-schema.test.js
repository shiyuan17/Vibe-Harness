import './helpers/offline-tools.js';

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readInstallState, writeInstallState } from '../scripts/lib/install-state.js';

async function makeTempDir() {
  return mkdtemp(path.join(tmpdir(), 'cognis-install-state-schema-'));
}

async function writeCorruptState(target, state) {
  const stateDir = path.join(target, '.cognis');
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, 'install-state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

const validState = {
  adapter: 'codex',
  baseline: { id: '20260801T000000', manifest: '.agents/backup/20260801T000000/manifest.json' },
  files: [
    {
      backup: null,
      contentStrategy: 'managed-instruction-block',
      created: true,
      group: 'core',
      managedBlockHash: 'abc123',
      originalBackup: null,
      originalCreated: true,
      owner: 'cognis',
      previousHash: null,
      redZone: false,
      source: 'rules/core.md',
      sourceHash: 'source-hash',
      target: 'AGENTS.md',
      targetHash: 'target-hash',
      transactionId: 'txn-1',
    },
    {
      backup: '.cognis/backups/bk1/docs/rules/git-rules.md',
      contentStrategy: 'replace',
      created: false,
      group: 'rules',
      previousHash: 'prev-hash',
      redZone: true,
      source: 'rules/git-rules.md',
      sourceHash: 'src-hash',
      target: 'docs/rules/git-rules.md',
      targetHash: 'tgt-hash',
      transactionId: 'txn-1',
    },
  ],
  generatedDirectories: [
    { target: '.agents/runtime/tools/playwright/node_modules', ownerTarget: '.agents/runtime/tools/playwright/package.json' },
    { target: '.cognis/tool-state/chrome-devtools-mcp', ownerTarget: '.agents/runtime/tools/chrome-devtools-mcp/package.json', projectScoped: true },
  ],
  generatedFiles: [
    { target: '.agents/runtime/tools/playwright/package.json', targetHash: 'gen-hash' },
  ],
  installedAt: '2026-08-01T00:00:00.000Z',
  previewCapabilities: ['codebase-memory'],
  profile: 'full',
  requestedModules: ['agents', 'rules'],
  requestedPlugins: ['codebase-memory'],
  resolvedModules: ['agents', 'rules', 'codebase-memory'],
  retiredFiles: [
    { backup: '.cognis/backups/bk2/old.md', group: 'legacy', redZone: false, target: 'old.md', targetHash: 'old-hash' },
  ],
  rtkHooksEnabled: false,
  transactionId: 'txn-1',
  version: '0.5.0',
};

test('readInstallState accepts a well-formed state written by writeInstallState', async () => {
  const target = await makeTempDir();
  try {
    await writeInstallState(target, validState);
    const state = await readInstallState(target);
    assert.equal(state.product, 'cognis');
    assert.equal(state.storageNamespace, 'cognis');
    assert.equal(state.stateVersion, 4);
    assert.equal(state.files.length, 2);
    assert.equal(state.files[0].contentStrategy, 'managed-instruction-block');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('readInstallState tolerates a minimal legacy state missing optional fields', async () => {
  const target = await makeTempDir();
  try {
    const legacy = {
      files: [
        {
          created: true,
          group: 'skills-core',
          redZone: false,
          source: 'skills/core/using-cognis/SKILL.md',
          sourceHash: 'src',
          target: '.agents/skills/using-cognis/SKILL.md',
          targetHash: 'tgt',
        },
      ],
      installedAt: '2026-01-01T00:00:00.000Z',
      profile: 'full',
      version: '0.2.0',
    };
    await writeInstallState(target, legacy);
    const state = await readInstallState(target);
    assert.equal(state.files[0].contentStrategy, undefined);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('readInstallState rejects a state with an unknown top-level property', async () => {
  const target = await makeTempDir();
  try {
    await writeCorruptState(target, { ...validState, rogueField: true });
    await assert.rejects(() => readInstallState(target), /install-state.json is corrupt.*rogueField/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('readInstallState rejects a state with non-string product', async () => {
  const target = await makeTempDir();
  try {
    await writeCorruptState(target, { ...validState, product: 42 });
    await assert.rejects(() => readInstallState(target), /install-state.json is corrupt.*product/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('readInstallState rejects a state with non-integer stateVersion', async () => {
  const target = await makeTempDir();
  try {
    await writeCorruptState(target, { ...validState, stateVersion: 'four' });
    await assert.rejects(() => readInstallState(target), /install-state.json is corrupt.*stateVersion/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('readInstallState tolerates a legacy pre-v4 state for migration', async () => {
  const target = await makeTempDir();
  try {
    const legacy = {
      adapter: 'codex',
      files: [],
      generatedDirectories: [],
      profile: 'codex-internal',
      stateVersion: 2,
      version: '0.3.0',
    };
    await writeCorruptState(target, legacy);
    const state = await readInstallState(target);
    assert.equal(state.stateVersion, 2);
    assert.equal(state.profile, 'full');
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('readInstallState rejects a state with invalid contentStrategy enum', async () => {
  const target = await makeTempDir();
  try {
    await writeCorruptState(target, {
      ...validState,
      files: [{ ...validState.files[0], contentStrategy: 'managed-bogus' }],
    });
    await assert.rejects(() => readInstallState(target), /install-state.json is corrupt.*contentStrategy/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('readInstallState rejects a state with non-array files', async () => {
  const target = await makeTempDir();
  try {
    await writeCorruptState(target, { ...validState, files: 'not-an-array' });
    await assert.rejects(() => readInstallState(target), /install-state.json is corrupt.*files/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('readInstallState rejects a state with a file entry containing an extra property', async () => {
  const target = await makeTempDir();
  try {
    await writeCorruptState(target, {
      ...validState,
      files: [{ ...validState.files[0], unexpected: true }],
    });
    await assert.rejects(() => readInstallState(target), /install-state.json is corrupt.*unexpected/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('readInstallState rejects a state with non-string adapter', async () => {
  const target = await makeTempDir();
  try {
    await writeCorruptState(target, { ...validState, adapter: 42 });
    await assert.rejects(() => readInstallState(target), /install-state.json is corrupt.*adapter/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('readInstallState rejects a state with malformed retiredFiles entry', async () => {
  const target = await makeTempDir();
  try {
    await writeCorruptState(target, {
      ...validState,
      retiredFiles: [{ target: 'old.md', rogue: true }],
    });
    await assert.rejects(() => readInstallState(target), /install-state.json is corrupt.*retiredFiles/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('readInstallState returns null when no state file exists', async () => {
  const target = await makeTempDir();
  try {
    const state = await readInstallState(target);
    assert.equal(state, null);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});
