import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { readInstallState } from './install-state.js';
import { pathExists, readPackJson } from './manifest.js';

const RULES_MANIFEST = 'manifests/rules.json';

/**
 * The heading every layered rule uses for its top card.
 *
 * A rule file a host reads on demand is otherwise a single unit: routing to it
 * costs the whole file. The card states the default execution surface so the
 * host can stop there and read the rest only when the task exceeds it. The
 * marker in the resident index is derived from this heading rather than
 * declared separately, so the index can never advertise a card the file does
 * not have.
 */
export const FAST_PATH_CARD_HEADING = '## Fast Path 卡片';

/** @param {string} content rule file body @returns {boolean} */
export function declaresFastPathCard(content) {
  return new RegExp(`^${FAST_PATH_CARD_HEADING}[ \\t]*$`, 'mu').test(String(content));
}

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
 * @returns {Promise<Array<{ id: string, source: string, title: string, hasCard: boolean }>>}
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
    index.push({ hasCard: declaresFastPathCard(content), id, source, title });
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
 * Rule sources the target project actually owns.
 *
 * The resident line is a routing index for the project, not for the pack
 * catalog: a rule is routable only when it is both on disk and recorded in
 * the project's install state. That state's `files` ledger is cumulative
 * across transactions (see `mergeInstallState` in install-planner.js), so a
 * rule an earlier install wrote stays owned after a partial refresh that
 * does not rewrite it. On-disk presence alone is not ownership: the pack
 * repository keeps the optional-plugin rules on disk while never installing
 * them, and advertising those would route the host to files the project did
 * not choose to install. Callers still retire targets this run removes.
 *
 * @param {string} targetDir project root that owns the rule files
 * @param {Array<{ id: string, source: string, title: string }>} index rule catalog
 * @returns {Promise<string[]>} project-relative sources owned in install state and present on disk
 */
export async function existingRuleSources(targetDir, index = []) {
  if (!targetDir) return [];
  const state = await readInstallState(path.resolve(targetDir));
  const owned = new Set((state?.files ?? []).map((file) => normalizePath(file?.target)));
  const present = [];
  for (const item of index) {
    const source = normalizePath(item?.source);
    if (!source || !owned.has(source)) continue;
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
      'review-report', 'response-modes', 'micro-verification',
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
    ids: ['codebase-memory-mcp', 'chrome-devtools-mcp', 'linear-workflow', 'rtk', 'ast-grep', 'codegraph', 'serena', 'probe'],
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
 * Card-bearing rules carry a `⚡` suffix so the host knows the file starts with
 * a card it may stop at instead of reading the whole rule.
 *
 * @param {Array<{ id: string, title: string, hasCard?: boolean }>} index
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
    const marked = item.hasCard ? `${label}⚡` : label;
    const group = ruleGroupLabel(item.id);
    const entries = buckets.get(group);
    if (entries) entries.push(marked);
    else buckets.set(group, [marked]);
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
 * The legend is emitted only when an installed rule actually declares a card,
 * so a project whose rules carry none does not pay for the explanation.
 *
 * @param {Array<{ id: string, title: string, hasCard?: boolean }>} index
 * @returns {string}
 */
export function renderRulesLine(index = []) {
  const base = '- 规则位于 `docs/rules/`。';
  if (index.length === 0) return base;
  const legend = index.some((item) => item?.hasCard) ? '（⚡ 先读该规则顶部的 Fast Path 卡片）' : '';
  return `${base}命中索引${legend}：${renderRuleIndexLine(index)}。`;
}
