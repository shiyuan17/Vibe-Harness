import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_JUDGE_THRESHOLD,
  buildUserPrompt,
  callJudgeModel,
  createJudge,
  parseJudgeResponse,
} from '../scripts/lib/eval-judge.js';

const originalFetch = globalThis.fetch;

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function contentResponse(content) {
  return jsonResponse(200, {
    choices: [{ message: { content } }],
  });
}

test('buildUserPrompt assembles scenario, observation output, and rubric', () => {
  const prompt = buildUserPrompt({
    scenario: 'fix the bug',
    observation: { output: 'patched file' },
    rubric: 'must patch the file',
  });
  assert.match(prompt, /Scenario: fix the bug/);
  assert.match(prompt, /Agent output:/);
  assert.match(prompt, /patched file/);
  assert.match(prompt, /Rubric: must patch the file/);
});

test('buildUserPrompt tolerates missing observation output', () => {
  const prompt = buildUserPrompt({
    scenario: 'scenario',
    observation: {},
    rubric: 'rubric',
  });
  assert.match(prompt, /Agent output:/);
});

test('parseJudgeResponse returns score and rationale for valid JSON', () => {
  const result = parseJudgeResponse('{"score": 0.9, "rationale": "good"}');
  assert.equal(result.score, 0.9);
  assert.equal(result.rationale, 'good');
});

test('parseJudgeResponse extracts JSON embedded in surrounding prose', () => {
  const result = parseJudgeResponse('here is the verdict: {"score":0.5,"rationale":"ok"} done');
  assert.equal(result.score, 0.5);
  assert.equal(result.rationale, 'ok');
});

test('parseJudgeResponse throws when no JSON object is present', () => {
  assert.throws(() => parseJudgeResponse('no json here'), /did not contain a JSON object/);
});

test('parseJudgeResponse throws SyntaxError for malformed JSON', () => {
  assert.throws(() => parseJudgeResponse('{score: 0.9}'), SyntaxError);
});

test('parseJudgeResponse rejects scores outside 0..1', () => {
  assert.throws(() => parseJudgeResponse('{"score": 1.5}'), /must be a number from 0 to 1/);
  assert.throws(() => parseJudgeResponse('{"score": -0.5}'), /must be a number from 0 to 1/);
});

test('parseJudgeResponse rejects non-numeric scores', () => {
  assert.throws(() => parseJudgeResponse('{"score": "high"}'), /must be a number from 0 to 1/);
  const result = parseJudgeResponse('{"score": null, "rationale": "x"}');
  assert.ok(Number.isNaN(result.score) || result.score === 0);
});

test('parseJudgeResponse downgrades non-string rationale to empty string', () => {
  const result = parseJudgeResponse('{"score": 0.8, "rationale": 42}');
  assert.equal(result.rationale, '');
});

test('callJudgeModel returns parsed result on a successful response', async () => {
  globalThis.fetch = async () => contentResponse('{"score": 0.7, "rationale": "adequate"}');
  try {
    const result = await callJudgeModel({
      scenario: 's',
      observation: { output: 'o' },
      rubric: 'r',
      judgeModel: 'm',
      apiKey: 'key',
      baseUrl: 'https://example.test',
      timeoutMs: 5000,
    });
    assert.equal(result.score, 0.7);
    assert.equal(result.rationale, 'adequate');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('callJudgeModel throws on non-2xx HTTP status', async () => {
  globalThis.fetch = async () => jsonResponse(500, { error: 'down' });
  try {
    await assert.rejects(
      () => callJudgeModel({
        scenario: 's', observation: {}, rubric: 'r',
        judgeModel: 'm', apiKey: 'key', baseUrl: 'https://example.test', timeoutMs: 5000,
      }),
      /judge HTTP 500/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('callJudgeModel throws when response has no message content', async () => {
  globalThis.fetch = async () => jsonResponse(200, { choices: [{ message: {} }] });
  try {
    await assert.rejects(
      () => callJudgeModel({
        scenario: 's', observation: {}, rubric: 'r',
        judgeModel: 'm', apiKey: 'key', baseUrl: 'https://example.test', timeoutMs: 5000,
      }),
      /no message content/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('callJudgeModel aborts on timeout', async () => {
  globalThis.fetch = async (_, { signal } = {}) => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(contentResponse('{"score": 1}')), 500);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  };
  try {
    await assert.rejects(
      () => callJudgeModel({
        scenario: 's', observation: {}, rubric: 'r',
        judgeModel: 'm', apiKey: 'key', baseUrl: 'https://example.test', timeoutMs: 20,
      }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createJudge throws EVAL_JUDGE_CREDENTIALS_MISSING without an apiKey', () => {
  delete process.env.OPENAI_API_KEY;
  assert.throws(
    () => createJudge({}),
    (error) => error.code === 'EVAL_JUDGE_CREDENTIALS_MISSING',
  );
});

test('createJudge returns a judge client with judgeRubric', () => {
  const judge = createJudge({ apiKey: 'key', defaultModel: 'default-m' });
  assert.equal(typeof judge.judgeRubric, 'function');
});

test('judgeRubric succeeds and returns the model and rationale', async () => {
  globalThis.fetch = async () => contentResponse('{"score": 0.9, "rationale": "good"}');
  try {
    const judge = createJudge({ apiKey: 'key', defaultModel: 'm' });
    const result = await judge.judgeRubric({
      scenario: 's', observation: { output: 'o' }, rubric: 'r',
    });
    assert.equal(result.score, 0.9);
    assert.equal(result.rationale, 'good');
    assert.equal(result.judgeModel, 'm');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('judgeRubric preserves scores within the valid 0..1 range', async () => {
  globalThis.fetch = async () => contentResponse('{"score": 0, "rationale": "min"}');
  try {
    const judge = createJudge({ apiKey: 'key', defaultModel: 'm' });
    const result = await judge.judgeRubric({
      scenario: 's', observation: {}, rubric: 'r',
    });
    assert.equal(result.score, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('judgeRubric truncates rationale to the max length', async () => {
  const longRationale = 'a'.repeat(5000);
  globalThis.fetch = async () => contentResponse(`{"score": 0.8, "rationale": "${longRationale}"}`);
  try {
    const judge = createJudge({ apiKey: 'key', defaultModel: 'm' });
    const result = await judge.judgeRubric({
      scenario: 's', observation: {}, rubric: 'r',
    });
    assert.equal(result.rationale.length, 4096);
    assert.equal(result.rationale, 'a'.repeat(4096));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('judgeRubric throws when no model is configured or provided', async () => {
  const judge = createJudge({ apiKey: 'key' });
  await assert.rejects(
    () => judge.judgeRubric({ scenario: 's', observation: {}, rubric: 'r' }),
    (error) => /judgeModel must be provided/.test(error.message) && error.code === undefined,
  );
});

test('judgeRubric wraps network errors as EVAL_JUDGE_UNAVAILABLE', async () => {
  globalThis.fetch = async () => { throw new TypeError('network failed'); };
  try {
    const judge = createJudge({ apiKey: 'key', defaultModel: 'm' });
    await assert.rejects(
      () => judge.judgeRubric({ scenario: 's', observation: {}, rubric: 'r' }),
      (error) => error.code === 'EVAL_JUDGE_UNAVAILABLE' && /network failed/.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('judgeRubric wraps HTTP errors as EVAL_JUDGE_UNAVAILABLE', async () => {
  globalThis.fetch = async () => jsonResponse(503, { error: 'unavailable' });
  try {
    const judge = createJudge({ apiKey: 'key', defaultModel: 'm' });
    await assert.rejects(
      () => judge.judgeRubric({ scenario: 's', observation: {}, rubric: 'r' }),
      (error) => error.code === 'EVAL_JUDGE_UNAVAILABLE',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('DEFAULT_JUDGE_THRESHOLD is 0.8', () => {
  assert.equal(DEFAULT_JUDGE_THRESHOLD, 0.8);
});
