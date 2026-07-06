#!/usr/bin/env node
import { loadAllManifests } from './lib/manifest.js';

const manifests = await loadAllManifests(process.cwd());
console.log(JSON.stringify({
  package: '@jw/loopengine',
  profiles: manifests.profiles.items.map((item) => item.id),
  rules: manifests.rules.items.length,
  skills: manifests.skills.items.length,
  workflows: manifests.workflows.items.length,
}, null, 2));
