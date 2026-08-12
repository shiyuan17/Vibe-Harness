#!/usr/bin/env node
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createReleaseEvidence } from './lib/release-evidence.js';
import { readJson, validateJsonAgainstSchema } from './lib/manifest.js';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(name + ' is required');
  return value;
}

let tarballPath = process.env.TARBALL_PATH;
if (!tarballPath && process.env.TARBALL_DIR) {
  const names = (await readdir(process.env.TARBALL_DIR)).filter((name) => name.endsWith('.tgz'));
  if (names.length !== 1) throw new Error('TARBALL_DIR must contain exactly one .tgz');
  tarballPath = path.join(process.env.TARBALL_DIR, names[0]);
}
if (!tarballPath) throw new Error('TARBALL_PATH or TARBALL_DIR is required');
const evidence = await createReleaseEvidence({
  releaseTag: required('RELEASE_TAG'),
  version: required('RELEASE_VERSION'),
  releaseSha: required('RELEASE_SHA'),
  verifiedSha: required('VERIFIED_SHA'),
  verificationId: required('VERIFICATION_ID'),
  verificationFinishedAt: required('VERIFICATION_FINISHED_AT'),
  verificationStable: required('VERIFICATION_STABLE') === 'true',
  checks: required('VERIFICATION_CHECKS').split(',').filter(Boolean),
  tarballPath,
  attestationStatus: required('ATTESTATION_STATUS'),
});
const evidencePath = process.env.RELEASE_EVIDENCE_PATH ?? 'release-evidence.json';
const schema = await readJson('schemas/release-evidence.schema.json');
const errors = validateJsonAgainstSchema(evidence, schema, 'release evidence');
if (errors.length > 0) throw new Error(errors.join('\n'));
await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
if (process.env.CHECKSUM_PATH) {
  await writeFile(process.env.CHECKSUM_PATH, evidence.tarball.sha256 + '  ' + evidence.tarball.name + '\n', 'utf8');
}
