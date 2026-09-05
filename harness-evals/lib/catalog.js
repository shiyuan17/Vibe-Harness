import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { validateJsonAgainstSchema } from '../../scripts/lib/manifest.js';

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function loadHarnessEvalCatalog(rootDir) {
  if (!path.isAbsolute(rootDir ?? '')) throw new TypeError('rootDir must be absolute');
  const scenariosDir = path.join(rootDir, 'harness-evals/scenarios');
  const [index, scenarioSchema, fixtureSchema] = await Promise.all([
    readJson(path.join(scenariosDir, 'index.json')),
    readJson(path.join(rootDir, 'schemas/harness-eval-scenario.schema.json')),
    readJson(path.join(rootDir, 'schemas/harness-eval-fixture.schema.json')),
  ]);
  const errors = [];
  const scenarios = [];
  const seen = new Set();
  for (const entry of index.scenarios ?? []) {
    if (seen.has(entry.id)) errors.push(`duplicate scenario id: ${entry.id}`);
    seen.add(entry.id);
    const scenario = await readJson(path.join(scenariosDir, entry.file));
    errors.push(...validateJsonAgainstSchema(scenario, scenarioSchema, entry.file));
    if (scenario.id !== entry.id) errors.push(`${entry.file} id ${scenario.id} does not match index id ${entry.id}`);
    const fixturePath = path.resolve(scenariosDir, scenario.fixture.ref);
    const expectedFixtureDir = path.join(rootDir, 'harness-evals/fixtures');
    const relative = path.relative(expectedFixtureDir, fixturePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      errors.push(`${entry.file} fixture reference escapes harness-evals/fixtures`);
      continue;
    }
    const fixture = await readJson(fixturePath);
    errors.push(...validateJsonAgainstSchema(fixture, fixtureSchema, `${entry.file} fixture`));
    if (fixture.id !== scenario.id) errors.push(`${entry.file} fixture id ${fixture.id} does not match ${scenario.id}`);
    scenarios.push(scenario);
  }
  return { schemaVersion: 1, scenariosDir, scenarios, errors };
}
