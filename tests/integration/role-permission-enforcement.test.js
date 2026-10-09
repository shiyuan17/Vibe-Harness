import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { EXECUTION_ENVELOPE_SCHEMA } from '../../runtime/hooks/lib/execution-envelope.mjs';

const hookCliPath = path.resolve('runtime/hooks/codex-hook.mjs');

// Real-subprocess runner: the role permission preset is host-injected through
// the parent-owned environment, so these controls exercise the shipped CLI
// entry point exactly as a host runtime would spawn it.
async function runHookCli(stdin, { env = {} } = {}) {
  const child = spawn(process.execPath, [hookCliPath, '--host', 'codex', '--expected-event', 'PreToolUse'], {
    env: { ...process.env, VIBE_HARNESS_PERMISSION_PRESET: '', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdin.end(stdin);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return {
    code,
    stderr: Buffer.concat(stderr).toString('utf8'),
    stdout: Buffer.concat(stdout).toString('utf8'),
  };
}

function hookCliDecision(stdout) {
  return JSON.parse(stdout).hookSpecificOutput.permissionDecision;
}

function hookCliReason(stdout) {
  return JSON.parse(stdout).hookSpecificOutput.permissionDecisionReason;
}

async function withProject(callback, hooks = {}) {
  const target = await mkdtemp(path.join(tmpdir(), 'vibe-harness-role-preset-'));
  try {
    await writeFile(path.join(target, 'vibe-harness.config.json'), JSON.stringify({ hooks }), 'utf8');
    return await callback(target);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
}

function input(cwd, overrides = {}) {
  return {
    cwd,
    hook_event_name: 'PreToolUse',
    session_id: 'session',
    tool_input: { command: 'git status --short' },
    tool_name: 'Bash',
    ...overrides,
  };
}

function executionEnvelope(overrides = {}) {
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

test('真实子进程负控：verification 预设的 test-lead 写业务源码被拒（TD-2026-09-15-2）', async () => {
  await withProject(async (target) => {
    const payload = JSON.stringify(input(target, {
      tool_input: { file_path: 'src/app.js' },
      tool_name: 'Write',
    }));

    // 无预设时该写入是普通项目内写入。
    const withoutPreset = await runHookCli(payload);
    assert.equal(withoutPreset.code, 0);
    assert.equal(withoutPreset.stderr, '');
    assert.deepEqual(JSON.parse(withoutPreset.stdout), {});

    // 宿主注入 verification 预设（test-lead）后，同一写入被拒绝。
    const denied = await runHookCli(payload, {
      env: { VIBE_HARNESS_PERMISSION_PRESET: 'verification' },
    });
    assert.equal(denied.code, 0);
    assert.equal(denied.stderr, '');
    assert.equal(hookCliDecision(denied.stdout), 'deny');
    assert.match(hookCliReason(denied.stdout), /VIBE_HARNESS_POLICY:ROLE_PERMISSION_PRESET/u);
  });
});

test('真实子进程：只读预设拒绝副作用命令，可执行预设保留验证命令', async () => {
  await withProject(async (target) => {
    const commit = JSON.stringify(input(target, {
      tool_input: { command: 'git commit -m change' },
    }));
    const analysisDenied = await runHookCli(commit, {
      env: { VIBE_HARNESS_PERMISSION_PRESET: 'analysis' },
    });
    assert.equal(hookCliDecision(analysisDenied.stdout), 'deny');
    assert.match(hookCliReason(analysisDenied.stdout), /VIBE_HARNESS_POLICY:ROLE_PERMISSION_PRESET/u);

    // 未知预设 fail-closed 为只读。
    const unknownDenied = await runHookCli(commit, {
      env: { VIBE_HARNESS_PERMISSION_PRESET: 'unknown-preset' },
    });
    assert.equal(hookCliDecision(unknownDenied.stdout), 'deny');
    assert.match(hookCliReason(unknownDenied.stdout), /VIBE_HARNESS_POLICY:ROLE_PERMISSION_PRESET/u);

    // 可执行预设仍可运行验证命令（test-lead 语义的另一半）。
    const validation = await runHookCli(JSON.stringify(input(target, {
      tool_input: { command: 'pnpm test' },
    })), {
      env: { VIBE_HARNESS_PERMISSION_PRESET: 'verification' },
    });
    assert.equal(validation.code, 0);
    assert.equal(validation.stderr, '');
    assert.deepEqual(JSON.parse(validation.stdout), {});
  });
});

test('真实子进程：项目配置通道声明预设，宿主环境通道优先', async () => {
  await withProject(async (target) => {
    const payload = JSON.stringify(input(target, {
      tool_input: { file_path: 'src/app.js' },
      tool_name: 'Write',
    }));

    // hooks.permissionPreset 配置通道独立生效。
    await writeFile(path.join(target, 'vibe-harness.config.json'), JSON.stringify({
      hooks: { permissionPreset: 'analysis' },
    }), 'utf8');
    const configDenied = await runHookCli(payload);
    assert.equal(hookCliDecision(configDenied.stdout), 'deny');
    assert.match(hookCliReason(configDenied.stdout), /VIBE_HARNESS_POLICY:ROLE_PERMISSION_PRESET/u);

    // 宿主通道优先：项目配置放宽为 implementation 也压不过宿主的只读预设。
    await writeFile(path.join(target, 'vibe-harness.config.json'), JSON.stringify({
      hooks: { permissionPreset: 'implementation' },
    }), 'utf8');
    const hostWins = await runHookCli(payload, {
      env: { VIBE_HARNESS_PERMISSION_PRESET: 'analysis' },
    });
    assert.equal(hookCliDecision(hostWins.stdout), 'deny');
    assert.match(hookCliReason(hostWins.stdout), /VIBE_HARNESS_POLICY:ROLE_PERMISSION_PRESET/u);

    // 宿主放宽为 implementation 时，配置通道不再收紧。
    const hostLoose = await runHookCli(payload, {
      env: { VIBE_HARNESS_PERMISSION_PRESET: 'implementation' },
    });
    assert.deepEqual(JSON.parse(hostLoose.stdout), {});
  }, { permissionPreset: 'analysis' });
});

test('真实子进程：已签发 Envelope 不能抬升可执行预设的写权限', async () => {
  await withProject(async (target) => {
    const payload = JSON.stringify(input(target, {
      execution_envelope: executionEnvelope({ allowedEffects: ['workspaceWrite'] }),
      tool_input: { file_path: 'src/app.js' },
      tool_name: 'Write',
    }));

    // 无预设时该 Envelope 正常授权工作区写入。
    const envelopeAllowed = await runHookCli(payload);
    assert.deepEqual(JSON.parse(envelopeAllowed.stdout), {});

    // 可执行预设下，同一 Envelope 在预设判定处被拒绝。
    const escalated = await runHookCli(payload, {
      env: { VIBE_HARNESS_PERMISSION_PRESET: 'verification' },
    });
    assert.equal(hookCliDecision(escalated.stdout), 'deny');
    assert.match(hookCliReason(escalated.stdout), /VIBE_HARNESS_POLICY:ROLE_PERMISSION_PRESET/u);
  });
});

test('只读快速路径不受预设影响，且 cwd 失效仍先 fail-closed', async () => {
  await withProject(async (target) => {
    // 只读工具走快速路径：只读预设下同样放行（read-only 角色本就只读）。
    const fastPath = await runHookCli(JSON.stringify(input(target, {
      tool_input: { file_path: 'README.md' },
      tool_name: 'Read',
    })), {
      env: { VIBE_HARNESS_PERMISSION_PRESET: 'analysis' },
    });
    assert.equal(fastPath.code, 0);
    assert.equal(fastPath.stderr, '');
    assert.deepEqual(JSON.parse(fastPath.stdout), {});

    // cwd 失效时快速路径与预设都让位于 fail-closed 上下文检查。
    const missingContext = path.join(tmpdir(), 'missing-role-preset-context');
    const closed = await runHookCli(JSON.stringify(input(missingContext)), {
      env: { VIBE_HARNESS_PERMISSION_PRESET: 'analysis' },
    });
    assert.equal(closed.code, 0);
    assert.equal(hookCliDecision(closed.stdout), 'deny');
    assert.match(hookCliReason(closed.stdout), /VIBE_HARNESS_HOOK:HOOK_PROJECT_CONTEXT_UNAVAILABLE/u);
  });
});

test('角色预设由 roles.json 声明且与运行时字面量一致（安装面一致性）', async () => {
  const roles = JSON.parse(await readFile(path.resolve('manifests/roles.json'), 'utf8'));
  const declaredPresets = roles.permissionPresets.map((preset) => preset.id).sort();
  assert.deepEqual(declaredPresets, [
    'analysis',
    'implementation',
    'release-readiness',
    'security-review',
    'verification',
  ]);
  // 预设枚举与宿主投影 schema 的角色 permissionPreset 枚举保持同一集合。
  const schema = JSON.parse(await readFile(path.resolve('schemas/project-config.schema.json'), 'utf8'));
  const rolePresetEnum = schema.properties.roles.properties.custom.items.properties.permissionPreset.enum;
  assert.deepEqual([...rolePresetEnum].sort(), declaredPresets);
});
