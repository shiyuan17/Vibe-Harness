// Shared primitives for Cognis-managed content blocks delimited by start/end
// markers (e.g. `<!-- COGNIS:START -->` ... `<!-- COGNIS:END -->` or
// `# COGNIS:MCP:START` ... `# COGNIS:MCP:END`). The block-specific modules
// keep their own validation and merge semantics; this module centralises the
// repetitive find/strip/extract/remove structure.

// Locate a single managed block via literal start/end markers. Returns the
// `{ start, end, endMarker }` bounds or `null` when no start marker is present.
// Throws when a start marker exists without a matching end marker.
export function findManagedBlock(content, startMarker, endMarker) {
  const startIndex = content.indexOf(startMarker);
  if (startIndex === -1) return null;
  const endIndex = content.indexOf(endMarker, startIndex);
  if (endIndex === -1) throw new Error(`Malformed Cognis managed block: missing ${endMarker}.`);
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
