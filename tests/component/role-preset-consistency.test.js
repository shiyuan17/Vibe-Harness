import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { loadAllManifests } from '../../scripts/lib/manifest.js';
import { validateRolePresetDerivations } from '../../scripts/lib/pack-validation.js';
import { EXECUTE_PRESETS, WRITE_PRESETS } from '../../scripts/lib/role-projection.js';
import { DEFAULT_RED_ZONE_PATHS } from '../../runtime/hooks/lib/context.mjs';
import { analyzeToolRequest, normalizeCodexHookInput } from '../../runtime/hooks/lib/policy.mjs';
import {
  EXECUTION_ENVELOPE_SCHEMA,
  evaluateExecutionEnvelope,
} from '../../runtime/hooks/lib/execution-envelope.mjs';
import {
  EXECUTABLE_PRESETS,
  WRITABLE_PRESETS,
  rolePresetTier,
} from '../../runtime/hooks/lib/role-permissions.mjs';

const rootDir = path.resolve(import.meta.dirname, '../..');

async function loadRoles() {
  const manifests = await loadAllManifests(rootDir);
  return manifests.roles;
}

function codexInput(toolName, toolInput, overrides = {}) {
  return normalizeCodexHookInput({
    cwd: rootDir,
    hook_event_name: 'PreToolUse',
    session_id: 'session',
    tool_input: toolInput,
    tool_name: toolName,
    ...overrides,
  });
}

function analyzeWithPreset(toolName, toolInput, permissionPreset) {
  return analyzeToolRequest(codexInput(toolName, toolInput), {
    mode: 'guarded',
    permissionPreset,
    projectRoot: rootDir,
    redZonePaths: DEFAULT_RED_ZONE_PATHS,
  });
}

function envelopeFixture(overrides = {}) {
  return {
    schema: EXECUTION_ENVELOPE_SCHEMA,
    sessionId: 'session',
    requestId: 'request-1',
    mode: 'execute',
    targetIssueIds: ['ENG-123'],
    allowedEffects: ['workspaceWrite'],
    forbiddenEffects: [],
    terminalCondition: 'current-user-request-complete',
    activeObjective: 'Implement ENG-123 only',
    ...overrides,
  };
}

test('角色权限预设三层声明与 manifests/roles.json 能力保持等值', async () => {
  const roles = await loadRoles();
  assert.deepEqual(validateRolePresetDerivations(roles), []);
  // 显式锁定推导语义：workspace-write → 可写；可写或 validation-command →
  // 可执行；其余 → 只读。两份字面量（投影层与运行时 Hook）互为镜像。
  assert.deepEqual([...WRITABLE_PRESETS].sort(), ['implementation']);
  assert.deepEqual(
    [...EXECUTABLE_PRESETS].sort(),
    ['implementation', 'release-readiness', 'verification'],
  );
  assert.deepEqual([...WRITE_PRESETS].sort(), [...WRITABLE_PRESETS].sort());
  assert.deepEqual([...EXECUTE_PRESETS].sort(), [...EXECUTABLE_PRESETS].sort());
});

test('角色预设层级覆盖全部预设且未知预设 fail-closed 为只读', async () => {
  const roles = await loadRoles();
  const expectedTiers = {
    implementation: 'writable',
    verification: 'executable',
    'release-readiness': 'executable',
    analysis: 'read-only',
    'security-review': 'read-only',
  };
  for (const preset of roles.permissionPresets) {
    assert.equal(rolePresetTier(preset.id), expectedTiers[preset.id], preset.id);
  }
  assert.equal(rolePresetTier(null), null);
  assert.equal(rolePresetTier(''), null);
  assert.equal(rolePresetTier('   '), null);
  assert.equal(rolePresetTier(123), null);
  // 未知预设按只读处理，而不是放行。
  assert.equal(rolePresetTier('unknown-preset'), 'read-only');
});

test('角色预设推导漂移会被 pack 校验拒绝（负控）', async () => {
  const roles = await loadRoles();

  // roles.json 给 analysis 增加 workspace-write，两份字面量未跟随 → 四处等值错误。
  const writableDrift = structuredClone(roles);
  writableDrift.permissionPresets
    .find((preset) => preset.id === 'analysis').capabilities.push('workspace-write');
  const writableErrors = validateRolePresetDerivations(writableDrift);
  assert.equal(writableErrors.length, 4, JSON.stringify(writableErrors));
  assert.equal(
    writableErrors.every((message) => message.includes('must equal the set derived from manifests/roles.json capabilities')),
    true,
  );

  // release-readiness 失去 validation-command → 仅可执行集合漂移（两处）。
  const executableDrift = structuredClone(roles);
  const release = executableDrift.permissionPresets.find((preset) => preset.id === 'release-readiness');
  release.capabilities = release.capabilities.filter((capability) => capability !== 'validation-command');
  const executableErrors = validateRolePresetDerivations(executableDrift);
  assert.equal(executableErrors.length, 2, JSON.stringify(executableErrors));
  assert.equal(
    executableErrors.every((message) => message.includes('EXECUTE_PRESETS') || message.includes('EXECUTABLE_PRESETS')),
    true,
  );

  // 注入被篡改的字面量集合同样被拒绝。
  const projectionDrift = validateRolePresetDerivations(roles, {
    projectionWritablePresets: new Set(),
  });
  assert.equal(projectionDrift.length, 1);
  assert.match(projectionDrift[0], /role-projection\.js WRITE_PRESETS/u);

  const runtimeDrift = validateRolePresetDerivations(roles, {
    runtimeExecutablePresets: new Set([...EXECUTABLE_PRESETS, 'analysis']),
  });
  assert.equal(runtimeDrift.length, 1);
  assert.match(runtimeDrift[0], /role-permissions\.mjs EXECUTABLE_PRESETS/u);

  // 结构损坏直接报错。
  assert.deepEqual(
    validateRolePresetDerivations({ permissionPresets: [] }),
    ['manifests/roles.json permissionPresets must be a non-empty array'],
  );
  assert.deepEqual(
    validateRolePresetDerivations({ permissionPresets: [{ capabilities: [] }] }),
    ['manifests/roles.json permissionPresets entries must declare id and capabilities'],
  );
});

test('policy 按预设层级拒绝写尝试（可写/可执行/只读）', () => {
  const write = (preset) => analyzeWithPreset('Write', { file_path: 'src/app.js' }, preset);

  // 无预设与可写预设的行为不变。
  assert.equal(write(null).action, 'allow');
  assert.equal(write('implementation').action, 'allow');

  // 只读预设拒绝一切写尝试；未知预设同样 fail-closed。
  for (const preset of ['analysis', 'security-review', 'unknown-preset']) {
    const denied = write(preset);
    assert.equal(denied.action, 'deny', preset);
    assert.equal(denied.reasonCode, 'ROLE_PERMISSION_PRESET', preset);
  }

  // 可执行预设拒绝直接写文件的工具，shell 重定向留给 Execution Envelope。
  const executableWrite = write('verification');
  assert.equal(executableWrite.action, 'deny');
  assert.equal(executableWrite.reasonCode, 'ROLE_PERMISSION_PRESET');
  const executableEdit = analyzeWithPreset('Edit', {
    file_path: 'src/app.js',
    old_string: 'a',
    new_string: 'b',
  }, 'release-readiness');
  assert.equal(executableEdit.action, 'deny');
  assert.equal(executableEdit.reasonCode, 'ROLE_PERMISSION_PRESET');

  const shellRedirect = (preset) => analyzeWithPreset('Bash', { command: 'echo hi > out.txt' }, preset);
  assert.equal(shellRedirect('verification').action, 'allow');
  assert.equal(shellRedirect('release-readiness').action, 'allow');
  assert.equal(shellRedirect('analysis').action, 'deny');
  assert.equal(shellRedirect('analysis').reasonCode, 'ROLE_PERMISSION_PRESET');

  // 验证命令不是 policy 写尝试，可执行预设继续可用（test-lead 语义）。
  for (const command of ['pnpm test', 'pnpm check']) {
    const validation = analyzeWithPreset('Bash', { command }, 'verification');
    assert.equal(validation.action, 'allow', command);
  }
});

test('Execution Envelope 不能把角色抬升到预设层级之上', () => {
  const writeInput = codexInput('Write', { file_path: 'src/app.js' }, {
    executionEnvelope: envelopeFixture({ allowedEffects: ['workspaceWrite'] }),
  });

  // 已签发的 Envelope 在预设判定之后才被解析：可执行预设仍拒绝直接写文件。
  const escalated = evaluateExecutionEnvelope(writeInput, {
    environment: {},
    permissionPreset: 'verification',
  });
  assert.equal(escalated.action, 'deny');
  assert.equal(escalated.reasonCode, 'ROLE_PERMISSION_PRESET');

  // 可写预设保持 Envelope 原语义。
  const writable = evaluateExecutionEnvelope(writeInput, {
    environment: {},
    permissionPreset: 'implementation',
  });
  assert.equal(writable.action, 'allow');

  // 只读预设拒绝带副作用的调用，即使未启用 Envelope 必需模式。
  const validation = evaluateExecutionEnvelope(codexInput('Bash', { command: 'pnpm test' }), {
    environment: {},
    permissionPreset: 'analysis',
  });
  assert.equal(validation.action, 'deny');
  assert.equal(validation.reasonCode, 'ROLE_PERMISSION_PRESET');

  // 可执行预设的验证命令无需 Envelope 依旧放行。
  const executableValidation = evaluateExecutionEnvelope(codexInput('Bash', { command: 'pnpm test' }), {
    environment: {},
    permissionPreset: 'verification',
  });
  assert.equal(executableValidation.action, 'allow');

  // 只读命令不受任何预设影响。
  for (const preset of ['analysis', 'verification', 'implementation']) {
    const readOnly = evaluateExecutionEnvelope(codexInput('Bash', { command: 'git status --short' }), {
      environment: {},
      permissionPreset: preset,
    });
    assert.equal(readOnly.action, 'allow', preset);
  }
});
