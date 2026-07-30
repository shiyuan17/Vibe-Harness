// LLM-as-judge scorer for online evaluations.
//
// Online-only: offline replay is deterministic and must never invoke a judge
// model (the contract validator rejects llmRubrics assertions in offline
// suites). A judge call is non-deterministic, so it is fail-closed: missing
// credentials, network errors, and unparseable responses all raise
// EVAL_JUDGE_UNAVAILABLE so the online runner records a degraded run rather
// than silently passing.

import { sanitizeEvalValue } from './eval-scoring.js';

const DEFAULT_THRESHOLD = 0.8;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RATIONALE_LENGTH = 4096;

const JUDGE_SYSTEM_PROMPT = [
  'You are an evaluation judge for an AI coding agent.',
  'Score the agent output against the rubric on a continuous 0..1 scale where 1 fully satisfies the rubric and 0 fails it completely.',
  'Respond with a single JSON object on one line with two fields:',
  '"score" (a number from 0 to 1) and "rationale" (a short string justifying the score).',
  'Do not include any text outside the JSON object.',
].join(' ');

function buildUserPrompt({ scenario, observation, rubric }) {
  return [
    `Scenario: ${scenario}`,
    `Agent output:`,
    observation.output ?? '',
    '',
    `Rubric: ${rubric}`,
  ].join('\n');
}

function parseJudgeResponse(text) {
  const match = text.match(/\{[^]*\}/u);
  if (!match) throw new Error('judge response did not contain a JSON object');
  const parsed = JSON.parse(match[0]);
  const score = Number(parsed.score);
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new Error('judge score must be a number from 0 to 1');
  }
  const rationale = typeof parsed.rationale === 'string' ? parsed.rationale : '';
  return { score, rationale };
}

async function callJudgeModel({ scenario, observation, rubric, judgeModel, apiKey, baseUrl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: judgeModel,
        messages: [
          { role: 'system', content: JUDGE_SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt({ scenario, observation, rubric }) },
        ],
        temperature: 0,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`judge HTTP ${response.status}: ${await response.text().catch(() => '')}`);
    }
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content ?? '';
    if (!text) throw new Error('judge response had no message content');
    return parseJudgeResponse(text);
  } finally {
    clearTimeout(timer);
  }
}

// Create a reusable judge client. The client is created once per online run
// and shared across cases so the model and credentials are resolved once.
export function createJudge({ apiKey = process.env.OPENAI_API_KEY, baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', defaultModel, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!apiKey) {
    const error = new Error('OPENAI_API_KEY is required for llm-rubric assertions');
    error.code = 'EVAL_JUDGE_CREDENTIALS_MISSING';
    throw error;
  }
  return {
    async judgeRubric({ scenario, observation, rubric, judgeModel }) {
      const model = judgeModel || defaultModel;
      if (!model) {
        throw new Error('judgeModel must be provided or a defaultModel must be configured');
      }
      try {
        const result = await callJudgeModel({ scenario, observation, rubric, judgeModel: model, apiKey, baseUrl, timeoutMs });
        return {
          score: Math.max(0, Math.min(1, result.score)),
          rationale: sanitizeEvalValue(result.rationale).slice(0, MAX_RATIONALE_LENGTH),
          judgeModel: model,
        };
      } catch (error) {
        if (error.code === 'EVAL_JUDGE_CREDENTIALS_MISSING') throw error;
        const wrapped = new Error(`judge unavailable: ${error.message}`);
        wrapped.code = 'EVAL_JUDGE_UNAVAILABLE';
        throw wrapped;
      }
    },
  };
}

export const DEFAULT_JUDGE_THRESHOLD = DEFAULT_THRESHOLD;
