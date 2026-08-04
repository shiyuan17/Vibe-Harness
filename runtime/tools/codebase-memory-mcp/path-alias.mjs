import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function aliasPathForRoot(root) {
  const normalizedRoot = path.resolve(root).replaceAll('\\', '/').toLowerCase();
  const digest = createHash('sha256').update(normalizedRoot, 'utf8').digest('hex').slice(0, 16);
  return path.join(tmpdir(), `vibe-harness-cbm-${digest}`);
}

export function replaceAliasInStatusOutput(output, alias, target) {
  const escapedAlias = alias.replaceAll('\\', '\\\\');
  const escapedTarget = target.replaceAll('\\', '\\\\');
  const slashAlias = alias.replaceAll('\\', '/');
  const slashTarget = target.replaceAll('\\', '/');
  return output.replaceAll(escapedAlias, escapedTarget).replaceAll(slashAlias, slashTarget);
}
