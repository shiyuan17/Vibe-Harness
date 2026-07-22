import { existsSync, readdirSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';

export function validateDesignAssets(root) {
  const designRoot = resolve(root, 'design');
  if (!existsSync(designRoot)) return [];
  const errors = [];
  const entries = readdirSync(designRoot, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.pen') continue;
    const penPath = resolve(entry.parentPath ?? entry.path, entry.name);
    const pngPath = penPath.slice(0, -4) + '.png';
    if (!existsSync(pngPath)) {
      errors.push(`Missing design preview pair: ${relative(root, pngPath).replaceAll('\\', '/')}`);
    }
  }
  return errors;
}
