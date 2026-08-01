export const productIdentity = Object.freeze({
  agentRuntimeDir: '.agents/runtime',
  chineseName: 'Vibe-Harness',
  command: 'vibe-harness',
  configFile: 'vibe-harness.config.json',
  managedMarker: 'VIBE_HARNESS',
  name: 'Vibe-Harness',
  packageName: '@jw/vibe-harness',
  stateDir: '.vibe-harness',
});

export function readProductEnv(env, suffix) {
  const canonicalName = `VIBE_HARNESS_${suffix}`;
  return { name: canonicalName, value: env[canonicalName] };
}
