import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { createInstallPlan } from '../scripts/lib/install-planner.js';
import { readJson } from '../scripts/lib/manifest.js';
import { validateSkillGraph } from '../scripts/lib/pack-validation.js';
import { runSkillsAudit } from '../scripts/lib/skills-audit.js';

const rootDir = path.resolve('.');
const execFileAsync = promisify(execFile);
const prunedSkillIds = [
  'api-contract-check',
  'browser-testing-with-devtools',
  'code-simplification',
  'commit-history',
  'commit-context',
  'debugging-and-error-recovery',
  'frontend-implementation-check',
  'grill-me',
  'review-checklist',
  'frontend-ui-engineering',
  'documentation-and-adrs',
  'open-code-review',
  'requesting-code-review',
  'skill-authoring-check',
  'task-decomposition',
  'workflow-handoff',
  'worktree-mergeback-check',
  'git-delivery-batcher',
  'release-checklist',
  'pencil-design-check',
  'taste-skill',
  'impeccable',
];
const consolidatedAgentmemoryOperations = [
  'handoff',
  'recall',
  'remember',
  'forget',
  'recap',
  'session-history',
];

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

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') files.push(...await filesUnder(entryPath));
      continue;
    }
    files.push(entryPath);
  }
  return files;
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

  for (const profile of ['minimal', 'core', 'full']) {
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
    'executing-plans', 'security-and-hardening', 'frontend-design',
    'adversarial-review-packet', 'runtime-cross-repo-rollout',
  ];

  assert.deepEqual(expected.filter((id) => !ids.has(id)), []);
});

test('skill graph rejects missing or mismatched frontmatter', async () => {
  const target = await mkdtemp(path.join(rootDir, '.tmp-skill-frontmatter-'));
  try {
    await mkdir(path.join(target, 'skills/core/router'), { recursive: true });
    await writeFile(path.join(target, 'skills/core/router/SKILL.md'), '---\nname: wrong\n---\n\n# Router\n', 'utf8');
    await writeFile(path.join(target, 'skills/core/router/metadata.json'), '{"id":"router"}\n', 'utf8');
    const errors = await validateSkillGraph(target, [skill('router')], [], { installEntries: [] });
    assert.match(errors.join('\n'), /frontmatter name must equal router/u);
    assert.match(errors.join('\n'), /frontmatter description is required/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('Red Team review skill is available to every profile with task runtime', async () => {
  for (const profile of ['core', 'full']) {
    const plan = await createInstallPlan({ dryRun: true, profile, rootDir, targetDir: rootDir });
    const targets = new Set(plan.actions.map((entry) => entry.relativeTarget.replaceAll('\\', '/')));
    assert.equal(targets.has('.agents/skills/adversarial-review-packet/SKILL.md'), true, `${profile} should install Red Team review`);
    assert.equal(targets.has('.agents/skills/adversarial-review-packet/references/review.md'), true, `${profile} should install Red Team template`);
  }
  for (const profile of ['minimal', 'docs-only']) {
    const plan = await createInstallPlan({ dryRun: true, profile, rootDir, targetDir: rootDir });
    const targets = new Set(plan.actions.map((entry) => entry.relativeTarget.replaceAll('\\', '/')));
    assert.equal(targets.has('.agents/skills/adversarial-review-packet/SKILL.md'), false, `${profile} should not install executable Red Team skill`);
  }
});

test('pruned thin skills are absent from manifest, install map, and install plans', async () => {
  const manifest = await readJson(path.join(rootDir, 'manifests/skills.json'));
  const installMap = await readJson(path.join(rootDir, 'adapters/codex/install-map.json'));
  const ids = new Set(manifest.items.map((item) => item.id));
  const installedSkillPaths = installMap.entries
    .filter((entry) => entry.source.startsWith('skills/') || entry.target.startsWith('.agents/skills/'))
    .flatMap((entry) => [entry.source, entry.target]);

  for (const id of prunedSkillIds) {
    assert.equal(ids.has(id), false, `${id} should not remain in manifest`);
    assert.equal(installedSkillPaths.some((value) => value.includes(id)), false, `${id} should not remain in skill install-map`);
  }

  for (const profile of ['core', 'full']) {
    const plan = await createInstallPlan({ dryRun: true, profile, rootDir, targetDir: rootDir });
    const plannedTargets = plan.actions.map((entry) => entry.relativeTarget.replaceAll('\\', '/'));
    for (const id of prunedSkillIds) {
      assert.equal(plannedTargets.some((target) => target.includes(`/.agents/skills/${id}/`) || target.includes(`.agents/skills/${id}/`)), false, `${profile} should not install ${id}`);
    }
  }

  const baselineSource = await readFile(path.join(rootDir, 'scripts/lib/project-baseline.js'), 'utf8');
  for (const id of ['requesting-code-review', 'workflow-handoff']) {
    assert.equal(baselineSource.includes(`'${id}'`), false, `${id} should not be recommended by project baseline`);
  }
});

test('agentmemory operations are references under one installed skill', async () => {
  const manifest = await readJson(path.join(rootDir, 'manifests/skills.json'));
  const installMap = await readJson(path.join(rootDir, 'adapters/codex/install-map.json'));
  const ids = new Set(manifest.items.map((item) => item.id));
  const agentmemory = manifest.items.find((item) => item.id === 'agentmemory');
  const content = await readFile(path.join(rootDir, agentmemory.source), 'utf8');

  assert.deepEqual(agentmemory.optionalSkills, []);
  for (const operation of consolidatedAgentmemoryOperations) {
    assert.equal(ids.has(operation), false, `${operation} should not remain a skill id`);
    assert.equal(
      installMap.entries.some((entry) => entry.target === `.agents/skills/${operation}/SKILL.md`),
      false,
      `${operation} should not remain a top-level installed skill`,
    );
    assert.match(content, new RegExp(`references/${operation}\\.md`, 'u'));
    assert.equal(
      await readFile(path.join(rootDir, `skills/integrations/agentmemory/references/${operation}.md`), 'utf8')
        .then((reference) => reference.length > 0),
      true,
    );
  }

  const plan = await createInstallPlan({ dryRun: true, profile: 'full', rootDir, targetDir: rootDir });
  const targets = plan.actions.map((action) => action.relativeTarget.replaceAll('\\', '/'));
  assert.ok(targets.includes('.agents/skills/agentmemory/SKILL.md'));
  for (const operation of consolidatedAgentmemoryOperations) {
    assert.ok(targets.includes(`.agents/skills/agentmemory/references/${operation}.md`));
    assert.equal(targets.includes(`.agents/skills/${operation}/SKILL.md`), false);
  }
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
  assert.match(stdout, /总数：18/);
  assert.match(stdout, /native：15/);
  assert.match(stdout, /integration：2/);
  assert.match(stdout, /router：1/);
  assert.match(stdout, /compatibility：0/);
  assert.match(stdout, /最长入口：`api-and-interface-design`（7[0-9] 行）/);
});

test('skills audit executes the real graph validator', async () => {
  const report = await runSkillsAudit(rootDir);
  assert.deepEqual(report.errors, []);

  const target = await mkdtemp(path.join(rootDir, '.tmp-skills-audit-'));
  try {
    const item = skill('broken', { optionalSkills: ['missing'] });
    await mkdir(path.dirname(path.join(target, item.source)), { recursive: true });
    await writeFile(path.join(target, item.source), '---\nname: broken\ndescription: Broken fixture.\n---\n', 'utf8');
    await writeFile(path.join(target, item.metadata), '{"id":"broken"}\n', 'utf8');
    const invalid = await runSkillsAudit(target, {
      installEntries: [], manifest: { items: [item] }, profiles: { items: [] },
    });
    assert.match(invalid.errors.join('\n'), /missing/u);
  } finally {
    await rm(target, { force: true, recursive: true });
  }
});

test('external integration skills document usable and unavailable paths', async () => {
  const manifest = await readJson(path.join(rootDir, 'manifests/skills.json'));
  const readSkill = async (id) => {
    const item = manifest.items.find((candidate) => candidate.id === id);
    return readFile(path.join(rootDir, item.source), 'utf8');
  };
  assert.match(await readSkill('code-review-and-quality'), /ocr llm test[\s\S]*回退/u);
  assert.match(await readSkill('agentmemory'), /MCP[\s\S]*HTTP API[\s\S]*回退/u);
  assert.match(await readSkill('agentmemory'), /memory_commits[\s\S]*memory_commit_lookup[\s\S]*git show/u);
  const browserVerification = await readSkill('browser-verification');
  const browserManifest = manifest.items.find((item) => item.id === 'browser-verification');
  assert.match(browserVerification, /Playwright CLI[\s\S]*Chrome DevTools MCP[\s\S]*人工浏览器步骤/u);
  assert.match(browserVerification, /DevTools 定位[\s\S]*Playwright 回归/u);
  assert.deepEqual(browserManifest.requiresTools, ['managed Playwright CLI or Chrome DevTools MCP']);
});

test('active installable assets do not depend on retired environment-provided capabilities', async () => {
  const roots = ['rules', 'skills', 'manifests', 'adapters', 'runtime'];
  const forbidden = /browser-testing-with-devtools|`impeccable`|`taste-skill`|环境提供的/iu;
  for (const root of roots) {
    for (const file of await filesUnder(path.join(rootDir, root))) {
      if (!['.js', '.json', '.md', '.mjs', '.toml', '.ts', '.yaml', '.yml'].includes(path.extname(file))) continue;
      const content = await readFile(file, 'utf8');
      assert.doesNotMatch(content, forbidden, path.relative(rootDir, file));
    }
  }
});

test('core and full install only the streamlined skill sets', async () => {
  const expectedCore = new Set([
    'adversarial-review-packet',
    'api-and-interface-design',
    'brainstorming',
    'browser-verification',
    'code-review-and-quality',
    'eval-driven-development',
    'executing-plans',
    'security-and-hardening',
    'systematic-debugging',
    'test-driven-development',
    'using-cognis',
    'verification-before-completion',
    'writing-plans',
  ]);
  const expectedFullOnly = new Set([
    'agentmemory',
    'frontend-design',
    'loop-planning',
    'runtime-cross-repo-rollout',
    'subagent-driven-development',
  ]);

  for (const [profile, expected] of [
    ['core', expectedCore],
    ['full', new Set([...expectedCore, ...expectedFullOnly])],
  ]) {
    const plan = await createInstallPlan({ dryRun: true, profile, rootDir, targetDir: rootDir });
    const installed = new Set(plan.actions
      .map((entry) => entry.relativeTarget.replaceAll('\\', '/'))
      .filter((target) => /^\.agents\/skills\/[^/]+\/SKILL\.md$/u.test(target))
      .map((target) => target.split('/')[2]));
    assert.deepEqual(installed, expected, `${profile} installed skill set`);
  }
});
