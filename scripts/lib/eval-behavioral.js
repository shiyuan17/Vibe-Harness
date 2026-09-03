import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const CONTROLS = [
  {
    id: 'BEHAVIOR-RULE-001',
    relative: 'rules/governance-core.md',
    required: [
      '获取可信事实 → 判定并执行 → 聚焦验证 → 简洁交付',
      '证据强度匹配行动风险',
      '可发现事实继续只读探索',
      '执行判定：直接实施（0–1 个软信号）',
      'handoff 只引用晚于最后一次实质修改的结果',
    ],
  },
  {
    id: 'BEHAVIOR-SKILL-001',
    relative: 'skills/core/eval-driven-development/SKILL.md',
    required: ['reference 变更必须独立审查', '不得自动更新 reference'],
  },
  {
    id: 'BEHAVIOR-HOOK-001',
    relative: 'runtime/hooks/lib/policy.mjs',
    required: ['GLOBAL_AGENT_CONFIG', 'PROJECT_BOUNDARY', 'DESTRUCTIVE_GIT'],
  },
  {
    id: 'BEHAVIOR-CONFIG-001',
    relative: 'schemas/project-config.schema.json',
    required: ['"evaluations"', '"thresholds"', '"additionalProperties": false'],
  },
];

export function evaluateBehavioralControls(contents) {
  return CONTROLS.map((control) => {
    const source = contents[control.relative] ?? '';
    const missing = control.required.filter((fragment) => !source.includes(fragment));
    return { id: control.id, asset: control.relative, missing, passed: missing.length === 0 };
  });
}

export async function runBehavioralEvaluation(rootDir) {
  const entries = [];
  for (const control of CONTROLS) {
    entries.push([control.relative, await readFile(path.join(rootDir, control.relative), 'utf8')]);
  }
  const contents = Object.fromEntries(entries);
  const cases = evaluateBehavioralControls(contents);
  const baseline = new Map(cases.map((item) => [item.id, item.passed]));
  // Each required fragment gets its own mutation case: mutating only the first
  // fragment of a control would leave the remaining fragments unverified.
  const mutations = CONTROLS.flatMap((control) =>
    control.required.map((fragment, index) => {
      const mutated = {
        ...contents,
        [control.relative]: contents[control.relative].replaceAll(fragment, ''),
      };
      const passedAfter = evaluateBehavioralControls(mutated).find((item) => item.id === control.id).passed;
      // An already-failing control cannot demonstrate that its mutation was
      // detected, so detection is claimed only for an observed pass-to-fail flip.
      return {
        id: `${control.id}-MUTATION-${index + 1}`,
        fragment,
        detected: baseline.get(control.id) === true && passedAfter === false,
      };
    }),
  );
  return {
    schemaVersion: 2,
    proof: 'stub-behavioral',
    status: cases.every((item) => item.passed) && mutations.every((item) => item.detected) ? 'passed' : 'failed',
    cases,
    mutations,
  };
}
