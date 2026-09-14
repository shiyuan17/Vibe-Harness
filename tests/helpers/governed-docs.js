// Shared helpers for tests that guard governed documentation: rules, templates,
// and adapter instruction files.
//
// The wording anchors these tests assert are declared once in
// scripts/lib/pack-validation.js, where `pnpm validate` already enforces them.
// A test therefore names the file it protects without re-listing prose
// sentences per assertion, so rewording a rule stays a single edit in one table
// and a missing clause is reported as a named anchor instead of an anonymous
// regex mismatch.
//
// Contracts a phrase table cannot express stay here: markdown table columns,
// and agreement between a rule's enumerated vocabulary and the machine-readable
// module that consumes it.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { contentQualityCheck } from '../../scripts/lib/pack-validation.js';

/**
 * Assert that every declared wording anchor for `files` is still present.
 *
 * @param {string} rootDir repository root
 * @param {string[]} files repository-relative paths declared in CONTENT_QUALITY_CHECKS
 */
export async function assertRuleAnchors(rootDir, files) {
  const missing = [];
  for (const file of files) {
    const { terms } = contentQualityCheck(file);
    const content = await readFile(path.join(rootDir, file), 'utf8');
    for (const term of terms) {
      if (!content.includes(term)) missing.push(`${file}: ${term}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    'declared rule wording anchors must stay present; reword them in scripts/lib/pack-validation.js CONTENT_QUALITY_CHECKS',
  );
}

/**
 * Read the first markdown table that follows `anchor` as its header and rows.
 *
 * @param {string} content markdown document
 * @param {string} anchor heading or sentence that introduces the table
 * @returns {{header: string[], rows: string[][]}} trimmed cells without outer pipes
 */
export function markdownTable(content, anchor) {
  const start = content.indexOf(anchor);
  assert.notEqual(start, -1, `missing section: ${anchor}`);
  const lines = content.slice(start + anchor.length).split(/\r?\n/u);
  const headerIndex = lines.findIndex((line) => line.trimStart().startsWith('|'));
  assert.notEqual(headerIndex, -1, `missing table under: ${anchor}`);
  const separator = lines[headerIndex + 1]?.trim() ?? '';
  assert.match(separator, /^\|[\s:|-]+\|$/u, `table under ${anchor} has no GFM separator row`);
  const cells = (line) => line.trim().split('|').slice(1, -1).map((cell) => cell.trim());
  const header = cells(lines[headerIndex]);
  const rows = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.trimStart().startsWith('|')) break;
    rows.push(cells(line));
  }
  return { header, rows };
}
