import assert from 'node:assert/strict';
import test from 'node:test';

import { reviewReport } from '../../runtime/lib/review-command.mjs';
import { classifyExecutionEffects } from '../../runtime/hooks/lib/execution-envelope.mjs';

const args = { _: ['review', 'ocr'], task: ['SID-615'], target: 'https://model.example/v1' };

test('review CLI preflight never starts OCR or emits credentials', async () => {
  let calls = 0;
  const ready = () => {
    calls += 1;
    return { status: 'ready', env: { OCR_LLM_URL: 'https://model.example/v1/chat/completions', OCR_LLM_TOKEN: 'private-token' } };
  };
  const valid = await reviewReport(args, { resolveEndpoint: ready });
  assert.equal(valid.code, 'HOST_BROKER_REQUIRED');
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(valid).includes('private-token'), false);
  assert.equal((await reviewReport({ ...args, target: 'http://model.example/v1' }, { resolveEndpoint: ready })).code, 'OCR_TARGET_INVALID');
  assert.equal((await reviewReport(args, { resolveEndpoint: () => ({ status: 'pending-config', diagnostic: { code: 'OCR_PROTOCOL_UNSUPPORTED' } }) })).code, 'OCR_PROTOCOL_UNSUPPORTED');
  const failedRead = await reviewReport(args, { resolveEndpoint: () => { throw new Error('private-token'); } });
  assert.equal(failedRead.code, 'OCR_CONFIG_READ_FAILED');
  assert.equal(JSON.stringify(failedRead).includes('private-token'), false);
  assert.equal((await reviewReport(args, { resolveEndpoint: () => ({ status: 'ready', env: { OCR_LLM_URL: 'https://other.example/v1' } }) })).code, 'OCR_TARGET_MISMATCH');
  assert.equal((await reviewReport({ ...args, _: ['review', 'unknown'] }, { resolveEndpoint: ready })).code, 'OCR_INVOCATION_INVALID');
});

test('unknown review subcommands remain high-risk rather than becoming ordinary node writes', () => {
  const result = classifyExecutionEffects({
    cwd: process.cwd(), toolName: 'Bash',
    toolInput: { command: 'node runtime/commands/run.mjs review other --task SID-615 --target https://model.example/v1' },
  });
  assert.equal(result.unknown, true);
  assert.equal(result.risk, 'high');
});
