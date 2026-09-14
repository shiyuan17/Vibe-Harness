import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { readPackJson } from './manifest.js';

const RULES_MANIFEST = 'manifests/rules.json';

function firstHeading(content) {
  const match = String(content).match(/^#[ \t]+(.+?)[ \t]*$/mu);
  return match ? match[1].trim() : null;
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
 * Renders the index as one line so hosts can route to the matching rule file
 * without listing `docs/rules/` first. Ids carry the routing signal, titles
 * disambiguate the ones whose id is not self-describing.
 *
 * @param {Array<{ id: string, title: string }>} index
 * @returns {string}
 */
export function renderRuleIndexLine(index = []) {
  return index.map((item) => `${item.id}（${item.title}）`).join('、');
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
