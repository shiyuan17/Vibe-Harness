import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { parseReleaseArgs } from '../../scripts/release-readiness.js';
import { collectReleaseReadiness, findChangelogHeading, readManifestVersion, writeReleaseReadiness } from '../../scripts/lib/release-readiness.js';
import { removeTemporaryDirectory } from '../../scripts/lib/temp-cleanup.js';

const execFileAsync = promisify(execFile);
const CHANGELOG = '# Changelog\n\n## Unreleased\n\n## [1.2.3](https://example.invalid/compare/v1.2.2...v1.2.3) (2026-09-01)\n\n## 1.2.30 - 2026-08-01\n';

async function makeFixture({ manifest = { '.': '1.2.3' }, pkg = { name: 'fixture', version: '1.2.3' }, changelog = CHANGELOG } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'vibe-release-'));
  await writeFile(path.join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  if (manifest !== null) await writeFile(path.join(root, '.release-please-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  if (changelog !== null) await writeFile(path.join(root, 'CHANGELOG.md'), changelog, 'utf8');
  return root;
}

test('release manifest version accepts both release-please shapes', () => {
  assert.equal(readManifestVersion({ '.': '1.2.3' }), '1.2.3');
  assert.equal(readManifestVersion({ version: '4.5.6' }), '4.5.6');
  assert.equal(readManifestVersion({}), null);
  assert.equal(readManifestVersion(null), null);
});

test('changelog headings match hand-written, dated and release-please link entries', () => {
  assert.equal(findChangelogHeading(CHANGELOG, '1.2.3'), true);
  assert.equal(findChangelogHeading(CHANGELOG, '1.2.30'), true);
  assert.equal(findChangelogHeading('## 0.3.0\n', '0.3.0'), true);
  assert.equal(findChangelogHeading('## v0.4.0 - 2026-01-01\n', '0.4.0'), true);
  assert.equal(findChangelogHeading(CHANGELOG, '1.2.4'), false);
  assert.equal(findChangelogHeading('## 1.2.30\n', '1.2.3'), false);
});

test('release readiness passes when versions and the changelog agree', async () => {
  const root = await makeFixture();
  try {
    const receipt = await collectReleaseReadiness({ generatedAt: '2026-09-13T00:00:00.000Z', rootDir: root });
    assert.equal(receipt.ok, true);
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.version, '1.2.3');
    assert.deepEqual(receipt.checks.map((check) => check.id), ['package-version', 'release-manifest-version', 'changelog-entry']);

    await writeReleaseReadiness(path.join(root, 'release-artifacts', 'release-readiness.json'), receipt);
    assert.equal(JSON.parse(await readFile(path.join(root, 'release-artifacts/release-readiness.json'), 'utf8')).version, '1.2.3');
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('release readiness fails closed on version drift, a missing changelog entry and a missing artifact', async () => {
  const drift = await makeFixture({ manifest: { '.': '1.2.4' } });
  const missingEntry = await makeFixture({ changelog: '# Changelog\n' });
  const missingManifest = await makeFixture({ manifest: null });
  try {
    const driftReceipt = await collectReleaseReadiness({ rootDir: drift });
    assert.equal(driftReceipt.ok, false);
    assert.equal(driftReceipt.checks.find((check) => check.id === 'release-manifest-version').status, 'failed');
    assert.equal((await collectReleaseReadiness({ rootDir: missingEntry })).checks.find((check) => check.id === 'changelog-entry').status, 'failed');
    assert.equal((await collectReleaseReadiness({ rootDir: missingManifest })).checks.find((check) => check.id === 'release-manifest-version').status, 'failed');

    const tarball = 'release-artifacts/pkg.tgz';
    await writeFile(path.join(drift, 'package.tgz'), 'artifact\n', 'utf8');
    const artifactReceipt = await collectReleaseReadiness({ rootDir: drift, tarball: path.join(drift, 'package.tgz') });
    const expected = createHash('sha256').update('artifact\n').digest('hex');
    assert.equal(artifactReceipt.checks.find((check) => check.id === 'release-artifact').detail, `sha256 ${expected}`);
    assert.equal((await collectReleaseReadiness({ rootDir: drift, tarball })).checks.find((check) => check.id === 'release-artifact').status, 'failed');
  } finally {
    await Promise.all([removeTemporaryDirectory(drift), removeTemporaryDirectory(missingEntry), removeTemporaryDirectory(missingManifest)]);
  }
});

test('release readiness verifies the release SHA and a clean checkout', async () => {
  const root = await makeFixture();
  try {
    await execFileAsync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['add', '.'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '-q', '-m', 'fixture'], { cwd: root, windowsHide: true });
    const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true })).stdout.trim();

    const clean = await collectReleaseReadiness({ expectedSha: head, requireClean: true, rootDir: root });
    assert.equal(clean.ok, true);
    assert.equal(clean.checks.find((check) => check.id === 'verified-sha').status, 'passed');
    assert.equal(clean.checks.find((check) => check.id === 'clean-checkout').status, 'passed');

    await writeFile(path.join(root, 'untracked.txt'), 'dirty\n', 'utf8');
    const dirty = await collectReleaseReadiness({ expectedSha: '0'.repeat(40), requireClean: true, rootDir: root });
    assert.equal(dirty.ok, false);
    assert.equal(dirty.checks.find((check) => check.id === 'verified-sha').status, 'failed');
    assert.equal(dirty.checks.find((check) => check.id === 'clean-checkout').status, 'failed');
  } finally {
    await removeTemporaryDirectory(root);
  }
});

test('release readiness arguments reject unknown flags', () => {
  assert.deepEqual(parseReleaseArgs(['--sha', 'abc', '--require-clean', '--tarball', 'x.tgz', '--receipt', 'out.json', '--json']), {
    expectedSha: 'abc', json: true, receipt: 'out.json', requireClean: true, tarball: 'x.tgz',
  });
});
