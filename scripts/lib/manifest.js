import { access, readFile } from 'node:fs/promises';

export async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

export async function loadAllManifests(rootDir) {
  return {
    profiles: await readJson(`${rootDir}/manifests/profiles.json`),
    rules: await readJson(`${rootDir}/manifests/rules.json`),
    skills: await readJson(`${rootDir}/manifests/skills.json`),
    workflows: await readJson(`${rootDir}/manifests/workflows.json`),
  };
}

export async function validateManifestSources(rootDir, manifests) {
  const missing = [];
  for (const manifest of Object.values(manifests)) {
    for (const item of manifest.items ?? []) {
      const candidates = [item.source, item.path, item.template].filter(Boolean);
      for (const candidate of candidates) {
        if (!(await pathExists(`${rootDir}/${candidate}`))) {
          missing.push(candidate);
        }
      }
    }
  }
  return missing.sort();
}
