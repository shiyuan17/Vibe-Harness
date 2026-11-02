// Mechanical artifact generator. The business source is ONLY read.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
if (!args.includes('--project') || !args.includes('--prepared') || !args.includes('--out') || !args.includes('--write')) {
  throw new Error('Use --project <read-only business root> --prepared <isolated patched copy> --out <patch outside business root> --write');
}
const project = path.resolve(value('--project')), prepared = path.resolve(value('--prepared')), output = path.resolve(value('--out'));
const relative = path.relative(project, output);
if (!relative.startsWith(`..${path.sep}`) && relative !== '..') throw new Error('Artifact must stay outside the business project');
const entries = [
  'frontend/scripts/validation-runner.mjs', 'frontend/scripts/vitest-changed.mjs',
  'frontend/scripts/validation-operational.mjs', 'frontend/scripts/validation-powershell.ps1',
  'frontend/scripts/validation-git-environment.mjs',
  'frontend/scripts/validation-scope-regression.test.mjs',
  'frontend/apps/web/src/views/facility/sensor-management.test.ts',
];
const normalize = (text) => text.replaceAll('\r\n', '\n');
const optional = async (file) => { try { return normalize(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const blob = (text) => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
function diff(file, before, after) {
  if (before === after) return '';
  const lines = (text) => text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  const oldLines = before === null ? [] : lines(before);
  const newLines = lines(after);
  return `diff --git a/${file} b/${file}\n${before === null ? 'new file mode 100644\n' : ''}index ${before === null ? '0'.repeat(40) : blob(before)}..${blob(after)}${before === null ? '' : ' 100644'}\n--- ${before === null ? '/dev/null' : `a/${file}`}\n+++ b/${file}\n@@ -${oldLines.length ? '1,' + oldLines.length : '0,0'} +1,${newLines.length} @@\n${oldLines.map((line) => `-${line}\n`).join('')}${newLines.map((line) => `+${line}\n`).join('')}`;
}
let artifact = '';
for (const file of entries) {
  const before = await optional(path.join(project, file));
  const after = await optional(path.join(prepared, file));
  if (after === null) throw new Error(`Missing prepared patch input: ${file}`);
  artifact += diff(file, before, after);
}
// Config is transformed in memory only: never write the blocked control-plane
// target, even in the fixture. The output is a reviewable migration PATCH.
const configFile = 'vibe-harness.config.json';
const before = await optional(path.join(project, configFile));
const config = JSON.parse(before);
const atoms = [['lint', true, 600000], ['typecheck', true, 900000], ['test', true, 1200000],
  ['contract-parity', true, 600000], ['backend-test', false, 3000000],
  ['operational-static', true, 600000], ['docs-static', true, 600000]];
const checks = atoms.map(([name, deterministic, timeoutMs]) => ({
  id: `changed-${name}`, command: `node frontend/scripts/validation-runner.mjs changed-atom ${name}`,
  deterministic, cacheScope: 'selection', timeoutMs, resources: [],
  ...(name === 'backend-test' ? { evidenceScope: 'transaction' } : {}),
}));
config.validationCommands.lint = null;
config.validationCommands.tiers.quick = checks.map((check) => check.command);
config.validationCommands.checks = [...checks, ...config.validationCommands.checks.filter((check) => check.id !== 'changed-scope')
  .map((check) => check.id === 'standard-slice' ? { ...check, resources: [] } : check)];
artifact += diff(configFile, before, `${JSON.stringify(config, null, 2)}\n`);
// Keep every declared full-suite Vitest entry out of shared node_modules too.
const packageFile = 'frontend/package.json';
const packageBefore = await optional(path.join(project, packageFile));
const packageJson = JSON.parse(packageBefore);
for (const name of ['test:unit', 'test:mock-server', 'test:cnas-prototype']) {
  const command = packageJson.scripts[name];
  if (!command) continue;
  packageJson.scripts[name] = command
    .replace(/vitest run(?! --configLoader)/u, 'vitest run --configLoader=runner --cache=false')
    .replace(/(vitest\/vitest\.mjs run)(?! --configLoader)/u, '$1 --configLoader=runner --cache=false');
}
artifact += diff(packageFile, packageBefore, `${JSON.stringify(packageJson, null, 2)}\n`);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, artifact, { flag: 'wx' });
console.log(JSON.stringify({ path: output, bytes: Buffer.byteLength(artifact), projectMutated: false }));
