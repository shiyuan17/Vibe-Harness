#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GOVERNANCE_PATH = /^(?:adapters|manifests|rules|skills|templates)\//u;
const HOOK_PATH = /^runtime\/hooks\//u;
const EVAL_PATH = /^(?:runtime\/evals\/|scripts\/eval-(?:change-check|check|health|online)\.js$|scripts\/lib\/eval-[^/]+\.js$|scripts\/lib\/project-evaluation\.js$|\.github\/workflows\/evals\.yml$)/u;
const SUITE_PATH = /^evals\/suites\/.*\.json$/u;

function isGovernanceFile(file) {
  return GOVERNANCE_PATH.test(file) || HOOK_PATH.test(file) || EVAL_PATH.test(file);
}

export function evaluateGovernanceEvalChanges({ addedEvalCases = [], changedFiles, coverageKeys, requiredSuites = {} }) {
  const governanceFiles = changedFiles.filter(isGovernanceFile);
  if (governanceFiles.length === 0) return { governanceFiles, ok: true };
  const requiredCoverageKeys = coverageKeys === undefined
    ? governanceFiles.map((file) => `file:${file}`)
    : coverageKeys;
  const addedEvalIds = addedEvalCases.map((item) => item.id);
  const uncoveredFiles = requiredCoverageKeys.filter((key) => key.startsWith('file:'));
  const requiredCapabilities = requiredCoverageKeys
    .filter((key) => key.startsWith('capability:'))
    .map((key) => key.slice('capability:'.length));
  const uncoveredCapabilities = requiredCapabilities.filter((capability) => {
    const suites = requiredSuites[capability] ?? [];
    return !addedEvalCases.some((item) => item.capability === capability && suites.includes(item.suite));
  });
  if (uncoveredCapabilities.length === 0 && uncoveredFiles.length === 0) {
    return { addedEvalIds, coverageKeys: requiredCoverageKeys, governanceFiles, ok: true };
  }
  return {
    addedEvalIds,
    coverageKeys: requiredCoverageKeys,
    governanceFiles,
    ok: false,
    uncoveredCapabilities,
    uncoveredFiles,
    error: 'Governance behavior changed without sufficient capability-mapped new Eval-ID coverage.',
  };
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim();
}

function casesById(text, label) {
  if (!text) return new Map();
  const suite = JSON.parse(text);
  if (!Array.isArray(suite.cases)) throw new Error(`${label} does not contain a cases array`);
  return new Map(suite.cases
    .filter((item) => typeof item?.id === 'string')
    .map((item) => [item.id, item]));
}

function baseFile(base, file) {
  try {
    return git(['show', `${base}:${file}`]);
  } catch {
    return '';
  }
}

export function coverageForGovernanceFiles({ baseItems = [], currentItems, fileExists, governanceFiles }) {
  const baseById = new Map(baseItems.map((item) => [item.id, item]));
  const currentById = new Map(currentItems.map((item) => [item.id, item]));
  const coverageKeys = new Set();
  const requiredSuites = {};
  for (const file of governanceFiles) {
    const capabilityIds = new Set([...baseItems, ...currentItems]
      .filter((item) => item.targets?.includes(file))
      .map((item) => item.id));
    if (capabilityIds.size === 0 && !fileExists(file) && file.startsWith('skills/')) {
      capabilityIds.add('skill-quality');
    }
    if (capabilityIds.size === 0) {
      coverageKeys.add(`file:${file}`);
      continue;
    }
    for (const id of capabilityIds) {
      const item = currentById.get(id) ?? baseById.get(id);
      if (item?.evaluation?.required) {
        coverageKeys.add(`capability:${item.id}`);
        requiredSuites[item.id] = item.evaluation.suites ?? [];
      }
    }
  }
  return { coverageKeys: [...coverageKeys].sort(), requiredSuites };
}

export function inspectGitChanges(base) {
  if (!base) throw new Error('eval change check requires --base <git-sha>');
  git(['cat-file', '-e', `${base}^{commit}`]);
  const changedFiles = git(['diff', '--name-only', base, 'HEAD'])
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((file) => file.replaceAll('\\', '/'));
  const governanceFiles = changedFiles.filter(isGovernanceFile);
  if (governanceFiles.length === 0) return evaluateGovernanceEvalChanges({ changedFiles });
  const addedEvalCases = [];
  for (const file of changedFiles.filter((candidate) => SUITE_PATH.test(candidate))) {
    const before = casesById(baseFile(base, file), `${base}:${file}`);
    const after = existsSync(path.resolve(file))
      ? casesById(readFileSync(path.resolve(file), 'utf8'), file)
      : new Map();
    for (const [id, definition] of after) {
      if (!before.has(id)) addedEvalCases.push({ capability: definition.capability, id, suite: file });
    }
  }
  const matrix = JSON.parse(readFileSync(path.resolve('manifests/capabilities.json'), 'utf8'));
  const baseMatrixText = baseFile(base, 'manifests/capabilities.json');
  const baseMatrix = baseMatrixText ? JSON.parse(baseMatrixText) : { items: [] };
  const { coverageKeys, requiredSuites } = coverageForGovernanceFiles({
    baseItems: baseMatrix.items,
    currentItems: matrix.items,
    fileExists: (file) => existsSync(path.resolve(file)),
    governanceFiles,
  });
  return evaluateGovernanceEvalChanges({
    addedEvalCases,
    changedFiles,
    coverageKeys,
    requiredSuites,
  });
}

function parseBase(argv) {
  const index = argv.indexOf('--base');
  return index >= 0 ? argv[index + 1] : null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const report = inspectGitChanges(parseBase(process.argv.slice(2)));
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  }
}
