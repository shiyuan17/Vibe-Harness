// Temporary migration policy, deliberately outside the project checkout.
// This is an explicit risk acceptance, NOT authentication of the envelope.
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const LEGACY_COMPAT_PATH = process.platform === 'win32'
  ? 'C:\\ProgramData\\Vibe-Harness\\execution-envelope-compat.json'
  : '/etc/vibe-harness/execution-envelope-compat.json';

export function readLegacyCompatibility() {
  try {
    const parent = lstatSync(path.dirname(LEGACY_COMPAT_PATH));
    const file = lstatSync(LEGACY_COMPAT_PATH);
    if (!parent.isDirectory() || parent.isSymbolicLink() || !file.isFile() || file.isSymbolicLink()
      || file.size > 1024) return null;
    // On POSIX only a root-owned, non-group/world-writable policy is usable.
    // Windows deployment must restrict the fixed ProgramData folder to
    // Administrators/SYSTEM; this local policy remains an unauthenticated
    // compatibility exception and must never be labeled host proof.
    if (process.platform !== 'win32'
      && (parent.uid !== 0 || file.uid !== 0 || (parent.mode & 0o022) || (file.mode & 0o022))) return null;
    const policy = JSON.parse(readFileSync(LEGACY_COMPAT_PATH, 'utf8'));
    if (Object.keys(policy).sort().join(',') !== 'acknowledgedRisk,enabledAt,expiresAt') return null;
    return policy;
  } catch {
    return null;
  }
}
