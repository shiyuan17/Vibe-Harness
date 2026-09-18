import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { pathExists, readPackJson } from './manifest.js';

const RULES_MANIFEST = 'manifests/rules.json';

function firstHeading(content) {
  const match = String(content).match(/^#[ \t]+(.+?)[ \t]*$/mu);
  return match ? match[1].trim() : null;
}

function normalizePath(value) {
  return String(value ?? '').replaceAll('\\', '/');
}

/**
 * Builds the `docs/rules/` routing index from the rule manifest plus each
 * rule's first heading. The manifest is the single source of rule ids and
 * paths, so the index cannot list a rule the pack does not ship; a manifest
 * entry without id/source, a missing rule file, or a rule file without a first
 * heading fails closed instead of rendering a silently partial index into the
 * hosts' resident instructions.
 *
 * @param {string} rootDir Pack root that owns `manifests/rules.json`.
 * @returns {Promise<Array<{ id: string, source: string, title: string }>>}
 */
export async function loadRuleIndex(rootDir) {
  const manifest = await readPackJson(path.join(rootDir, RULES_MANIFEST));
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.items)) {
    throw new Error('manifests/rules.json must declare schemaVersion 1 and an items array.');
  }
  const index = [];
  for (const item of manifest.items) {
    const { id, source } = item ?? {};
    if (typeof id !== 'string' || id === '' || typeof source !== 'string' || source === '') {
      throw new Error('manifests/rules.json items require a non-empty id and source.');
    }
    const content = await readFile(path.join(rootDir, source), 'utf8');
    const title = firstHeading(content);
    if (!title) throw new Error(`rule file has no first heading: ${source}`);
    index.push({ id, source, title });
  }
  return index;
}

/**
 * Keep only the rules the current plan actually installs.
 *
 * `loadRuleIndex` describes the pack's whole rule catalog, but the resident
 * line is a routing index for one project: listing a rule that the selected
 * profile, module or plugin did not install sends the host to a file that is
 * not there, and it advertises capabilities the project does not have (for
 * example the optional `codebase-memory-mcp`, `rtk`, `ast-grep` and
 * `chrome-devtools-mcp` rules in a minimal install). The caller owns the
 * installed target set; this helper only applies it, so the index and the rest
 * of the installed surface are derived from the same plan.
 *
 * @param {Array<{ id: string, source: string, title: string }>} index rule catalog
 * @param {string[]} installedTargets project-relative installed paths
 * @returns {Array<{ id: string, source: string, title: string }>}
 */
export function installedRuleIndex(index = [], installedTargets = []) {
  const installed = new Set((installedTargets ?? []).map(normalizePath));
  return index.filter((item) => installed.has(normalizePath(item?.source)));
}

/**
 * Rule sources that already exist in the target project.
 *
 * The resident line is a routing index for the project, not for the current
 * run: a rule file that is already on disk is routable whether or not this plan
 * rewrites it. Without this union the pack repository — which keeps the
 * optional-plugin rules on disk while installing them only on request — listed
 * 15 of its 21 rule files in its own AGENTS.md, so the host could not route to
 * `linear-workflow`, `role-routing` or the four optional-tool rules that were
 * sitting right there. A target project that never installed a file is
 * unaffected: the file does not exist, so it is not added.
 *
 * @param {string} targetDir project root that owns the rule files
 * @param {Array<{ id: string, source: string, title: string }>} index rule catalog
 * @returns {Promise<string[]>} project-relative sources present on disk
 */
export async function existingRuleSources(targetDir, index = []) {
  if (!targetDir) return [];
  const present = [];
  for (const item of index) {
    const source = normalizePath(item?.source);
    if (!source) continue;
    if (await pathExists(path.join(targetDir, source))) present.push(source);
  }
  return present;
}

/**
 * Routing groups for the resident index. A flat list of 21 `id（title）` pairs
 * was one long sentence with no shape: the host could not tell a governance
 * rule from an optional-tool rule, and every new rule lengthened the same line.
 * The groups mirror the categories the pack already documents — governance,
 * engineering, tool integrations and release/troubleshooting — while keeping
 * the manifest as the single source of which rules exist. An id that no group
 * claims still renders (under the trailing group) so a new manifest entry can
 * never be silently dropped; `tests/rules-index.test.js` asserts the pack's own
 * catalog is fully assigned.
 */
const RULE_GROUPS = [
  {
    ids: [
      'governance-core', 'agent-skill-routing', 'eval-driven-development',
      'role-routing', 'git-rules', 'test-rules', 'ai-collab-rules',
      'review-report', 'response-modes',
    ],
    label: '治理',
  },
  {
    ids: [
      'coding-rules', 'frontend-rules', 'api-rules', 'db-rules',
      'log-management', 'project-directory', 'project-specific-rules',
    ],
    label: '工程',
  },
  {
    ids: ['codebase-memory-mcp', 'chrome-devtools-mcp', 'linear-workflow', 'rtk', 'ast-grep'],
    label: '工具与集成',
  },
  { ids: ['release-rules', 'troubleshooting'], label: '发布与排障' },
];

const UNGROUPED_LABEL = '其他';

const ruleGroupByRuleId = new Map(RULE_GROUPS.flatMap((group) => group.ids.map((id) => [id, group.label])));

/** @param {string} id @returns {string} */
export function ruleGroupLabel(id) {
  return ruleGroupByRuleId.get(String(id)) ?? UNGROUPED_LABEL;
}

/**
 * Renders the index as one grouped line so hosts can route to the matching rule
 * file without listing `docs/rules/` first. Ids carry the routing signal,
 * titles disambiguate the ones whose id is not self-describing, and the group
 * prefix tells the host which family of rule it is looking at.
 *
 * @param {Array<{ id: string, title: string }>} index
 * @returns {string}
 */
export function renderRuleIndexLine(index = []) {
  /** @type {Map<string, string[]>} */
  const buckets = new Map();
  for (const group of RULE_GROUPS) buckets.set(group.label, []);
  buckets.set(UNGROUPED_LABEL, []);
  for (const item of index) {
    // `codebase-memory-mcp（codebase-memory-mcp）` costs the host bytes without
    // adding routing signal, so an id that repeats in its own title stays bare.
    const label = String(item.title ?? '').toLowerCase() === String(item.id).toLowerCase()
      ? item.id
      : `${item.id}（${item.title}）`;
    const group = ruleGroupLabel(item.id);
    const entries = buckets.get(group);
    if (entries) entries.push(label);
    else buckets.set(group, [label]);
  }
  return [...buckets.entries()]
    .filter(([, entries]) => entries.length > 0)
    .map(([label, entries]) => `${label} ${entries.join('、')}`)
    .join('；');
}

/**
 * The full `rulesLine` of the installed surface. Shared with the instruction
 * budget gate so the gate measures the same text the hosts receive instead of a
 * shorter placeholder.
 *
 * @param {Array<{ id: string, title: string }>} index
 * @returns {string}
 */
export function renderRulesLine(index = []) {
  const base = '- 规则位于 `docs/rules/`。';
  return index.length === 0 ? base : `${base}命中索引：${renderRuleIndexLine(index)}。`;
}
