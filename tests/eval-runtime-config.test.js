import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveEvalRuntime } from '../scripts/lib/eval-runtime-config.js';

async function codexFixture() {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-runtime-config-'));
  const codexHome = path.join(homeDir, '.codex');
  await mkdir(codexHome, { recursive: true });
  await writeFile(path.join(codexHome, 'config.toml'), [
    'model = "gpt-5.6-sol"',
    'model_provider = "corp"',
    'model_reasoning_effort = "high"',
    'notify = ["must-not-be-inherited"]',
    '',
    '[model_providers.corp]',
    'base_url = "https://example.invalid/v1/"',
    'wire_api = "responses"',
    'requires_openai_auth = true',
    '',
    '[mcp_servers.unsafe]',
    'command = "must-not-be-inherited"',
    '',
    '[projects."C:/trusted"]',
    'trust_level = "trusted"',
  ].join('\n'), 'utf8');
  await writeFile(path.join(codexHome, 'auth.json'), '{"OPENAI_API_KEY":"CONFIG_AUTH_SECRET"}\n', 'utf8');
  return { codexHome, homeDir };
}

test('runtime auto source prefers Codex config and extracts only the approved fields', async () => {
  const fixture = await codexFixture();
  try {
    const resolved = await resolveEvalRuntime({
      env: {
        VIBE_HARNESS_EVAL_RUNTIME_SOURCE: 'auto',
        OPENAI_API_KEY: 'ENV_SECRET',
      },
      homeDir: fixture.homeDir,
      needsWrite: true,
      platform: 'win32',
      repetitions: [{ id: 'CASE', count: 1 }],
      resolveCliVersion: async ({ backend }) => `codex-cli@1-${backend}`,
    });

    assert.equal(resolved.source, 'codex');
    assert.equal(resolved.backend, 'wsl');
    assert.equal(resolved.cliVersion, 'codex-cli@1-wsl');
    assert.equal(resolved.environment.CODEX_MODEL, 'gpt-5.6-sol');
    assert.equal(resolved.environment.CODEX_REASONING_EFFORT, 'high');
    assert.equal(resolved.environment.OPENAI_BASE_URL, 'https://example.invalid/v1');
    assert.equal(resolved.environment.VIBE_HARNESS_EVAL_AUTH_FILE, path.join(fixture.codexHome, 'auth.json'));
    assert.equal(resolved.unset.includes('OPENAI_API_KEY'), true);
    assert.equal(Object.hasOwn(resolved.environment, 'OPENAI_API_KEY'), false);
    assert.doesNotMatch(JSON.stringify(resolved), /CONFIG_AUTH_SECRET|ENV_SECRET|notify|mcp_servers|trust_level/u);
  } finally {
    await rm(fixture.homeDir, { force: true, recursive: true });
  }
});

test('explicit CODEX_MODEL overrides the configured model without changing provider auth source', async () => {
  const fixture = await codexFixture();
  try {
    const resolved = await resolveEvalRuntime({
      env: { CODEX_MODEL: 'gpt-5.6-sol', VIBE_HARNESS_EVAL_RUNTIME_SOURCE: 'codex' },
      homeDir: fixture.homeDir,
      resolveCliVersion: async () => 'codex-cli@override',
    });
    assert.equal(resolved.environment.CODEX_MODEL, 'gpt-5.6-sol');
    assert.equal(resolved.environment.VIBE_HARNESS_EVAL_PROVIDER_NAME, 'corp');
    assert.equal(resolved.environment.VIBE_HARNESS_EVAL_AUTH_FILE, path.join(fixture.codexHome, 'auth.json'));
  } finally {
    await rm(fixture.homeDir, { force: true, recursive: true });
  }
});

test('explicit env source wins over Codex config and auto selects native for read-only cases', async () => {
  const fixture = await codexFixture();
  try {
    const resolved = await resolveEvalRuntime({
      env: {
        CODEX_MODEL: 'env-model',
        CODEX_REASONING_EFFORT: 'xhigh',
        VIBE_HARNESS_EVAL_RUNTIME_SOURCE: 'env',
        OPENAI_API_KEY: 'ENV_SECRET',
        OPENAI_BASE_URL: 'https://env.example/v1',
      },
      homeDir: fixture.homeDir,
      needsWrite: false,
      platform: 'win32',
      resolveCliVersion: async ({ backend }) => `codex-cli@2-${backend}`,
    });

    assert.equal(resolved.source, 'env');
    assert.equal(resolved.backend, 'native');
    assert.equal(resolved.environment.CODEX_MODEL, 'env-model');
    assert.equal(resolved.environment.OPENAI_API_KEY, 'ENV_SECRET');
    assert.equal(Object.hasOwn(resolved.environment, 'VIBE_HARNESS_EVAL_AUTH_FILE'), false);
  } finally {
    await rm(fixture.homeDir, { force: true, recursive: true });
  }
});

test('auto source falls back to environment when Codex config is absent', async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-runtime-env-'));
  try {
    const resolved = await resolveEvalRuntime({
      env: { CODEX_MODEL: 'env-model', OPENAI_API_KEY: 'ENV_SECRET' },
      homeDir,
      platform: 'linux',
      resolveCliVersion: async () => 'codex-cli@3',
    });
    assert.equal(resolved.source, 'env');
    assert.equal(resolved.backend, 'native');
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test('runtime hash changes with actual backend, CLI version, and repetitions', async () => {
  const env = {
    CODEX_MODEL: 'fixture',
    VIBE_HARNESS_EVAL_RUNTIME_SOURCE: 'env',
    OPENAI_API_KEY: 'ENV_SECRET',
  };
  const make = (backend, version, repetitions) => resolveEvalRuntime({
    env: { ...env, VIBE_HARNESS_EVAL_CODEX_BACKEND: backend },
    repetitions,
    resolveCliVersion: async () => version,
  });
  const native = await make('native', 'codex-cli@1', 1);
  const wsl = await make('wsl', 'codex-cli@1', 1);
  const upgraded = await make('native', 'codex-cli@2', 1);
  const repeated = await make('native', 'codex-cli@1', 3);

  const hashes = [native, wsl, upgraded, repeated]
    .map((item) => item.environment.VIBE_HARNESS_EVAL_RUNTIME_HASH);
  assert.equal(new Set(hashes).size, hashes.length);
});

test('explicit codex source fails closed when config or required auth is missing', async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'vibe-harness-runtime-missing-'));
  try {
    await assert.rejects(
      resolveEvalRuntime({ env: { VIBE_HARNESS_EVAL_RUNTIME_SOURCE: 'codex' }, homeDir }),
      /config\.toml is required/u,
    );
    await mkdir(path.join(homeDir, '.codex'), { recursive: true });
    await writeFile(path.join(homeDir, '.codex/config.toml'), [
      'model = "fixture"',
      'model_provider = "corp"',
      '[model_providers.corp]',
      'base_url = "https://example.invalid/v1"',
      'requires_openai_auth = true',
    ].join('\n'), 'utf8');
    await assert.rejects(
      resolveEvalRuntime({ env: { VIBE_HARNESS_EVAL_RUNTIME_SOURCE: 'codex' }, homeDir }),
      /auth\.json is required/u,
    );
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});
