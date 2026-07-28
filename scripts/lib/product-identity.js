export const productIdentity = Object.freeze({
  agentRuntimeDir: '.agents/cognis',
  chineseName: '智序',
  command: 'cognis',
  configFile: 'cognis.config.json',
  managedMarker: 'COGNIS',
  name: 'Cognis',
  packageName: '@jw/cognis',
  stateDir: '.cognis',
});

export function readProductEnv(env, suffix) {
  const canonicalName = `COGNIS_${suffix}`;
  return { name: canonicalName, value: env[canonicalName] };
}
