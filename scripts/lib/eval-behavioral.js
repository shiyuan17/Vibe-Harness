import { readFile } from 'node:fs/promises';
import path from 'node:path';

const CONTROLS = [
  {
    id: 'BEHAVIOR-RULE-001',
    relative: 'rules/governance-core.md',
    required: ['获取事实 → 直接执行 → 聚焦验证 → 简洁交付', 'handoff 只引用晚于最后一次实质修改的结果'],
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
  const mutations = CONTROLS.map((control) => {
    const mutated = {
      ...contents,
      [control.relative]: contents[control.relative].replaceAll(control.required[0], ''),
    };
    const detected = !evaluateBehavioralControls(mutated).find((item) => item.id === control.id).passed;
    return { id: control.id + '-MUTATION', detected };
  });
  return {
    schemaVersion: 2,
    proof: 'stub-behavioral',
    status: cases.every((item) => item.passed) && mutations.every((item) => item.detected) ? 'passed' : 'failed',
    cases,
    mutations,
  };
}
