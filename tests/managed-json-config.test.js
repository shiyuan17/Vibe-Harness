import './helpers/offline-tools.js';

import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeManagedJsonConfig, removeManagedJsonConfig } from '../scripts/lib/managed-json-config.js';

const descriptor = {
  hookMarker: 'Vibe-Harness safety policy',
  hooksPath: ['hooks'],
  mcpPath: null,
  serverPrefix: 'vibe-harness-',
};

const hooks = {
  PreToolUse: [{ hooks: [{ type: 'command', command: 'node test.mjs', statusMessage: 'Vibe-Harness safety policy' }] }],
};

test('mergeManagedJsonConfig sets hooks.enabled when hooks are present', () => {
  const result = JSON.parse(mergeManagedJsonConfig('{}\n', descriptor, { hooks }));
  assert.equal(result.hooks.enabled, true);
  assert.ok(Array.isArray(result.hooks.PreToolUse));
});

test('mergeManagedJsonConfig sets hooks.enabled even when user config had it false', () => {
  const existing = JSON.stringify({ hooks: { enabled: false, custom: true } });
  const result = JSON.parse(mergeManagedJsonConfig(existing, descriptor, { hooks }));
  assert.equal(result.hooks.enabled, true);
  assert.equal(result.hooks.custom, true);
  assert.ok(Array.isArray(result.hooks.PreToolUse));
});

test('mergeManagedJsonConfig preserves user hooks and appends managed hooks', () => {
  const existing = JSON.stringify({
    hooks: {
      enabled: false,
      PreToolUse: [{ hooks: [{ type: 'command', command: 'user-hook.mjs', statusMessage: 'User policy' }] }],
    },
  });
  const result = JSON.parse(mergeManagedJsonConfig(existing, descriptor, { hooks }));
  assert.equal(result.hooks.enabled, true);
  assert.equal(result.hooks.PreToolUse.length, 2);
  assert.equal(result.hooks.PreToolUse[0].hooks[0].command, 'user-hook.mjs');
  assert.equal(result.hooks.PreToolUse[1].hooks[0].command, 'node test.mjs');
});

test('mergeManagedJsonConfig retires the managed Stop group and preserves user Stop hooks', () => {
  const existing = JSON.stringify({
    hooks: {
      Stop: [
        { hooks: [{ type: 'command', command: 'old-auto-commit.mjs', statusMessage: 'Vibe-Harness safety policy' }] },
        { hooks: [{ type: 'command', command: 'user-stop.mjs', statusMessage: 'User policy' }] },
      ],
    },
  });
  const result = JSON.parse(mergeManagedJsonConfig(existing, descriptor, { hooks }));
  assert.equal(result.hooks.Stop.length, 1);
  assert.equal(result.hooks.Stop[0].hooks[0].command, 'user-stop.mjs');
  assert.equal(result.hooks.PreToolUse.length, 1);
});

test('removeManagedJsonConfig clears enabled when no hook events remain', () => {
  const installed = mergeManagedJsonConfig('{}\n', descriptor, { hooks });
  const removed = JSON.parse(removeManagedJsonConfig(installed, descriptor));
  // Container is empty so deleteAtPathIfEmpty removes it entirely.
  assert.equal(Object.hasOwn(removed, 'hooks'), false);
});

test('removeManagedJsonConfig preserves user hooks and keeps enabled for them', () => {
  const existing = JSON.stringify({
    hooks: {
      enabled: true,
      PreToolUse: [{ hooks: [{ type: 'command', command: 'user-hook.mjs', statusMessage: 'User policy' }] }],
    },
  });
  const installed = mergeManagedJsonConfig(existing, descriptor, { hooks });
  const removed = JSON.parse(removeManagedJsonConfig(installed, descriptor));
  // User hook remains; managed hook is gone. Since user hooks still exist,
  // enabled is preserved so the user's hooks keep running.
  assert.equal(removed.hooks.PreToolUse.length, 1);
  assert.equal(removed.hooks.PreToolUse[0].hooks[0].command, 'user-hook.mjs');
  assert.equal(removed.hooks.enabled, true);
});

test('mergeManagedJsonConfig does not set enabled when hooks is empty', () => {
  const result = JSON.parse(mergeManagedJsonConfig('{}\n', descriptor, { hooks: {} }));
  // No hook events, so enabled is not set and container is removed.
  assert.equal(Object.hasOwn(result, 'hooks'), false);
});
