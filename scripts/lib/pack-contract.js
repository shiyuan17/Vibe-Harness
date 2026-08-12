const requiredFiles = [
  'CHANGELOG.md',
  'LICENSE',
  'README.en.md',
  'README.md',
  'package.json',
  'scripts/vibe-harness.js',
];

const requiredPrefixes = [
  'adapters/',
  'manifests/',
  'rules/',
  'runtime/',
  'schemas/',
  'scripts/',
  'skills/',
  'templates/',
];

const forbiddenPrefixes = [
  '.agents/',
  '.codex/',
  '.github/',
  '.vibe-harness/',
  'docs/',
  'tests/',
];

const forbiddenFiles = new Set([
  '.npmrc',
  'vibe-harness.config.json',
]);

function isForbiddenPath(item) {
  const basename = item.split('/').at(-1);
  return forbiddenPrefixes.some((prefix) => item.startsWith(prefix))
    || forbiddenFiles.has(item)
    || basename === '.env'
    || basename?.startsWith('.env.')
    || item.includes('/node_modules/')
    || item.startsWith('node_modules/')
    || item.includes('better-harness');
}

export function validatePackageFiles(files) {
  const paths = files.map((item) => typeof item === 'string' ? item : item.path).filter(Boolean);
  const errors = [];
  for (const required of requiredFiles) {
    if (!paths.includes(required)) errors.push('package is missing required file: ' + required);
  }
  for (const prefix of requiredPrefixes) {
    if (!paths.some((item) => item.startsWith(prefix))) errors.push('package is missing required surface: ' + prefix);
  }
  for (const item of paths) {
    if (isForbiddenPath(item)) {
      errors.push('package contains forbidden path: ' + item);
    }
  }
  return { errors, files: paths.length, ok: errors.length === 0 };
}
