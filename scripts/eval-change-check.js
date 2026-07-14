#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GOVERNANCE_PATH = /^(?:adapters|manifests|rules|skills|templates)\//u;
const HOOK_PATH = /^runtime\/hooks\//u;
const SUITE_PATH = /^evals\/suites\/.*\.json$/u;

export function evaluateGovernanceEvalChanges({ addedEvalCases = [], changedFiles, coverageKeys = [], uncoveredCapabilities = [] }) {
  const governanceFiles = changedFiles.filter((file) => GOVERNANCE_PATH.test(file) || HOOK_PATH.test(file));
  if (governanceFiles.length === 0) return { governanceFiles, ok: true };
  const requiredCoverageKeys = coverageKeys.length > 0 ? coverageKeys : governanceFiles.map((file) => `file:${file}`);
  const addedEvalIds = addedEvalCases.map((item) => item.id);
  if (uncoveredCapabilities.length === 0 && addedEvalIds.length >= requiredCoverageKeys.length) {
    return { addedEvalIds, coverageKeys: requiredCoverageKeys, governanceFiles, ok: true };
  }
  return {
    addedEvalIds,
    coverageKeys: requiredCoverageKeys,
    governanceFiles,
    ok: false,
    uncoveredCapabilities,
    error: 'Governance behavior changed without sufficient capability-mapped new Eval-ID coverage.',
  };
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim();
}

function caseIds(text, label) {
  if (!text) return new Set();
  const suite = JSON.parse(text);
  if (!Array.isArray(suite.cases)) throw new Error(`${label} does not contain a cases array`);
  return new Set(suite.cases.map((item) => item?.id).filter((id) => typeof id === 'string'));
}

function baseFile(base, file) {
  try {
    return git(['show', `${base}:${file}`]);
  } catch {
    return '';
  }
}

export function inspectGitChanges(base) {
  if (!base) throw new Error('eval change check requires --base <git-sha>');
  git(['cat-file', '-e', `${base}^{commit}`]);
  const changedFiles = git(['diff', '--name-only', base, 'HEAD'])
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((file) => file.replaceAll('\\', '/'));
  const governanceFiles = changedFiles.filter((file) => GOVERNANCE_PATH.test(file) || HOOK_PATH.test(file));
  if (governanceFiles.length === 0) return evaluateGovernanceEvalChanges({ changedFiles });
  const addedEvalCases = [];
  for (const file of changedFiles.filter((candidate) => SUITE_PATH.test(candidate))) {
    const before = caseIds(baseFile(base, file), `${base}:${file}`);
    const after = existsSync(path.resolve(file))
      ? caseIds(readFileSync(path.resolve(file), 'utf8'), file)
      : new Set();
    const netNewCount = Math.max(0, after.size - before.size);
    const added = [...after].filter((id) => !before.has(id)).slice(0, netNewCount);
    for (const id of added) addedEvalCases.push({ id, suite: file });
  }
  const matrix = JSON.parse(readFileSync(path.resolve('manifests/capabilities.json'), 'utf8'));
  const coverageKeys = new Set();
  const requiredSuites = new Map();
  for (const file of governanceFiles) {
    const matches = matrix.items.filter((item) => item.targets?.includes(file));
    if (matches.length === 0) {
      coverageKeys.add(`file:${file}`);
      continue;
    }
    for (const item of matches) {
      coverageKeys.add(`capability:${item.id}`);
      requiredSuites.set(item.id, item.evals ?? []);
    }
  }
  const uncoveredCapabilities = [...requiredSuites]
    .filter(([, suites]) => !addedEvalCases.some((item) => suites.includes(item.suite)))
    .map(([id]) => id)
    .sort();
  return evaluateGovernanceEvalChanges({
    addedEvalCases,
    changedFiles,
    coverageKeys: [...coverageKeys].sort(),
    uncoveredCapabilities,
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
