// Release readiness checks.
//
// docs/rules/release-rules.md requires version, changelog, rollback, monitoring
// and stop conditions to be settled before a release. Only the version and
// changelog parts are mechanically decidable, so this module checks exactly
// those, plus the optional CI identity facts (verified SHA, clean checkout,
// artifact checksum), and emits one receipt other tooling can attach to a
// release.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { pathExists, readJson } from './manifest.js';

const execFileAsync = promisify(execFile);

export const RELEASE_MANIFEST_PATH = '.release-please-manifest.json';
export const CHANGELOG_PATH = 'CHANGELOG.md';
export const PACKAGE_MANIFEST_PATH = 'package.json';

/**
 * Read the release version from the release-please manifest, accepting both the
 * `{"version": "x"}` and release-please's own `{".": "x"}` shapes.
 *
 * @param {Record<string, unknown>|null} manifest
 */
export function readManifestVersion(manifest) {
  if (!manifest || typeof manifest !== 'object') return null;
  const value = manifest['.'] ?? manifest.version;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Match a CHANGELOG heading for the released version. Hand-written changelogs
// use `## 1.2.3` (optionally with a trailing date); release-please writes
// `## [1.2.3](compare-url) (date)`. Both must count as a released entry, and a
// longer version such as 1.2.30 must not match a 1.2.3 heading.
export function findChangelogHeading(content, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(`^##+\\s+(?:\\[v?${escaped}\\]|v?${escaped})(?![\\w.-])(?:\\s|$|\\()`, 'mu');
  return pattern.test(content);
}

async function git(rootDir, args) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: rootDir, windowsHide: true });
    return { ok: true, value: stdout.trim() };
  } catch (error) {
    return { ok: false, value: error?.message ?? 'git command failed' };
  }
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

/**
 * Collect release readiness checks. Every check reports its own status so the
 * caller can decide which ones gate a given release boundary.
 *
 * @param {{rootDir: string, expectedSha?: string|null, requireClean?: boolean, tarball?: string|null, generatedAt?: string}} options
 */
export async function collectReleaseReadiness({
  rootDir,
  expectedSha = null,
  requireClean = false,
  tarball = null,
  generatedAt = new Date().toISOString(),
}) {
  const checks = [];
  const pkg = await readJson(path.join(rootDir, PACKAGE_MANIFEST_PATH));
  const manifest = await readJson(path.join(rootDir, RELEASE_MANIFEST_PATH)).catch(() => null);
  const version = typeof pkg?.version === 'string' ? pkg.version : null;
  const manifestVersion = readManifestVersion(manifest);

  checks.push(version
    ? { detail: `package.json version is ${version}`, id: 'package-version', status: 'passed' }
    : { detail: 'package.json has no version field', id: 'package-version', status: 'failed' });
  checks.push({
    detail: manifestVersion === null
      ? `${RELEASE_MANIFEST_PATH} has no version`
      : `manifest version is ${manifestVersion}`,
    id: 'release-manifest-version',
    status: manifestVersion !== null && manifestVersion === version ? 'passed' : 'failed',
  });

  const changelog = await readFile(path.join(rootDir, CHANGELOG_PATH), 'utf8').catch(() => null);
  checks.push({
    detail: changelog === null ? `${CHANGELOG_PATH} is missing` : `changelog entry for ${version ?? 'unknown version'}`,
    id: 'changelog-entry',
    status: changelog !== null && version !== null && findChangelogHeading(changelog, version) ? 'passed' : 'failed',
  });

  if (expectedSha) {
    const head = await git(rootDir, ['rev-parse', 'HEAD']);
    checks.push({
      detail: head.ok ? `HEAD is ${head.value}` : head.value,
      id: 'verified-sha',
      status: head.ok && head.value === expectedSha ? 'passed' : 'failed',
    });
  }
  if (requireClean) {
    const status = await git(rootDir, ['status', '--porcelain=v1']);
    checks.push({
      detail: status.ok ? (status.value ? `uncommitted changes: ${status.value.split('\n').length}` : 'checkout is clean') : status.value,
      id: 'clean-checkout',
      status: status.ok && status.value === '' ? 'passed' : 'failed',
    });
  }
  if (tarball) {
    const fullPath = path.resolve(rootDir, tarball);
    const exists = await pathExists(fullPath);
    checks.push({
      detail: exists ? `sha256 ${await sha256(fullPath)}` : `missing artifact: ${tarball}`,
      id: 'release-artifact',
      status: exists ? 'passed' : 'failed',
    });
  }

  const failed = checks.filter((check) => check.status !== 'passed');
  return {
    checks,
    generatedAt,
    ok: failed.length === 0,
    schemaVersion: 1,
    status: failed.length === 0 ? 'passed' : 'failed',
    version,
  };
}

/** Write a release readiness receipt; the caller owns the destination path. */
export async function writeReleaseReadiness(receiptPath, receipt) {
  await mkdir(path.dirname(path.resolve(receiptPath)), { recursive: true });
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return receiptPath;
}
