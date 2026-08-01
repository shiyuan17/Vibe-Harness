// Shared primitives for Vibe-Harness-managed content blocks delimited by start/end
// markers (e.g. `<!-- VIBE_HARNESS:START -->` ... `<!-- VIBE_HARNESS:END -->` or
// `# VIBE_HARNESS:MCP:START` ... `# VIBE_HARNESS:MCP:END`). The block-specific modules
// keep their own validation and merge semantics; this module centralises the
// repetitive find/strip/extract/remove structure, the contentStrategy
// classification, and the managed-block hash computation shared by
// install-planner and install-state.
//
// To avoid a circular dependency with `tool-provisioning.js` and
// `template-renderer.js` (which both import from this module), `managedBlockHash`
// accepts an already-extracted block string rather than importing the extract
// functions directly. Callers extract the block via their own imports and pass
// it in.

import { createHash } from 'node:crypto';

/**
 * Canonical contentStrategy values accepted by the install-map schema and the
 * `manifest.js` shape validator. Keep in sync with `schemas/install-map.schema.json`.
 */
export const CONTENT_STRATEGIES = [
  'managed-ignore-block',
  'managed-instruction-block',
  'managed-toml-block',
  'replace',
];

/** True for instruction-block strategies (AGENTS.md / Cursor rules). */
export const isManagedInstruction = (strategy) => strategy === 'managed-instruction-block';

/** True for TOML/MCP-block strategies (.codex/config.toml managed section). */
export const isManagedToml = (strategy) => strategy === 'managed-toml-block';

/** True for ignore-block strategies (.gitignore managed section). */
export const isManagedIgnore = (strategy) => strategy === 'managed-ignore-block';

/** True for any managed-block strategy (excludes `replace`). */
export const isManagedBlock = (strategy) =>
  isManagedInstruction(strategy) || isManagedToml(strategy) || isManagedIgnore(strategy);

/**
 * Compute the sha256 hash of an already-extracted managed block. The caller is
 * responsible for extracting the block via the appropriate extractor
 * (`extractManagedInstructionBlock`, `extractManagedMcpBlock`, or
 * `extractManagedCbmIgnoreBlock`) based on the contentStrategy. Null or
 * undefined extracts are normalised to empty string before hashing.
 *
 * @param {string|null|undefined} block - The extracted block text.
 * @returns {string} Hex sha256 digest.
 */
export function hashManagedBlock(block) {
  return createHash('sha256').update(block ?? '').digest('hex');
}

// Locate a single managed block via literal start/end markers. Returns the
// `{ start, end, endMarker }` bounds or `null` when no start marker is present.
// Throws when a start marker exists without a matching end marker.
export function findManagedBlock(content, startMarker, endMarker) {
  const startIndex = content.indexOf(startMarker);
  if (startIndex === -1) return null;
  const endIndex = content.indexOf(endMarker, startIndex);
  if (endIndex === -1) throw new Error(`Malformed Vibe-Harness managed block: missing ${endMarker}.`);
  return { end: endIndex, endMarker, start: startIndex };
}

// Remove the managed block from `content`, collapsing runs of 3+ newlines
// left behind to a single blank line. Returns the content unchanged when no
// block is present.
export function stripManagedBlock(content, startMarker, endMarker) {
  const found = findManagedBlock(content, startMarker, endMarker);
  if (!found) return content;
  return `${content.slice(0, found.start)}${content.slice(found.end + found.endMarker.length)}`
    .replace(/\n{3,}/gu, '\n\n');
}

// Return the raw managed block text (including markers) or an empty string
// when no block is present.
export function extractManagedBlock(content, startMarker, endMarker) {
  const found = findManagedBlock(content, startMarker, endMarker);
  return found ? content.slice(found.start, found.end + found.endMarker.length) : '';
}

// Remove the managed block and trim the remainder, preserving a single
// trailing newline when content remains.
export function removeManagedBlock(content, startMarker, endMarker) {
  const remaining = stripManagedBlock(content, startMarker, endMarker).trim();
  return remaining ? `${remaining}\n` : '';
}
