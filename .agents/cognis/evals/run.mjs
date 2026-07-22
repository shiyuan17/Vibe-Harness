#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const DIMENSIONS = ['correctness', 'safety', 'evidenceQuality', 'efficiency'];

function argsOf(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`);
    args[token.slice(2)] = value;
    index += 1;
  }
  return args;
}

function inside(root, relative, label) {
  if (!relative || path.isAbsolute(relative) || path.win32.isAbsolute(relative)) throw new Error(`${label} must be project-relative`);
  const target = path.resolve(root, relative);
  const relation = path.relative(root, target);
  if (relation.startsWith('..') || path.isAbsolute(relation)) throw new Error(`${label} must stay inside the project`);
  return target;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function round(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function assertion(kind, item, passed) {
  return { kind, dimension: item.dimension, critical: item.critical, expected: item.value, passed };
}

function score(definition) {
  const observation = definition.input.replay;
  const assertions = [];
  for (const item of definition.oracle.requiredEvents) assertions.push(assertion('required-event', item, observation.events.includes(item.value)));
  for (const item of definition.oracle.forbiddenEvents) assertions.push(assertion('forbidden-event', item, !observation.events.includes(item.value)));
  for (const item of definition.oracle.requiredOutputFragments) assertions.push(assertion('required-output-fragment', item, observation.output.includes(item.value)));
  for (const item of definition.oracle.forbiddenOutputFragments) assertions.push(assertion('forbidden-output-fragment', item, !observation.output.includes(item.value)));
  for (const item of definition.oracle.requiredArtifacts) assertions.push(assertion('required-artifact', item, observation.artifacts.includes(item.value)));
  for (const item of definition.oracle.forbiddenArtifacts) assertions.push(assertion('forbidden-artifact', item, !observation.artifacts.includes(item.value)));
  assertions.push(assertion('exit-code', definition.oracle.exitCode, observation.exitCode === definition.oracle.exitCode.value));
  const dimensionScores = Object.fromEntries(DIMENSIONS.map((dimension) => {
    const items = assertions.filter((item) => item.dimension === dimension);
    return [dimension, items.length === 0 ? 1 : round(items.filter((item) => item.passed).length / items.length)];
  }));
  const weight = DIMENSIONS.reduce((total, dimension) => total + definition.weights[dimension], 0);
  const criticalFailures = assertions.filter((item) => item.critical && !item.passed).length;
  return {
    id: definition.id,
    capability: definition.capability,
    passed: criticalFailures === 0,
    score: round(DIMENSIONS.reduce((total, dimension) => total + dimensionScores[dimension] * definition.weights[dimension], 0) / weight),
    weight,
    criticalAssertions: assertions.filter((item) => item.critical).length,
    criticalFailures,
    dimensionScores,
    assertions,
  };
}

function aggregate(cases) {
  const grouped = new Map();
  for (const item of cases) grouped.set(item.capability, [...(grouped.get(item.capability) ?? []), item]);
  const capabilities = [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, items]) => {
    const weight = items.reduce((total, item) => total + item.weight, 0);
    return { id, caseCount: items.length, passedCount: items.filter((item) => item.passed).length, score: round(items.reduce((total, item) => total + item.score * item.weight, 0) / weight) };
  });
  const critical = cases.reduce((total, item) => total + item.criticalAssertions, 0);
  const failures = cases.reduce((total, item) => total + item.criticalFailures, 0);
  return {
    capabilities,
    overallScore: round(capabilities.reduce((total, item) => total + item.score, 0) / capabilities.length),
    criticalPassRate: critical === 0 ? 1 : round((critical - failures) / critical),
  };
}

const args = argsOf(process.argv.slice(2));
const project = path.resolve(args.project ?? process.cwd());
const suitePath = inside(project, args.suite, 'suite');
const referencePath = inside(project, args.reference, 'reference');
const [suite, reference] = await Promise.all([
  readFile(suitePath, 'utf8').then(JSON.parse),
  readFile(referencePath, 'utf8').then(JSON.parse),
]);
const hash = createHash('sha256').update(stable(suite)).digest('hex');
const cases = suite.cases.map(score);
const summary = aggregate(cases);
const fingerprint = { suiteHash: hash, runner: 'offline-replay@1', model: 'fixture', agent: 'offline', governanceHash: 'fixture-v1' };
const fingerprintMatches = Object.entries(fingerprint).every(([key, value]) => reference.fingerprint?.[key] === value);
const generatedAt = new Date().toISOString();
const run = {
  schemaVersion: 1,
  id: `${suite.id}-offline-${generatedAt}`,
  generatedAt,
  suite: { id: suite.id, version: suite.version, hash, path: args.suite },
  mode: 'offline',
  status: cases.every((item) => item.passed) ? 'passed' : 'failed',
  fingerprint,
  reference: { path: args.reference, status: fingerprintMatches ? 'matched' : 'mismatched' },
  caseRepetitions: suite.cases.map((item) => ({ id: item.id, count: 1 })),
  cases,
  ...summary,
  diagnostics: fingerprintMatches ? [] : ['reference fingerprint mismatch'],
};
console.log(JSON.stringify(run));
if (run.status !== 'passed') process.exitCode = 1;
if (!fingerprintMatches) process.exitCode = 2;
