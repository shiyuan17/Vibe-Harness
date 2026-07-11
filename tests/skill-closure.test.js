import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { createInstallPlan } from '../scripts/lib/install-planner.js';
import { readJson } from '../scripts/lib/manifest.js';
import { validateSkillGraph } from '../scripts/lib/pack-validation.js';

const rootDir = path.resolve('.');
const execFileAsync = promisify(execFile);

function skill(id, overrides = {}) {
  return {
    id,
    source: `skills/core/${id}/SKILL.md`,
    metadata: `skills/core/${id}/metadata.json`,
    kind: 'native',
    requiresSkills: [],
    optionalSkills: [],
    requiresTools: [],
    ...overrides,
  };
}

test('skill graph rejects missing dependencies, invalid aliases, and missing fallbacks', async () => {
  const items = [
    skill('native', { requiresSkills: ['missing'] }),
    skill('optional', { optionalSkills: ['missing-optional'] }),
    skill('integration', { kind: 'integration', requiresTools: ['example-cli'] }),
    skill('router-a', { kind: 'router', canonicalId: 'router-b' }),
    skill('router-b', { kind: 'compatibility', canonicalId: 'router-a' }),
  ];

  const errors = await validateSkillGraph(rootDir, items, [], { checkFiles: false });
  const joined = errors.join('\n');

  assert.match(joined, /native requires unknown skill: missing/);
  assert.match(joined, /optional optional skill is unknown: missing-optional/);
  assert.match(joined, /optional must document fallback/);
  assert.match(joined, /integration must document fallback/);
  assert.match(joined, /canonical skill cycle: router-a -> router-b -> router-a/);
});

test('skill graph enforces profile dependency closure', async () => {
  const items = [skill('planner', { requiresSkills: ['executor'] }), skill('executor')];
  const profiles = [{ id: 'core', groups: ['skills-core'] }];
  const installEntries = [
    { group: 'skills-core', source: items[0].source, target: '.agents/skills/planner/SKILL.md' },
    { group: 'skills-full', source: items[1].source, target: '.agents/skills/executor/SKILL.md' },
  ];

  const errors = await validateSkillGraph(rootDir, items, profiles, {
    checkFiles: false,
    installEntries,
  });

  assert.match(errors.join('\n'), /core installs planner without required skill executor/);
});

test('skill graph rejects an unregistered hyphenated skill reference', async () => {
  const target = await mkdtemp(path.join(rootDir, '.tmp-skill-ref-'));
  try {
    await mkdir(path.join(target, 'skills/core/router'), { recursive: true });
    await writeFile(path.join(target, 'skills/core/router/SKILL.md'), [
      '---',
      'name: router',
      'description: Use when routing a test request.',
      '---',
      '',
      'Use `missing-skill` for execution.',
    ].join('\n'));
    await writeFile(path.join(target, 'skills/core/router/metadata.json'), '{"id":"router"}\n');
    const errors = await validateSkillGraph(target, [skill('router')], [], { installEntries: [] });
    assert.match(errors.join('\n'), /router references unregistered skill id: missing-skill/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('skill graph rejects duplicated long prose across skill entrypoints', async () => {
  const target = await mkdtemp(path.join(rootDir, '.tmp-skill-duplicate-'));
  const duplicate = 'This intentionally duplicated procedural paragraph is long enough to represent copied workflow documentation. It repeats the same decision process, validation requirements, failure handling, evidence expectations, and completion rules across multiple skill entrypoints instead of using one canonical source.';
  try {
    const items = [skill('first'), skill('second')];
    for (const item of items) {
      const directory = path.dirname(path.join(target, item.source));
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(target, item.source), `---\nname: ${item.id}\ndescription: Use when testing duplicate prose.\n---\n\n${duplicate}\n`);
      await writeFile(path.join(target, item.metadata), `{"id":"${item.id}"}\n`);
    }
    const errors = await validateSkillGraph(target, items, [], { installEntries: [] });
    assert.match(errors.join('\n'), /duplicated long skill prose in first and second/);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('current skill catalog is closed for every installable profile', async () => {
  const manifest = await readJson(path.join(rootDir, 'manifests/skills.json'));
  const profiles = await readJson(path.join(rootDir, 'manifests/profiles.json'));
  const installMap = await readJson(path.join(rootDir, 'adapters/codex/install-map.json'));

  assert.deepEqual(
    await validateSkillGraph(rootDir, manifest.items, profiles.items, { installEntries: installMap.entries }),
    [],
  );

  for (const profile of ['minimal', 'core', 'full', 'codex-internal']) {
    const plan = await createInstallPlan({ dryRun: true, profile, rootDir, targetDir: rootDir });
    const installed = new Set(plan.actions
      .map((entry) => entry.relativeTarget.replaceAll('\\', '/'))
      .filter((target) => target.startsWith('.agents/skills/'))
      .map((target) => target.split('/')[2]));
    for (const item of manifest.items) {
      if (!installed.has(item.id)) continue;
      for (const dependency of item.requiresSkills) {
        assert.equal(installed.has(dependency), true, `${profile}: ${item.id} requires ${dependency}`);
      }
    }
  }
});

test('writing plans requires the core executor and treats subagent execution as optional', async () => {
  const manifest = await readJson(path.join(rootDir, 'manifests/skills.json'));
  const writingPlans = manifest.items.find((item) => item.id === 'writing-plans');
  const content = await readFile(path.join(rootDir, writingPlans.source), 'utf8');

  assert.deepEqual(writingPlans.requiresSkills, ['executing-plans']);
  assert.deepEqual(writingPlans.optionalSkills, ['subagent-driven-development']);
  assert.match(content, /executing-plans/);
  assert.match(content, /subagent-driven-development.*可选/u);
});

test('all source-project routed skills are bundled under compatible ids', async () => {
  const manifest = await readJson(path.join(rootDir, 'manifests/skills.json'));
  const ids = new Set(manifest.items.map((item) => item.id));
  const expected = [
    'executing-plans', 'grill-me', 'frontend-ui-engineering',
    'browser-testing-with-devtools', 'security-and-hardening', 'code-simplification',
    'debugging-and-error-recovery', 'documentation-and-adrs', 'frontend-design',
    'taste-skill', 'impeccable', 'adversarial-review-packet',
    'git-delivery-batcher', 'runtime-cross-repo-rollout',
  ];

  assert.deepEqual(expected.filter((id) => !ids.has(id)), []);
});

test('skill install targets and metadata agree with manifest identity', async () => {
  const manifest = await readJson(path.join(rootDir, 'manifests/skills.json'));
  const installMap = await readJson(path.join(rootDir, 'adapters/codex/install-map.json'));
  const entriesBySource = new Map(installMap.entries.map((entry) => [entry.source, entry]));

  for (const item of manifest.items) {
    const metadata = await readJson(path.join(rootDir, item.metadata));
    assert.equal(metadata.id, item.id, `${item.id} metadata id`);
    const entry = entriesBySource.get(item.source);
    assert.equal(entry.target.replaceAll('\\', '/'), `.agents/skills/${item.id}/SKILL.md`);
  }
});

test('manifest dependency declarations cover cross-skill references', async () => {
  const manifest = await readJson(path.join(rootDir, 'manifests/skills.json'));
  const ids = new Set(manifest.items.map((item) => item.id));
  for (const item of manifest.items) {
    const content = await readFile(path.join(rootDir, item.source), 'utf8');
    const declared = new Set([
      ...item.requiresSkills,
      ...item.optionalSkills,
      ...(item.canonicalId ? [item.canonicalId] : []),
    ]);
    const references = [...content.matchAll(/`([a-z][a-z0-9-]+)`/gu)]
      .map((match) => match[1])
      .filter((id) => ids.has(id) && id !== item.id);
    assert.deepEqual(
      [...new Set(references)].filter((id) => !declared.has(id)),
      [],
      `${item.id} has undeclared skill references`,
    );
  }
});

test('skill entrypoints stay within progressive-disclosure line budgets', async () => {
  const manifest = await readJson(path.join(rootDir, 'manifests/skills.json'));
  for (const item of manifest.items) {
    const content = await readFile(path.join(rootDir, item.source), 'utf8');
    const lines = content.split(/\r?\n/u).length;
    const budget = ['router', 'compatibility'].includes(item.kind) ? 30 : 80;
    assert.ok(lines <= budget, `${item.id} has ${lines} lines; budget is ${budget}`);
  }
});

test('skills audit report derives inventory counts from the manifest', async () => {
  const { stdout } = await execFileAsync(process.execPath, ['scripts/skills-audit.js'], { cwd: rootDir });
  assert.match(stdout, /总数：45/);
  assert.match(stdout, /native：28/);
  assert.match(stdout, /integration：11/);
  assert.match(stdout, /router：4/);
  assert.match(stdout, /compatibility：2/);
  assert.match(stdout, /最长入口：`api-and-interface-design`（7[0-9] 行）/);
});

test('external integration skills document usable and unavailable paths', async () => {
  const manifest = await readJson(path.join(rootDir, 'manifests/skills.json'));
  const readSkill = async (id) => {
    const item = manifest.items.find((candidate) => candidate.id === id);
    return readFile(path.join(rootDir, item.source), 'utf8');
  };
  assert.match(await readSkill('open-code-review'), /ocr llm test[\s\S]*回退/u);
  assert.match(await readSkill('agentmemory'), /MCP[\s\S]*HTTP API[\s\S]*回退/u);
  assert.match(await readSkill('browser-verification'), /MCP[\s\S]*回退/u);
});
